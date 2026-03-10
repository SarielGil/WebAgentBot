import fs from 'fs';
import path from 'path';
import googleIt from 'google-it';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { githubService, domainService, searchService } from './index.js';
import { slackChannel } from './index.js';
import { queue } from './index.js';
import { RegisteredGroup } from './types.js';
import { sendPoolMessage } from './channels/telegram.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPhoto?: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  sendMediaGroup?: (
    jid: string,
    photos: Array<{ filePath: string; caption?: string }>,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;
const IPC_DUPLICATE_WINDOW_MS = 15_000;
const recentIpcMessages = new Map<string, number>();

function normalizeIpcMessageText(text: string): string {
  return text.trim();
}

export function shouldSuppressDuplicateIpcMessage(
  sourceGroup: string,
  chatJid: string,
  text: string,
  sender?: string,
  now = Date.now(),
): boolean {
  const normalizedText = normalizeIpcMessageText(text);
  if (!normalizedText) {
    return false;
  }

  for (const [key, timestamp] of recentIpcMessages.entries()) {
    if (now - timestamp > IPC_DUPLICATE_WINDOW_MS) {
      recentIpcMessages.delete(key);
    }
  }

  const dedupeKey = [sourceGroup, chatJid, sender || '', normalizedText].join('::');
  const previousTimestamp = recentIpcMessages.get(dedupeKey);
  recentIpcMessages.set(dedupeKey, now);

  return (
    previousTimestamp !== undefined &&
    now - previousTimestamp <= IPC_DUPLICATE_WINDOW_MS
  );
}

