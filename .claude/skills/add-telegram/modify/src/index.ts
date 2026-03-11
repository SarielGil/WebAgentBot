import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  BATCH_DELAY,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MEDIA_DIR,
  POLL_INTERVAL,
<<<<<<< /home/runner/work/WebAgentBot/WebAgentBot/.claude/skills/add-telegram/modify/src/index.ts
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TRIGGER_PATTERN,
} from './config.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
=======
  TELEGRAM_BOT_POOL,
  TRIGGER_PATTERN,
} from './config.js';
import { TelegramChannel, initBotPool } from './channels/telegram.js';
>>>>>>> /home/runner/work/WebAgentBot/WebAgentBot/src/index.ts
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  deleteSession,
  getSessionScopeKey,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateMessageMediaMetadata,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { GitHubService } from './services/github.js';
import { SlackChannel } from './channels/slack.js';
import { DomainService } from './services/domain.js';
import { SearchService } from './services/search.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, { sessionId: string; summary?: string }> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
export const batchTimers = new Map<string, NodeJS.Timeout>();
const batchPendingMessages = new Map<string, NewMessage[]>();
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

let telegram: TelegramChannel;
export let githubService: GitHubService;
export let slackChannel: SlackChannel;
export let domainService: DomainService;
export let searchService: SearchService;
export const channels: Channel[] = [];
export const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    // Migrate: old format was keyed by JID (e.g. '774133756'), new format is
    // keyed by folder (e.g. 'main'). Detect and reset to avoid stale cursors.
    const hasJidKeys = Object.keys(lastAgentTimestamp).some(
      (k) => k.includes('@') || k.includes(':') || /^-?\d+$/.test(k),
    );
    if (hasJidKeys) {
      logger.info(
        'Migrating lastAgentTimestamp from JID-keyed to folder-keyed format',
      );
      lastAgentTimestamp = {};
    }
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function recoverPipedInputs(): void {
  for (const [folder, group] of Object.entries(registeredGroups)) {
    const inputDir = path.join(DATA_DIR, 'ipc', folder, 'input');
    try {
      const pending = fs
        .readdirSync(inputDir)
        .filter((f) => f.endsWith('.json')).length;
      if (pending > 0) {
        logger.warn(
          { group: group.name, folder, pending },
          'Recovered pending piped IPC input files',
        );
        queue.enqueueMessageCheck(folder);
      }
    } catch {
      // input dir may not exist yet
    }
  }
}

