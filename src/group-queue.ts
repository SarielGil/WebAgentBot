import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  /**
   * True while the group is in a preparation phase (media analysis,
   * summarization) where piped IPC messages would be consumed by a
   * singleTurn container and silently lost.  sendMessage() returns
   * false when this flag is set, so new messages are queued for the
   * next full processing cycle instead.
   */
  preparing: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  /**
   * Per-group callbacks invoked whenever sendMessage successfully pipes
   * a message to the running container.  processGroupMessages uses this
   * to reset its idle timer so _close doesn't fire prematurely.
   */
  private messagePipedCallbacks = new Map<string, () => void>();
  /**
   * Per-group timestamp of the most recent successfully piped IPC message.
   * Used to avoid idle-timeout close races when a message arrives right as
   * the host is about to write the _close sentinel.
   */
  private lastMessagePipedAt = new Map<string, number>();
  /**
   * Per-group flag indicating that the IPC watcher delivered at least one
   * outbound message (send_message/send_photo) to the user on behalf of
   * this group's active container.  Used by processGroupMessages to avoid
   * rolling back the message cursor on container crash — the user already
   * received output.
   */
  private ipcOutputSent = new Map<string, boolean>();

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        preparing: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Register a callback that fires whenever sendMessage() successfully
   * pipes a message to the container for this group.  Used by
   * processGroupMessages to reset its idle timer.
   */
  setOnMessagePiped(groupJid: string, callback: () => void): void {
    this.messagePipedCallbacks.set(groupJid, callback);
  }

  /**
   * Remove the onMessagePiped callback for a group.
   */
  clearOnMessagePiped(groupJid: string): void {
    this.messagePipedCallbacks.delete(groupJid);
  }

  /**
   * Signal that the main (multi-turn) agent container is about to start.
   * Clears the preparing flag so that sendMessage() will accept piped messages.
   */
  markReady(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.preparing = false;
  }

  /**
   * Record that the IPC watcher delivered outbound content to the user
   * on behalf of this group's active container.
   */
  markIpcOutputSent(groupJid: string): void {
    this.ipcOutputSent.set(groupJid, true);
  }

  /**
   * Check whether the IPC watcher delivered any outbound content to the
   * user during the current container run for this group.
   */
  hasIpcOutputSent(groupJid: string): boolean {
    return this.ipcOutputSent.get(groupJid) ?? false;
  }

  /**
   * Clear the IPC output tracking flag for a group (called when the
   * container run completes).
   */
  clearIpcOutputSent(groupJid: string): void {
    this.ipcOutputSent.delete(groupJid);
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container
   * or if the group is still in a preparation phase (media analysis /
   * summarization) where piped messages would be lost.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (
      !state.active ||
      !state.groupFolder ||
      state.isTaskContainer ||
      state.preparing
    )
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      this.lastMessagePipedAt.set(groupJid, Date.now());
      // Notify the host so it can reset its idle timer — piped messages
      // mean the agent is about to do work and _close should be deferred.
      this.messagePipedCallbacks.get(groupJid)?.();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Media preemption: when new photos arrive during an active long-running turn,
   * request an immediate restart so the next run includes fresh media context.
   * Returns true when a preemption signal was issued.
   */
  preemptForMedia(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active) return false;

    state.pendingMessages = true;
    this.closeStdin(groupJid);

    if (state.process && !state.process.killed) {
      try {
        state.process.kill('SIGTERM');
      } catch {
        // best effort
      }
    }

    logger.info({ groupJid }, 'Preempt requested for active run due to new media');
    return true;
  }

  /**
   * Close stdin only if the container is still idle and no message was piped
   * recently. Returns true when _close was written.
   */
  closeStdinIfIdle(groupJid: string, recentWindowMs = 2500): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.idleWaiting || !state.groupFolder) {
      return false;
    }
    const lastPipedAt = this.lastMessagePipedAt.get(groupJid) ?? 0;
    if (Date.now() - lastPipedAt < recentWindowMs) {
      return false;
    }
    this.closeStdin(groupJid);
    return true;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.preparing = true;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      // Check for orphaned IPC input files — messages that were piped
      // but never consumed by the container. If found, force a
      // reprocessing cycle so they aren't silently lost.
      // NOTE: we intentionally DO NOT delete these files here; they are
      // durable recovery artifacts and must survive orchestrator restarts.
      if (state.groupFolder) {
        const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
        try {
          const orphans = fs
            .readdirSync(inputDir)
            .filter((f) => f.endsWith('.json'));
          if (orphans.length > 0) {
            state.pendingMessages = true;
            logger.warn(
              { groupJid, orphanedCount: orphans.length },
              'Found orphaned IPC input files after container exit, scheduling reprocessing',
            );
          }
        } catch {
          /* input dir may not exist */
        }
      }
      this.messagePipedCallbacks.delete(groupJid);
      this.lastMessagePipedAt.delete(groupJid);
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