export function _resetRecentIpcMessagesForTests(): void {
  recentIpcMessages.clear();
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      // Collect photos per chatJid so we can send them as a media group (album)
      const pendingPhotos = new Map<string, Array<{ filePath: string; caption?: string; sourceGroup: string }>>();
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                if (
                  shouldSuppressDuplicateIpcMessage(
                    sourceGroup,
                    data.chatJid,
                    data.text,
                    data.sender,
                  )
                ) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'Suppressed duplicate IPC message',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }

                // Authorization: verify this group can send to this chatJid
                const targetGroup = Object.values(registeredGroups).find(
                  (g) => g.jid === data.chatJid,
                );
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Route swarm messages (with a sender identity) through the bot pool
                  const isTelegramJid =
                    /^-?\d+$/.test(data.chatJid) || /^c:-?\d+$/.test(data.chatJid);
                  if (data.sender && isTelegramJid) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                      (jid, text) => deps.sendMessage(jid, text),
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  queue.markIpcOutputSent(sourceGroup);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'photo' &&
                data.chatJid &&
                data.mediaFile
              ) {
                const targetGroup = Object.values(registeredGroups).find(
                  (g) => g.jid === data.chatJid,
                );
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (deps.sendPhoto) {
                    const hostMediaPath = path.join(
                      ipcBaseDir,
                      sourceGroup,
                      'media',
                      path.basename(data.mediaFile),
                    );
                    // Batch photos for album sending — collect now, send after loop
                    if (!pendingPhotos.has(data.chatJid)) {
                      pendingPhotos.set(data.chatJid, []);
                    }
                    pendingPhotos.get(data.chatJid)!.push({
                      filePath: hostMediaPath,
                      caption: data.caption || undefined,
                      sourceGroup,
                    });
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid },
                      'sendPhoto not supported by channel, dropping photo IPC',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC photo attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Send batched photos as media groups (albums)
      for (const [chatJid, photos] of pendingPhotos) {
        try {
          if (deps.sendMediaGroup && photos.length > 1) {
            await deps.sendMediaGroup(
              chatJid,
              photos.map((p) => ({ filePath: p.filePath, caption: p.caption })),
            );
          } else if (deps.sendPhoto) {
            for (const p of photos) {
              await deps.sendPhoto(chatJid, p.filePath, p.caption);
            }
          }
          // Mark IPC output sent for each source group that contributed photos
          const sourceGroups = new Set(photos.map((p) => p.sourceGroup));
          for (const sg of sourceGroups) {
            queue.markIpcOutputSent(sg);
          }
          logger.info(
            { chatJid, count: photos.length, album: photos.length > 1 },
            'IPC photos delivered',
          );
        } catch (err) {
          logger.error(
            { chatJid, count: photos.length, err },
            'Error sending batched IPC photos',
          );
        }
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For GitHub
    repoName?: string;
    repoDescription?: string;
    branch?: string;
    // For Slack
    reason?: string;
    // For Domain
    domain?: string;
    // For Search
    query?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = Object.values(registeredGroups).find(
          (g) => g.jid === targetJid,
        );

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.values(registeredGroups).map((g) => g.jid)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          jid: data.jid,
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'github_create_repo':
      if (data.repoName) {
        try {
          const url = await githubService.createRepo(
            data.repoName,
            data.repoDescription,
          );
          await deps.sendMessage(
            data.chatJid!,
            `✅ GitHub Repository created: ${url}`,
          );
        } catch (err) {
          logger.error({ err }, 'IPC github_create_repo failed');
          await deps.sendMessage(
            data.chatJid!,
            `❌ Failed to create GitHub repository: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'domain_check':
      if (data.domain) {
        const available = await domainService.isAvailable(data.domain);
        await deps.sendMessage(
          data.chatJid!,
          `🔎 Domain *${data.domain}* availability: ${available ? '✅ Available' : '❌ Taken'}`,
        );
      }
      break;

    case 'web_search':
      if (data.query) {
        try {
          const results = await searchService.search(data.query);
          const summary = results
            .map((r: any) => `[${r.title}](${r.link}): ${r.snippet}`)
            .join('\n\n');
          await deps.sendMessage(
            data.chatJid!,
            `🔍 Search results for "${data.query}":\n\n${summary}`,
          );
        } catch (err) {
          logger.error({ err }, 'IPC web_search failed');
          await deps.sendMessage(
            data.chatJid!,
            `❌ Failed to search: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'github_push':
      if (data.repoName && (data as any).files) {
        try {
          const { data: user } = await (
            githubService as any
          ).octokit.users.getAuthenticated();
          await githubService.pushFiles(
            user.login,
            data.repoName,
            (data as any).files,
            (data as any).message,
          );
          await deps.sendMessage(
            data.chatJid!,
            `✅ Files pushed to GitHub repository: ${data.repoName}`,
          );
        } catch (err) {
          logger.error({ err }, 'IPC github_push failed');
          await deps.sendMessage(
            data.chatJid!,
            `❌ Failed to push files: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'github_pages':
      if (data.repoName) {
        try {
          const { data: user } = await (
            githubService as any
          ).octokit.users.getAuthenticated();
          const branch: string = (data as any).branch || 'main';
          await githubService.enablePages(user.login, data.repoName, branch);
          await deps.sendMessage(
            data.chatJid!,
            `🚀 GitHub Pages enabled for *${data.repoName}* (branch: ${branch}). It will be live at https://${user.login}.github.io/${data.repoName}/ shortly!`,
          );
        } catch (err) {
          logger.error({ err }, 'IPC github_pages failed');
          await deps.sendMessage(
            data.chatJid!,
            `❌ Failed to enable GitHub Pages: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'slack_escalate':
      if (data.reason) {
        const group = Object.values(registeredGroups).find(
          (g) => g.jid === data.chatJid!,
        );
        const success = await slackChannel.sendEscalation(
          data.chatJid!,
          group?.name || 'Unknown User',
          data.reason,
        );
        if (success) {
          await deps.sendMessage(
            data.chatJid!,
            `🚨 Admin has been notified. They will get back to you soon.`,
          );
        } else {
          await deps.sendMessage(
            data.chatJid!,
            `⚠️ Failed to notify admin via Slack. Please try again later.`,
          );
        }
      }
      break;

    case 'telegram_escalate': {
      // Forward client escalation to the admin Telegram chat.
      // chatJid can be provided explicitly, or we auto-resolve from sourceGroup.
      const clientJid =
        data.chatJid ||
        Object.values(registeredGroups).find((g) => g.folder === sourceGroup)
          ?.jid;

      const adminGroup = Object.values(registeredGroups).find(
        (g) => g.folder === MAIN_GROUP_FOLDER,
      );
      if (!adminGroup) {
        logger.warn(
          { sourceGroup },
          'telegram_escalate: no admin group registered',
        );
        if (clientJid) {
          await deps.sendMessage(
            clientJid,
            '⚠️ Could not reach admin — no admin channel configured.',
          );
        }
        break;
      }
      const adminJid = adminGroup.jid;
      const clientGroup = clientJid
        ? Object.values(registeredGroups).find((g) => g.jid === clientJid)
        : undefined;
      const clientLabel =
        clientGroup?.name || clientJid || `group: ${sourceGroup}`;
      const escalationMsg =
        `🚨 <b>Client Escalation</b>\n\n` +
        `<b>From:</b> ${clientLabel}\n` +
        `<b>Chat ID:</b> <code>${clientJid}</code>\n` +
        `<b>Issue:</b> ${data.reason || 'Needs admin support'}\n\n` +
        `To reply, tell @Andy:\n` +
        `<i>Reply to client ${clientJid}: [your message here]</i>`;
      await deps.sendMessage(adminJid, escalationMsg);
      logger.info(
        { sourceGroup, adminJid, clientJid },
        'Telegram escalation forwarded to admin',
      );
      if (clientJid) {
        await deps.sendMessage(
          clientJid,
          "✅ Your request has been forwarded to our support team. You'll hear back shortly!",
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