function pruneOldGroupMedia(groupFolder: string): void {
  const dir = path.join(MEDIA_DIR, groupFolder);
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  try {
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > MEDIA_RETENTION_MS) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore best-effort cleanup
        }
      }
    }
  } catch {
    // best-effort cleanup only
  }
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[group.folder] = { ...group, jid };
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  // registeredGroups is now keyed by folder; collect all registered JIDs from values
  const registeredJids = new Set(
    Object.values(registeredGroups).map((g) => g.jid),
  );

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function mergeBatchMessages(
  existing: NewMessage[],
  incoming: NewMessage[],
): NewMessage[] {
  const merged = new Map<string, NewMessage>();
  for (const msg of [...existing, ...incoming]) {
    merged.set(msg.id, msg);
  }
  return [...merged.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

function buildRecentContinuationContext(
  chatJid: string,
  beforeTimestamp: string,
): string {
  const all = getMessagesSince(chatJid, '', ASSISTANT_NAME);
  const prior = all
    .filter((m) => m.timestamp < beforeTimestamp)
    .filter((m) => (m.content || '').trim().length > 0)
    .slice(-12);
  if (prior.length === 0) return '';
  return formatMessages(prior);
}

/** Build a per-group trigger regex from its stored trigger string (e.g. "@Pixel") */
function makeGroupTriggerPattern(trigger: string): RegExp {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\b`, 'i');
}

function shouldRefreshSummary(
  missedMessages: NewMessage[],
  hasExistingSummary: boolean,
): boolean {
  // Only summarize on first encounter or when there are many new messages.
  // Avoids spinning up an extra container (and adding 10-15s) on every single turn.
  if (!hasExistingSummary) return false; // skip initial summary — wait until there's real history
  if (missedMessages.length >= 10) return true;
  return false;
}

async function refreshConversationSummary(
  group: RegisteredGroup,
  chatJid: string,
  isMain: boolean,
  queueKey: string,
  session: { sessionId: string; summary?: string },
  recentMessages: NewMessage[],
): Promise<void> {
  const existingSummary = session.summary?.trim() || '(none)';
  const recentHistory = formatMessages(recentMessages.slice(-25));
  const summarizationOutput = await runContainerAgent(
    group,
    {
      prompt: `Update durable memory for this client chat.

Return only a concise summary block that preserves stable decisions and preferences.
Keep what is still valid, update what changed, and remove contradictions.

Focus on:
- project names and active repo/slug names
- visual/design preferences (liked/disliked)
- content requests (sections to add/remove)
- media usage expectations
- constraints and must-follow workflow choices

Existing memory:
${existingSummary}

Recent messages:
${recentHistory}`,
      sessionId: session.sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      singleTurn: true,
      assistantName: ASSISTANT_NAME,
    },
    (proc, containerName) =>
      queue.registerProcess(queueKey, proc, containerName, group.folder),
  );

  if (summarizationOutput.status !== 'success' || !summarizationOutput.result) {
    logger.warn(
      { group: group.name },
      'Memory summary refresh failed; keeping previous summary',
    );
    return;
  }

  const summary = stripInternalTags(summarizationOutput.result);
  if (!summary) return;

  session.summary = summary;
  setSession(group.folder, session.sessionId, summary, chatJid);
  logger.info({ group: group.name }, 'Memory summary refreshed');
}

/**
 * Process all pending messages for a group.
 * queueKey is the group folder (unique per bot, even when multiple bots share a JID).
 */
async function processGroupMessages(queueKey: string): Promise<boolean> {
  const group = registeredGroups[queueKey];
  if (!group) return true;

  const chatJid = group.jid; // real Telegram/WhatsApp chat ID

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const sessionKey = getSessionScopeKey(group.folder, chatJid);

  const sinceTimestamp = lastAgentTimestamp[queueKey] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // ── /clear command ──────────────────────────────────────────────────────────
  // Check if ANY of the pending messages is a /clear command.
  const clearMsg = missedMessages.find(
    (m) => m.content.trim().toLowerCase() === '/clear',
  );
  if (clearMsg) {
    logger.info(
      { group: group.name },
      '/clear command received — wiping session & media',
    );

    // Stop any active container for this group so we can safely delete its files
    queue.closeStdin(queueKey);

    // 1. Delete DB session record
    deleteSession(group.folder, chatJid);
    // 2. Clear in-memory session
    delete sessions[sessionKey];
    delete sessions[group.folder];
    // 3. Reset message cursor
    lastAgentTimestamp[queueKey] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();

    // 4. Delete Claude transcript JSONL files for this group so the next
    //    run starts without any prior session context.
    const claudeProjectsDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
    );
    let transcriptsDeleted = 0;
    if (fs.existsSync(claudeProjectsDir)) {
      for (const sub of fs.readdirSync(claudeProjectsDir)) {
        const subPath = path.join(claudeProjectsDir, sub);
        if (fs.statSync(subPath).isDirectory()) {
          for (const file of fs.readdirSync(subPath)) {
            if (file.endsWith('.jsonl')) {
              fs.unlinkSync(path.join(subPath, file));
              transcriptsDeleted++;
            }
          }
        } else if (sub.endsWith('.jsonl')) {
          fs.unlinkSync(subPath);
          transcriptsDeleted++;
        }
      }
    }

    // 5. Delete this group's media directory (post-move files) and any flat orphans
    //    that were downloaded but not yet moved (e.g. arrived while /clear was being handled).
    let mediaDeleted = 0;
    const groupMediaDirForClear = path.join(MEDIA_DIR, group.folder);
    if (fs.existsSync(groupMediaDirForClear)) {
      try {
        const files = fs.readdirSync(groupMediaDirForClear);
        mediaDeleted += files.length;
        fs.rmSync(groupMediaDirForClear, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    // Also remove orphaned flat files (downloaded but not yet moved to group subdir)
    if (fs.existsSync(MEDIA_DIR)) {
      for (const entry of fs.readdirSync(MEDIA_DIR)) {
        const entryPath = path.join(MEDIA_DIR, entry);
        if (fs.statSync(entryPath).isFile()) {
          try {
            fs.unlinkSync(entryPath);
            mediaDeleted++;
          } catch {
            /* ignore */
          }
        }
      }
    }

    logger.info(
      { group: group.name, transcriptsDeleted, mediaDeleted },
      '/clear complete',
    );

    await channel.sendMessage(
      chatJid,
      `✅ נוקה! זיכרון השיחה ו-${mediaDeleted} קבצי מדיה נמחקו. מתחיל מחדש 🧹`,
    );
    return true;
  }
  // ────────────────────────────────────────────────────────────────────────────

  // For non-main groups, check if this group's trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const groupTriggerPattern = makeGroupTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some((m) =>
      groupTriggerPattern.test((m.content || '').trim()),
    );
    if (!hasTrigger) return true;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const turnStartedAt = Date.now();
  const prepStartedAt = Date.now();

  // 0. Move any freshly-downloaded media files into this group's isolated subdirectory.
  //    The Telegram bot downloads to the flat data/media/ dir; we relocate them here
  //    so the container only sees this group's files, not every other group's uploads.
  const groupMediaDir = path.join(MEDIA_DIR, group.folder);
  for (const msg of missedMessages) {
    if (msg.media_path && fs.existsSync(msg.media_path)) {
      const dest = path.join(groupMediaDir, path.basename(msg.media_path));
      if (msg.media_path !== dest) {
        fs.mkdirSync(groupMediaDir, { recursive: true });
        fs.renameSync(msg.media_path, dest);
        msg.media_path = dest;
      }
    }
  }
  const mediaPrepMs = Date.now() - prepStartedAt;

  // 1. Handle Media Analysis Turns
  for (const msg of missedMessages) {
    if (msg.media_path && !msg.media_metadata) {
      logger.info(
        { group: group.name, msgId: msg.id },
        'Triggering media analysis turn',
      );
      // We run a special one-off container turn just for analysis
      const analysisOutput = await runContainerAgent(
        group,
        {
          prompt: `Analyze this uploaded media for website use.

Return only a concise metadata summary that includes:
- filename
- media type (photo/video/document)
- orientation or aspect ratio
- primary subject
- best website section (hero, about, gallery, services, testimonial, background, other)
- recommended rendering (cover or contain)
- recommended CSS object-position
- any important crop caution (for example: keep faces visible, avoid cropping instrument, good for text overlay)

Be concrete and compact.`,
          groupFolder: group.folder,
          chatJid,
          isMain,
          singleTurn: true,
          mediaPath: msg.media_path,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          queue.registerProcess(queueKey, proc, containerName, group.folder),
      );

      if (analysisOutput.status === 'success' && analysisOutput.result) {
        const metadata = stripInternalTags(analysisOutput.result);
        updateMessageMediaMetadata(chatJid, msg.id, metadata);
        msg.media_metadata = metadata; // Update in-memory for the current context
        logger.info(
          { group: group.name, msgId: msg.id },
          'Media analysis complete',
        );
      }
    }
  }

  // 2. Context Compression (Summarization)
  const session = sessions[sessionKey] ||
    sessions[group.folder] || { sessionId: '' };

  // Refresh durable memory frequently so user preferences are carried across turns.
  const summaryStartedAt = Date.now();
  if (shouldRefreshSummary(missedMessages, !!session.summary)) {
    await refreshConversationSummary(
      group,
      chatJid,
      isMain,
      queueKey,
      session,
      missedMessages,
    );
  }
  const summaryMs = Date.now() - summaryStartedAt;

  // 3. Final Prompt Construction
  const slidingWindow = missedMessages.slice(-25);
  let contextPrompt = '';
  const mediaOnlyFollowUp =
    slidingWindow.some((m) => !!m.media_path) &&
    slidingWindow.every((m) => !(m.content || '').trim());

  if (session.summary) {
    contextPrompt += `<conversation_summary>\n${session.summary}\n</conversation_summary>\n\n`;
  }
  if (mediaOnlyFollowUp) {
    contextPrompt +=
      '<continuation_hint>\n' +
      'The user sent media-only follow-up message(s). This CONTINUES the current project/request.\n' +
      'Do not restart discovery or open a new flow. Use the uploaded media as additional assets for the existing task.\n' +
      '</continuation_hint>\n\n';

    // If summary memory is not available yet, inject recent text history so
    // media-only turns still inherit the original request instead of starting over.
    if (!session.summary && slidingWindow[0]?.timestamp) {
      const recentContext = buildRecentContinuationContext(
        chatJid,
        slidingWindow[0].timestamp,
      );
      if (recentContext) {
        contextPrompt += `<recent_project_context>\n${recentContext}\n</recent_project_context>\n\n`;
      }
    }
  }
  const finalPrompt = contextPrompt + formatMessages(slidingWindow);

  // Collect media paths from the current batch so the agent can see uploaded images.
  // Only pass the most recent image — Gemini multimodal input accepts one image at a time.
  const mediaMessages = slidingWindow.filter(
    (m) => m.media_path && fs.existsSync(m.media_path),
  );
  const latestMediaPath =
    mediaMessages.length > 0
      ? mediaMessages[mediaMessages.length - 1].media_path
      : undefined;

  // Always expose currently available uploaded media assets to the model so
  // generated samples use real client photos rather than placeholders.
  const availableMediaPaths = fs.existsSync(groupMediaDir)
    ? fs
        .readdirSync(groupMediaDir)
        .filter((f) => /\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(f))
        .map((f) => `/workspace/media/${f}`)
        .slice(-20)
    : [];
  if (availableMediaPaths.length > 0) {
    contextPrompt +=
      '<available_media_assets>\n' +
      'Client-uploaded assets currently available in this run:\n' +
      `${availableMediaPaths.map((p) => `- ${p}`).join('\n')}\n` +
      '\n' +
      'When generating website samples/options, USE these assets in hero/gallery/sections.\n' +
      'Do not use placeholder stock images when real uploaded assets exist.\n' +
      '</available_media_assets>\n\n';
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[queueKey] || '';
  lastAgentTimestamp[queueKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      mediaPrepMs,
      summaryMs,
      prepTotalMs: Date.now() - prepStartedAt,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle.
  // The timer is ONLY started after the agent emits an output marker (meaning
  // it finished work and is waiting for the next message). When a user message
  // is piped, we CANCEL the timer — the agent is about to do work and may take
  // minutes for heavy builds (parallel_generate + git push + Pages verification).
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const closed = queue.closeStdinIfIdle(queueKey);
      logger.debug(
        { group: group.name, closed },
        closed
          ? 'Idle timeout, closing container stdin'
          : 'Idle timeout skipped close due to recent input/active work',
      );
    }, IDLE_TIMEOUT);
  };

  const cancelIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Preparation phase complete (media analysis + summarization done).
  // Mark the queue slot as ready so that piped IPC messages reach the
  // main agent container instead of being consumed by singleTurn sub-containers.
  queue.markReady(queueKey);

  // Register callback so that piping a message via sendMessage() CANCELS
  // the idle timer — the agent is about to receive heavy work and shouldn't
  // be killed mid-task. The idle timer will restart when the agent emits its
  // next output marker.
  queue.setOnMessagePiped(queueKey, cancelIdleTimer);

  const onAgentOutput = async (result: ContainerOutput) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      // Skip bare "Done"/"done" outputs — agent uses these as task-completion
      // signals but they look broken when sent to the user as a raw message.
      const isDoneSignal = /^done\.?$/i.test(text);
      if (text && !isDoneSignal) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      } else if (raw.trim()) {
        // Agent had output but it was entirely internal — log so this is traceable
        logger.warn(
          { group: group.name },
          'Agent result was non-empty but entirely stripped (all <internal> tags) — no message sent to user',
        );
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(queueKey);
      // Start/reset idle timer even for null results (IPC-only output).
      // Without this, containers that send all messages via IPC (send_message/
      // send_photo tools) never get an idle timer started, so _close is never
      // written and the container hangs until the hard timeout kills it.
      if (!result.result) {
        resetIdleTimer();
      }
    }

    if (result.status === 'error') {
      hadError = true;
    }
  };

  const agentStartedAt = Date.now();
  const runResult = await runAgent(
    group,
    finalPrompt,
    chatJid,
    onAgentOutput,
    latestMediaPath,
  );

  await channel.setTyping?.(chatJid, false);
  cancelIdleTimer();
  queue.clearOnMessagePiped(queueKey);
  logger.info(
    {
      group: group.name,
      totalTurnMs: Date.now() - turnStartedAt,
      prepMs: agentStartedAt - prepStartedAt,
      agentMs: Date.now() - agentStartedAt,
    },
    'Message processing turn finished',
  );

  // Keep group media for a retention window so retries and follow-up turns
  // can still use uploaded photos. Only prune stale files.
  pruneOldGroupMedia(group.folder);

  // Check if IPC watcher delivered messages/photos to the user on behalf
  // of this container (agent used send_message/send_photo tools).
  const ipcSentOutput = queue.hasIpcOutputSent(queueKey);
  queue.clearIpcOutputSent(queueKey);

  if (runResult.status === 'error' || hadError) {
    const retriableCrash =
      runResult.status === 'error' &&
      /code 137|timed out|stalled/i.test(runResult.error || '');
    if (retriableCrash) {
      // Crash/timeouts are retriable. Roll back so the latest turn is replayed.
      lastAgentTimestamp[queueKey] = previousCursor;
      saveState();
      logger.error(
        { group: group.name, error: runResult.error, hadError },
        'Retriable container failure, rolled back cursor for automatic replay',
      );
      await slackChannel
        .sendEscalation(
          chatJid,
          'system',
          `Retriable container failure for ${group.name}: ${runResult.error || 'unknown error'}`,
        )
        .catch(() => false);
      return false;
    }

    // If we already sent output to the user (via streaming OR IPC),
    // don't roll back the cursor — re-processing would send duplicates.
    if (outputSentToUser || ipcSentOutput) {
      logger.warn(
        {
          group: group.name,
          viaStreaming: outputSentToUser,
          viaIpc: ipcSentOutput,
        },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[queueKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  mediaPath?: string,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const session = sessions[group.folder];
  const sessionKey = getSessionScopeKey(group.folder, chatJid);
  const scopedSession = sessions[sessionKey] || sessions[group.folder];
  const sessionId = scopedSession?.sessionId;
  const summary = scopedSession?.summary;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.values(registeredGroups).map((g) => g.jid)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (!sessions[sessionKey])
            sessions[sessionKey] = { sessionId: output.newSessionId };
          sessions[sessionKey].sessionId = output.newSessionId;
          if (scopedSession?.summary) {
            sessions[sessionKey].summary = scopedSession.summary;
          }
          setSession(
            group.folder,
            output.newSessionId,
            scopedSession?.summary,
            chatJid,
          );
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        mediaPath,
      },
      (proc, containerName) =>
        queue.registerProcess(group.folder, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (!sessions[sessionKey])
        sessions[sessionKey] = { sessionId: output.newSessionId };
      sessions[sessionKey].sessionId = output.newSessionId;
      if (scopedSession?.summary) {
        sessions[sessionKey].summary = scopedSession.summary;
      }
      setSession(
        group.folder,
        output.newSessionId,
        scopedSession?.summary,
        chatJid,
      );
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return {
        status: 'error',
        error: String(output.error || 'Container agent error'),
      };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      // Recover piped IPC inputs that may remain after restarts/crashes.
      recoverPipedInputs();

      const jids = [
        ...new Set(Object.values(registeredGroups).map((g) => g.jid)),
      ];
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        await routeNewMessages(messages);
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/** @internal - exported for testing */
export async function routeNewMessages(
  newMessages: NewMessage[],
): Promise<void> {
  const byChat: Record<string, NewMessage[]> = {};
  for (const msg of newMessages) {
    if (!byChat[msg.chat_jid]) byChat[msg.chat_jid] = [];
    byChat[msg.chat_jid].push(msg);
  }

  for (const [chatJid, groupMessages] of Object.entries(byChat)) {
    // Find all groups registered to this JID (may be more than one, e.g. @Andy + @Pixel)
    const groupsForJid = Object.values(registeredGroups).filter(
      (g) => g.jid === chatJid,
    );
    if (groupsForJid.length === 0) continue;

    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'routeNewMessages: no channel owns JID');
      continue;
    }

    for (const group of groupsForJid) {
      const queueKey = group.folder; // unique per bot
      const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
      const existingTimer = batchTimers.get(queueKey);
      const pendingMessages = mergeBatchMessages(
        batchPendingMessages.get(queueKey) || [],
        groupMessages,
      );

      if (needsTrigger) {
        const groupTriggerPattern = makeGroupTriggerPattern(group.trigger);
        const hasTrigger = pendingMessages.some((m) =>
          groupTriggerPattern.test((m.content || '').trim()),
        );
        // Once a batch window is open for this group, keep extending it with
        // follow-up messages from the same chat even if they no longer repeat
        // the trigger. Otherwise the timer fires too early and fragments the
        // user turn across multiple runs.
        if (!hasTrigger && !existingTimer) continue;
      }

      // Reset batch timer for this specific group
      if (existingTimer) {
        global.clearTimeout(existingTimer);
        batchTimers.delete(queueKey);
      }

      batchPendingMessages.set(queueKey, pendingMessages);

      const timer = globalThis.setTimeout(async () => {
        batchTimers.delete(queueKey);
        const bufferedMessages = batchPendingMessages.get(queueKey) || [];
        batchPendingMessages.delete(queueKey);

        // Pull all messages since lastAgentTimestamp for this group so non-trigger
        // context that accumulated between triggers is included.
        const allPending = getMessagesSince(
          chatJid,
          lastAgentTimestamp[queueKey] || '',
          ASSISTANT_NAME,
        );
        const messagesToSend =
          allPending.length > 0 ? allPending : bufferedMessages;
        const formatted = formatMessages(messagesToSend);
        const hasMediaInBatch = messagesToSend.some((m) => !!m.media_path);

        // Never pipe media-bearing turns into an active container via text IPC.
        // Piping drops binary media context and can cause "missing photos" in
        // generation/deploy flows. Force a normal queued run so runAgent gets
        // mediaPath and /workspace/media mount semantics.
        if (hasMediaInBatch) {
          const preempted = queue.preemptForMedia(queueKey);
          logger.info(
            { chatJid, queueKey, count: messagesToSend.length, preempted },
            preempted
              ? 'Detected media in pending batch, preempting active run for media-aware restart'
              : 'Detected media in pending batch, scheduling full run (no IPC piping)',
          );
          if (!preempted) {
            queue.enqueueMessageCheck(queueKey);
          }
          return;
        }

        if (queue.sendMessage(queueKey, formatted)) {
          logger.debug(
            { chatJid, queueKey, count: messagesToSend.length },
            'Piped messages to active container',
          );
          // Advance cursor past the piped messages so they are not
          // re-discovered by processGroupMessages when the container
          // finishes.  If the container crashes before consuming the
          // IPC file, the orphaned-IPC cleanup in group-queue will
          // trigger a reprocessing cycle (but those messages will be
          // gone from the cursor window — an acceptable tradeoff vs.
          // sending visible duplicates to the user every time).
          if (messagesToSend.length > 0) {
            const lastPiped = messagesToSend[messagesToSend.length - 1];
            const ts =
              'timestamp' in lastPiped
                ? (lastPiped as { timestamp: string }).timestamp
                : '';
            if (
              ts &&
              (!lastAgentTimestamp[queueKey] ||
                ts > lastAgentTimestamp[queueKey])
            ) {
              lastAgentTimestamp[queueKey] = ts;
              saveState();
            }
          }
          // Show typing indicator while the container processes the piped message
          channel
            .setTyping?.(chatJid, true)
            ?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
        } else {
          // No active container — enqueue for a new one
          queue.enqueueMessageCheck(queueKey);
        }
      }, BATCH_DELAY);

      batchTimers.set(queueKey, timer);
    }
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  let stateChanged = false;
  // registeredGroups is folder-keyed; each group carries its own .jid
  for (const [folder, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[folder] || '';
    const pending = getMessagesSince(group.jid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      if (!sinceTimestamp) {
        lastAgentTimestamp[folder] = pending[pending.length - 1].timestamp;
        stateChanged = true;
        logger.info(
          { group: group.name, skippedCount: pending.length },
          'Recovery: initialized cursor to latest stored message to avoid replaying historical backlog',
        );
        continue;
      }
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(folder);
    }
  }

  if (stateChanged) {
    saveState();
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  githubService = new GitHubService();
  slackChannel = new SlackChannel();
  domainService = new DomainService();
  searchService = new SearchService();
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      // Auto-register new Telegram chats (unknown numeric IDs) as client1
      // Also handles client-bot namespaced JIDs like 'c:<chatId>'
      if (
        !Object.values(registeredGroups).some((g) => g.jid === _chatJid) &&
        /^(c:)?-?\d+$/.test(_chatJid)
      ) {
        logger.info(
          { chatJid: _chatJid },
          'Auto-registering new Telegram chat as client',
        );
        const newGroup: RegisteredGroup = {
          name: `Client ${_chatJid}`,
          folder: 'client1',
          jid: _chatJid,
          trigger: '@Support',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        setRegisteredGroup(_chatJid, newGroup);
        registeredGroups['client1'] = newGroup;
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
<<<<<<< /home/runner/work/WebAgentBot/WebAgentBot/.claude/skills/add-telegram/modify/src/index.ts
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    await telegram.connect();
  }

  if (!TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
=======
  telegram = new TelegramChannel(channelOpts);
  channels.push(telegram);
  await telegram.connect();

  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
>>>>>>> /home/runner/work/WebAgentBot/WebAgentBot/src/index.ts
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendPhoto: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendPhoto) return Promise.resolve(); // channel doesn't support photos
      return channel.sendPhoto(jid, filePath, caption);
    },
    sendMediaGroup: (jid, photos) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendMediaGroup) {
        // Fall back to individual photos
        return photos.reduce(
          (p, photo) =>
            p.then(
              () =>
                channel.sendPhoto?.(jid, photo.filePath, photo.caption) ??
                Promise.resolve(),
            ),
          Promise.resolve(),
        );
      }
      return channel.sendMediaGroup(jid, photos);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
