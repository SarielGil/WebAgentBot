/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  singleTurn?: boolean;     // one-shot containers (media analysis, summarization) — skip conversation loop
  assistantName?: string;
  secrets?: Record<string, string>;
  mediaPath?: string;       // host-side path; container sees file at /workspace/media/<basename>
  mediaMetadata?: string;   // pre-computed description (if already analysed)
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands it runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'XAI_API_KEY'];

// Tool credentials that ARE safe to expose to Bash subprocesses (gh, curl, etc.)
const TOOL_CREDENTIAL_VARS = ['GITHUB_TOKEN', 'BRAVE_API_KEY'];

// Bash patterns that grant access to repos outside the client's own scope.
// These are blocked to prevent the agent from browsing or accessing other projects.
const BLOCKED_GH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /gh\s+repo\s+list/,          reason: 'Listing all repos is outside client scope' },
  { pattern: /gh\s+repo\s+fork/,           reason: 'Forking external repos is not allowed' },
  { pattern: /gh\s+browse/,               reason: 'Browsing GitHub UI is not allowed in agent scope' },
  { pattern: /gh\s+search\s+repos/,       reason: 'Searching all GitHub repos is outside client scope' },
  { pattern: /gh\s+api\s+\/users\//,      reason: 'Accessing other users data is outside client scope' },
  { pattern: /gh\s+api\s+\/orgs\//,       reason: 'Accessing org data outside client scope' },
];

// Destructive shell commands that can wipe or destabilize website project folders.
const BLOCKED_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[^\n]*r[^\n]*f[^\n]*\s+(\.|\/workspace\/group|\/workspace\/group\/\*|\*)\b/, reason: 'Refusing destructive recursive delete in workspace' },
  { pattern: /\bgit\s+clean\s+-[^\n]*f[^\n]*d[^\n]*x\b/, reason: 'Refusing git clean -fdx in workspace' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Refusing git reset --hard in workspace' },
  { pattern: /\bgit\s+rm\b[^\n]*\bindex\.html\b/, reason: 'Refusing to remove index.html' },
  { pattern: /\brm\b[^\n]*\bindex\.html\b/, reason: 'Refusing to delete index.html' },
  { pattern: /\bfind\b[^\n]*\/workspace\/group[^\n]*-delete\b/, reason: 'Refusing find -delete in workspace' },
];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    // Block commands that access GitHub outside the client's own scope
    for (const { pattern, reason } of BLOCKED_GH_PATTERNS) {
      if (pattern.test(command)) {
        log(`[scope-guard] Blocked command matching ${pattern}: ${reason}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: {
              ...(preInput.tool_input as Record<string, unknown>),
              // Replace with a harmless echo that explains the block
              command: `echo '[SCOPE GUARD] Command blocked: ${reason}. You may only access repos created for this client in this project.' && exit 1`,
            },
          },
        };
      }
    }

    // Block known destructive commands in /workspace/group.
    for (const { pattern, reason } of BLOCKED_DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        log(`[safety-guard] Blocked command matching ${pattern}: ${reason}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: {
              ...(preInput.tool_input as Record<string, unknown>),
              command: `echo '[SAFETY GUARD] Command blocked: ${reason}. Use non-destructive edits and keep project files intact.' && exit 1`,
            },
          },
        };
      }
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  singleTurn = false,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query.
  // singleTurn containers skip IPC polling — they must not consume messages
  // intended for the main agent container.
  let ipcPolling = !singleTurn;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Determine backend: prefer Gemini > Grok > Claude
  const secrets = containerInput.secrets as Record<string, string> | undefined;
  const hasAnthropicKey = !!(secrets?.ANTHROPIC_API_KEY || secrets?.CLAUDE_CODE_OAUTH_TOKEN);
  const hasGeminiKey = !!secrets?.GEMINI_API_KEY;
  const hasXaiKey = !!secrets?.XAI_API_KEY;

  const buildPrompt = (p: string) => containerInput.isScheduledTask
    ? `[SCHEDULED TASK]\n\n${p}`
    : p;

  if (hasGeminiKey) {
    log('Gemini key found, using Gemini as default backend');
    await runGeminiFallback(containerInput, buildPrompt(containerInput.prompt));
    return;
  }

  if (hasXaiKey) {
    log('XAI_API_KEY found, using Grok as fallback backend');
    await runGrokBackend(containerInput, buildPrompt(containerInput.prompt));
    return;
  }

  // Single-turn containers (media analysis, summarization) exit immediately after one result.
  // They must not enter the IPC wait loop or they deadlock the queue.
  const isSingleTurn = !!containerInput.singleTurn;

  if (!hasAnthropicKey) {
    writeOutput({ status: 'error', result: null, error: 'No AI backend key found (XAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY required)' });
    process.exit(1);
  }

  // Build SDK env: merge all secrets in for the SDK.
  // Tool credentials (GITHUB_TOKEN etc.) are also written to process.env so
  // Bash subprocesses (gh, curl) can use them. AI API keys are kept SDK-only.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
    if (TOOL_CREDENTIAL_VARS.includes(key)) {
      process.env[key] = value;
      // gh CLI uses GH_TOKEN as well
      if (key === 'GITHUB_TOKEN') process.env['GH_TOKEN'] = value;
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Inject media file path so the agent knows what to read/analyse.
  // The host mounts data/media/<group>/ → /workspace/media/ (read-only) in the container.
  if (containerInput.mediaPath) {
    const mediaBasename = path.basename(containerInput.mediaPath);
    const containerMediaPath = `/workspace/media/${mediaBasename}`;
    if (fs.existsSync(containerMediaPath)) {
      prompt += `\n\n<uploaded_file path="${containerMediaPath}" />`;
      log(`Injected media path into prompt: ${containerMediaPath}`);
    } else {
      log(`Media file not found at expected container path: ${containerMediaPath}`);
    }
  }
  const pending = isSingleTurn ? [] : drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Single-turn containers exit after the first result — no IPC loop.
      if (isSingleTurn) {
        log('Single-turn mode, exiting after first result');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Claude error: ${errorMessage}`);

    // Fallback to Gemini/Grok if Claude fails
    if (hasGeminiKey) {
      log('Falling back to Gemini...');
      try {
        await runGeminiFallback(containerInput, prompt);
        return;
      } catch (geminiErr) {
        log(`Gemini fallback also failed: ${geminiErr instanceof Error ? geminiErr.message : String(geminiErr)}`);
      }
    }
    if (hasXaiKey) {
      log('Falling back to Grok...');
      try {
        await runGrokBackend(containerInput, prompt);
        return;
      } catch (grokErr) {
        log(`Grok fallback also failed: ${grokErr instanceof Error ? grokErr.message : String(grokErr)}`);
      }
    }

    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Grok (xAI) conversation history persistence
// ---------------------------------------------------------------------------
interface GrokHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_GROK_HISTORY_ENTRIES = 40;

function getGrokHistoryPath(chatJid: string): string {
  const safeChatId = chatJid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `/workspace/group/.grok-chat-history.${safeChatId}.json`;
}

function loadGrokHistory(chatJid: string): GrokHistoryEntry[] {
  const p = getGrokHistoryPath(chatJid);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }
  return [];
}

function saveGrokHistory(chatJid: string, history: GrokHistoryEntry[]): void {
  try {
    const trimmed = history.slice(-MAX_GROK_HISTORY_ENTRIES);
    fs.writeFileSync(getGrokHistoryPath(chatJid), JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Parallel file generation — fires multiple independent LLM calls at once
// ---------------------------------------------------------------------------

/**
 * Fire N independent Gemini API calls in parallel, each generating content
 * and writing it to a file. ~2.7x faster than sequential generation.
 */
async function parallelGenerate(
  tasks: Array<{ prompt: string; output_path: string }>,
  apiKey: string,
  backend: 'gemini' | 'grok',
  xaiApiKey?: string,
): Promise<string> {
  const startTime = Date.now();
  log(`parallel_generate: starting ${tasks.length} tasks in parallel (backend: ${backend})`);

  const results = await Promise.allSettled(
    tasks.map(async (task, i) => {
      const taskStart = Date.now();
      let content = '';

      if (backend === 'gemini') {
        const ai = new GoogleGenAI({ apiKey });
        const resp = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: task.prompt,
          config: { maxOutputTokens: 16384 },
        });
        content = (resp as any).text ?? '';
      } else if (backend === 'grok' && xaiApiKey) {
        const resp = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${xaiApiKey}`,
          },
          body: JSON.stringify({
            model: 'grok-4-1-fast-reasoning',
            messages: [
              { role: 'system', content: 'You are a web designer. Return ONLY the requested code, no explanations or markdown fences.' },
              { role: 'user', content: task.prompt },
            ],
          }),
        });
        if (!resp.ok) throw new Error(`xAI API error ${resp.status}`);
        const data = await resp.json() as any;
        content = data.choices?.[0]?.message?.content || '';
      }

      // Strip markdown code fences if present
      content = content.replace(/^```(?:html)?\n?/i, '').replace(/\n?```$/i, '').trim();

      // Write to file
      fs.mkdirSync(path.dirname(task.output_path), { recursive: true });
      fs.writeFileSync(task.output_path, content);
      const elapsed = Date.now() - taskStart;
      log(`parallel_generate: task ${i + 1} done in ${elapsed}ms (${content.length} chars) → ${task.output_path}`);
      return { path: task.output_path, chars: content.length, time: elapsed };
    }),
  );

  const totalTime = Date.now() - startTime;
  const summary = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      return `Task ${i + 1}: ✅ ${r.value.chars} chars in ${r.value.time}ms → ${r.value.path}`;
    } else {
      return `Task ${i + 1}: ❌ ${r.reason?.message || 'unknown error'}`;
    }
  });

  log(`parallel_generate: all done in ${totalTime}ms (vs ~${totalTime * tasks.length}ms sequential)`);
  return `All ${tasks.length} tasks completed in ${totalTime}ms (parallel):\n${summary.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Grok (xAI) backend — OpenAI-compatible REST API with function calling
// ---------------------------------------------------------------------------

interface XaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface XaiChoice {
  finish_reason: string;
  message: XaiMessage;
}

interface XaiResponse {
  choices: XaiChoice[];
}

async function xaiChat(apiKey: string, model: string, messages: XaiMessage[], tools: object[]): Promise<XaiResponse> {
  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, tools }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`xAI API error ${resp.status}: ${body.slice(0, 500)}`);
  }
  return await resp.json() as XaiResponse;
}

async function runGrokBackend(containerInput: ContainerInput, initialPrompt: string): Promise<void> {
  const apiKey = (containerInput.secrets as Record<string, string> | undefined)?.XAI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'No XAI_API_KEY available' });
    return;
  }

  // Inject tool credentials into process.env so Bash subprocesses can use them
  for (const key of TOOL_CREDENTIAL_VARS) {
    const value = (containerInput.secrets as Record<string, string> | undefined)?.[key];
    if (value) {
      process.env[key] = value;
      if (key === 'GITHUB_TOKEN') process.env['GH_TOKEN'] = value;
    }
  }

  log('Starting Grok (grok-4-1-fast-reasoning) backend...');

  const MODEL = 'grok-4-1-fast-reasoning';

  const tools = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a bash command in the workspace',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Shell command to run' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: 'Send a message back to the user immediately',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Message text to send' } },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute file path' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file in the workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_photo',
        description: 'Send an image/screenshot file to the user. The file must already exist on disk.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the image file to send' },
            caption: { type: 'string', description: 'Optional caption for the photo' },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'parallel_generate',
        description: 'Generate multiple files in PARALLEL using independent LLM calls. ~3x faster than generating one at a time. Use this when you need to create multiple HTML files, design options, or any independent content simultaneously. Each task gets its own LLM call running concurrently.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Array of generation tasks to run in parallel',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'The full prompt describing what to generate (e.g. "Generate a complete HTML homepage for GORJAZZ band with minimal/editorial style...")' },
                  output_path: { type: 'string', description: 'Absolute file path to write the generated content to' },
                },
                required: ['prompt', 'output_path'],
              },
            },
          },
          required: ['tasks'],
        },
      },
    },
  ];

  // Read system prompt
  let systemInstruction = 'You are a helpful AI assistant. You have access to bash, file operations, and can send messages and photos back to the user.';
  for (const name of ['CLAUDE.md', 'GEMINI.md']) {
    const p = `/workspace/group/${name}`;
    if (fs.existsSync(p)) { systemInstruction = fs.readFileSync(p, 'utf-8'); break; }
  }

  // Append tool name mapping
  systemInstruction += `\n\n## Tool Name Mapping (IMPORTANT)
When the instructions above mention \`mcp__nanoclaw__send_message\`, use the \`send_message\` tool instead.
When they mention \`mcp__nanoclaw__send_photo\`, use the \`send_photo\` tool instead.
To take a screenshot, use \`bash\` with agent-browser commands. Example:
\`\`\`
agent-browser open file:///tmp/mypage/index.html
agent-browser wait --load networkidle
agent-browser screenshot /tmp/mypage-preview.png --full
\`\`\`
Then send the screenshot with the \`send_photo\` tool.
NEVER skip the screenshot step — users must SEE visual previews, not just read descriptions.
`;

  let chatHistory = loadGrokHistory(containerInput.chatJid);
  // Keep only last 20 history entries to avoid growing context and slowing API calls
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  log(`Loaded ${chatHistory.length} Grok history entries`);

  const MAX_TURNS = 15;
  let humanPrompt = initialPrompt;

  // Build messages array from history + system prompt
  function buildMessages(userMsg: string): XaiMessage[] {
    const msgs: XaiMessage[] = [
      { role: 'system', content: systemInstruction },
    ];
    for (const entry of chatHistory) {
      msgs.push({ role: entry.role as 'user' | 'assistant', content: entry.content });
    }
    msgs.push({ role: 'user', content: userMsg });
    return msgs;
  }

  // Execute a tool call and return the result string
  function executeTool(name: string, argsStr: string): { result: string; isSend: boolean } {
    let result = '';
    let isSend = false;
    try {
      const args = JSON.parse(argsStr);
      if (name === 'bash') {
        result = execSync(args.command, { cwd: '/workspace/group', shell: '/bin/bash', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).toString();
      } else if (name === 'send_message') {
        const ipcFile = `/workspace/ipc/messages/grok_${Date.now()}.json`;
        fs.writeFileSync(ipcFile, JSON.stringify({ type: 'message', chatJid: containerInput.chatJid, text: args.text }));
        result = 'Message sent';
        isSend = true;
      } else if (name === 'read_file') {
        result = fs.existsSync(args.path) ? fs.readFileSync(args.path, 'utf-8') : 'File not found';
      } else if (name === 'write_file') {
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.content);
        result = 'File written';
      } else if (name === 'send_photo') {
        const srcPath = args.file_path;
        if (!fs.existsSync(srcPath)) {
          result = `File not found: ${srcPath}`;
        } else {
          const ext = path.extname(srcPath) || '.png';
          const mediaDir = '/workspace/ipc/media';
          fs.mkdirSync(mediaDir, { recursive: true });
          const mediaFile = `photo_${Date.now()}${ext}`;
          fs.copyFileSync(srcPath, path.join(mediaDir, mediaFile));
          const ipcFile = `/workspace/ipc/messages/photo_${Date.now()}.json`;
          fs.writeFileSync(ipcFile, JSON.stringify({
            type: 'photo',
            chatJid: containerInput.chatJid,
            mediaFile,
            caption: args.caption || '',
          }));
          result = `Photo queued for delivery: ${mediaFile}`;
          isSend = true;
        }
      } else if (name === 'parallel_generate') {
        // This is async — handled separately below
        result = '__PARALLEL_GENERATE__';
      }
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { result: result.slice(0, 8000), isSend };
  }

  // Async tool executor for parallel_generate (can't use execSync)
  async function executeToolAsync(name: string, argsStr: string): Promise<{ result: string; isSend: boolean }> {
    if (name === 'parallel_generate') {
      try {
        const args = JSON.parse(argsStr);
        const xaiKey = (containerInput.secrets as Record<string, string> | undefined)?.XAI_API_KEY;
        const geminiKey = (containerInput.secrets as Record<string, string> | undefined)?.GEMINI_API_KEY;
        const backend = geminiKey ? 'gemini' : 'grok';
        const key = geminiKey || '';
        const result = await parallelGenerate(args.tasks, key, backend, xaiKey);
        return { result, isSend: false };
      } catch (err) {
        return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, isSend: false };
      }
    }
    return executeTool(name, argsStr);
  }

  // Single-turn mode
  if (containerInput.singleTurn) {
    log('Single-turn Grok mode — no conversation loop');
    const messages = buildMessages(initialPrompt);
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let resp: XaiResponse;
      try {
        resp = await xaiChat(apiKey, MODEL, messages, tools);
      } catch (err) {
        writeOutput({ status: 'error', result: null, error: `Grok error: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const choice = resp.choices[0];
      if ((choice.finish_reason === 'tool_calls' || choice.message.tool_calls?.length) && choice.message.tool_calls) {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          const { result } = await executeToolAsync(tc.function.name, tc.function.arguments);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }
      writeOutput({ status: 'success', result: choice.message.content || null });
      return;
    }
    writeOutput({ status: 'success', result: 'Done' });
    return;
  }

  // Multi-turn conversation loop
  conversationLoop: while (true) {
    let gotFinalAnswer = false;
    let usedSendMessage = false;
    const messages = buildMessages(humanPrompt);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let resp: XaiResponse;
      try {
        resp = await xaiChat(apiKey, MODEL, messages, tools);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeOutput({ status: 'error', result: null, error: `Grok error: ${errMsg}` });
        return;
      }

      const choice = resp.choices[0];

      if ((choice.finish_reason === 'tool_calls' || choice.message.tool_calls?.length) && choice.message.tool_calls) {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          const { result, isSend } = await executeToolAsync(tc.function.name, tc.function.arguments);
          if (isSend) usedSendMessage = true;
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }

        if (shouldClose()) break conversationLoop;
        const ipcMessages = drainIpcInput();
        if (ipcMessages.length > 0) {
          messages.push({ role: 'user', content: ipcMessages.join('\n') });
        }
        continue;
      }

      // Final text response
      const text = choice.message.content || '';

      let finalResult: string | null;
      if (usedSendMessage) {
        finalResult = null;
        log('Suppressing final text — agent already sent via send_message/send_photo');
      } else {
        finalResult = text || null;
      }

      chatHistory.push({ role: 'user', content: humanPrompt });
      chatHistory.push({ role: 'assistant', content: text || '(completed)' });
      saveGrokHistory(containerInput.chatJid, chatHistory);

      writeOutput({ status: 'success', result: finalResult });
      gotFinalAnswer = true;
      break;
    } // end tool-use loop

    if (!gotFinalAnswer) {
      // Hit MAX_TURNS — save history so context is preserved for next message
      chatHistory.push({ role: 'user', content: humanPrompt });
      chatHistory.push({ role: 'assistant', content: '(completed)' });
      saveGrokHistory(containerInput.chatJid, chatHistory);
      writeOutput({ status: 'success', result: null });
      break;
    }

    // Signal idle
    writeOutput({ status: 'success', result: null });

    if (shouldClose()) break;

    log('Grok: waiting for next IPC message...');
    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      log('Grok: close sentinel received, exiting');
      break;
    }

    log(`Grok: got new message (${nextMessage.length} chars), continuing`);
    humanPrompt = nextMessage;
  } // end conversationLoop
}

// ---------------------------------------------------------------------------
// Gemini conversation history persistence
// ---------------------------------------------------------------------------
interface GeminiHistoryEntry {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

const MAX_HISTORY_ENTRIES = 40; // 20 exchanges × 2 (user + model)

function getGeminiHistoryPath(chatJid: string): string {
  const safeChatId = chatJid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `/workspace/group/.gemini-chat-history.${safeChatId}.json`;
}

function loadGeminiHistory(chatJid: string): GeminiHistoryEntry[] {
  const scopedPath = getGeminiHistoryPath(chatJid);
  const legacyPath = '/workspace/group/.gemini-chat-history.json';
  try {
    if (fs.existsSync(scopedPath)) {
      return JSON.parse(fs.readFileSync(scopedPath, 'utf-8'));
    }
    if (fs.existsSync(legacyPath)) {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveGeminiHistory(chatJid: string, history: GeminiHistoryEntry[]): void {
  try {
    const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
    fs.writeFileSync(getGeminiHistoryPath(chatJid), JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Gemini fallback: used when Claude SDK is unavailable or errors
// ---------------------------------------------------------------------------
async function runGeminiFallback(containerInput: ContainerInput, initialPrompt: string): Promise<void> {
  const apiKey = (containerInput.secrets as Record<string, string> | undefined)?.GEMINI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'No GEMINI_API_KEY available for fallback' });
    return;
  }

  // Inject tool credentials into process.env so Bash subprocesses (gh, git, curl) can use them
  for (const key of TOOL_CREDENTIAL_VARS) {
    const value = (containerInput.secrets as Record<string, string> | undefined)?.[key];
    if (value) {
      process.env[key] = value;
      if (key === 'GITHUB_TOKEN') process.env['GH_TOKEN'] = value;
    }
  }

  log('Switching to Gemini 2.5 Flash fallback...');

  const ai = new GoogleGenAI({ apiKey });

  const tools = [
    {
      name: 'bash',
      description: 'Run a bash command in the workspace',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command to run' } },
        required: ['command'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message back to the user immediately',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Message text to send' } },
        required: ['text'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the workspace',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file in the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'send_photo',
      description: 'Send an image/screenshot file to the user. Use after taking a screenshot or generating an image. The file must already exist on disk.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the image file to send (e.g. /workspace/group/screenshot.png)' },
          caption: { type: 'string', description: 'Optional caption for the photo' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'parallel_generate',
      description: 'Generate multiple files in PARALLEL using independent LLM calls. ~3x faster than generating one at a time. Use this when you need to create multiple HTML files, design options, or any independent content simultaneously.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Array of generation tasks to run in parallel',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The full prompt describing what to generate' },
                output_path: { type: 'string', description: 'Absolute file path to write the generated content to' },
              },
              required: ['prompt', 'output_path'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  ];

  // Read system prompt from CLAUDE.md (primary for both backends) with GEMINI.md as an optional override.
  // CLAUDE.md is the single source of truth; create GEMINI.md only for Gemini-specific overrides.
  let systemInstruction = 'You are a helpful AI assistant. You have access to bash, file operations, and can send messages back to the user.';
  for (const name of ['CLAUDE.md', 'GEMINI.md']) {
    const p = `/workspace/group/${name}`;
    if (fs.existsSync(p)) { systemInstruction = fs.readFileSync(p, 'utf-8'); break; }
  }

  // Append Gemini-specific tool name mapping so the model uses the correct tool names.
  // The CLAUDE.md references mcp__nanoclaw__send_message / mcp__nanoclaw__send_photo
  // but the Gemini runtime exposes these as send_message / send_photo.
  systemInstruction += `\n\n## Tool Name Mapping (IMPORTANT)
When the instructions above mention \`mcp__nanoclaw__send_message\`, use the \`send_message\` tool instead.
When they mention \`mcp__nanoclaw__send_photo\`, use the \`send_photo\` tool instead.
To take a screenshot, use \`bash\` with agent-browser commands. Example:
\`\`\`
agent-browser open file:///tmp/mypage/index.html
agent-browser wait --load networkidle
agent-browser screenshot /tmp/mypage-preview.png --full
\`\`\`
Then send the screenshot with the \`send_photo\` tool.
NEVER skip the screenshot step — users must SEE visual previews, not just read descriptions.
`;

  // Load persistent conversation history so the bot remembers prior messages
  const chatHistory = loadGeminiHistory(containerInput.chatJid);
  log(`Loaded ${chatHistory.length} Gemini history entries`);

  const createChat = () => ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: {
      systemInstruction,
      // @ts-ignore — tools shape accepted at runtime
      tools: [{ functionDeclarations: tools }],
    },
    // @ts-ignore — history seeds the chat with prior conversation
    history: chatHistory,
  });
  let chat = createChat();

  // Track the plain-text version of each user turn for history recording.
  let humanPrompt = initialPrompt;

  // Build initial user message — for Gemini, inject media inline if available.
  let userMessage: string | object = initialPrompt;
  if (containerInput.mediaPath) {
    const mediaBasename = path.basename(containerInput.mediaPath);
    const containerMediaPath = `/workspace/media/${mediaBasename}`;
    if (fs.existsSync(containerMediaPath)) {
      try {
        const ext = path.extname(mediaBasename).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
          '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
          '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
        };
        const mimeGuess = mimeMap[ext] || 'application/octet-stream';

        if (mimeGuess.startsWith('video/')) {
          // Upload video via Files API — inline base64 is too large and unsupported for video
          log(`Uploading video via Files API: ${containerMediaPath} (${mimeGuess})`);
          const videoBuffer = fs.readFileSync(containerMediaPath);
          // @ts-ignore — SDK accepts Blob as file parameter
          const uploadResp = await ai.files.upload({
            file: new Blob([videoBuffer], { type: mimeGuess }),
            config: { mimeType: mimeGuess, displayName: mediaBasename },
          });
          userMessage = [
            { text: initialPrompt },
            { fileData: { mimeType: (uploadResp as any).mimeType ?? mimeGuess, fileUri: (uploadResp as any).uri } },
          ];
          log(`Video uploaded to Files API: ${(uploadResp as any).uri}`);
        } else {
          const fileData = fs.readFileSync(containerMediaPath);
          const b64 = fileData.toString('base64');
          userMessage = [
            { text: initialPrompt },
            { inlineData: { mimeType: mimeGuess, data: b64 } },
          ];
          log(`Injected inline media into Gemini message: ${containerMediaPath} (${mimeGuess})`);
        }
      } catch (err) {
        log(`Failed to read media for Gemini inline: ${err instanceof Error ? err.message : String(err)}`);
        userMessage = initialPrompt + `\n\n<uploaded_file path="${containerMediaPath}" />`;
      }
    }
  }

  const MAX_TURNS = 30;
  const CONTEXT_RESET_TURNS = 20; // Recreate chat periodically to prevent context window overflow
  let turnsSinceReset = 0;

  // Single-turn containers (media analysis, summarization) skip the conversation loop entirely.
  if (containerInput.singleTurn) {
    log('Single-turn Gemini mode — no conversation loop');
    // Run exactly one tool-use cycle then return.
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let resp;
      try {
        // @ts-ignore
        resp = await chat.sendMessage({ message: userMessage });
      } catch (err) {
        writeOutput({ status: 'error', result: null, error: `Gemini error: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const text: string = (resp as any).text ?? '';
      // @ts-ignore
      const fnCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = (resp as any).functionCalls ?? [];
      if (!fnCalls.length) {
        writeOutput({ status: 'success', result: text || null });
        return;
      }
      const fnResponses: object[] = [];
      for (const fn of fnCalls) {
        let result = '';
        try {
          const args = fn.args as Record<string, string>;
          if (fn.name === 'bash') {
            result = execSync(args.command, { cwd: '/workspace/group', shell: '/bin/bash', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).toString();
          } else if (fn.name === 'read_file') {
            result = fs.existsSync(args.path) ? fs.readFileSync(args.path, 'utf-8') : 'File not found';
          } else if (fn.name === 'write_file') {
            fs.mkdirSync(path.dirname(args.path), { recursive: true });
            fs.writeFileSync(args.path, args.content);
            result = 'File written';
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        fnResponses.push({ functionResponse: { ...(fn.id ? { id: fn.id } : {}), name: fn.name, response: { result: result.slice(0, 4000) } } });
      }
      userMessage = fnResponses;
    }
    writeOutput({ status: 'success', result: 'Done' });
    return;
  }

  // Outer loop: each iteration handles one user message → final answer cycle.
  // After delivering an answer we wait for the next IPC message so the container
  // can hold a multi-turn conversation without losing history.
  conversationLoop: while (true) {
  let gotFinalAnswer = false;
  let usedSendMessage = false;  // Track whether send_message/send_photo was used during tool calls
  let sendMessageCount = 0;     // Hard cap on send_message calls per conversation turn
  const MAX_SEND_MESSAGES = 1;  // Max text messages per turn (photos don't count)
  let consecutiveNudges = 0;    // Track consecutive <internal>-only responses to prevent infinite nudge loops
  const MAX_CONSECUTIVE_NUDGES = 2;
  let pendingIpcForNextTurn: string[] = [];  // IPC messages consumed during tool loop, saved for next conversation turn

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Proactively recreate chat to prevent context window from filling up
    if (turnsSinceReset > 0 && turnsSinceReset % CONTEXT_RESET_TURNS === 0) {
      log(`Resetting Gemini chat context after ${CONTEXT_RESET_TURNS} turns to prevent overflow`);
      chat = createChat();
      if (typeof userMessage !== 'string') {
        userMessage = '[Context reset: continuing from prior conversation state. Proceed with the task.]';
      }
    }

    let resp;
    try {
      // @ts-ignore
      resp = await chat.sendMessage({ message: userMessage });
      turnsSinceReset++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // On context overflow errors, reset the chat and retry once
      if (turnsSinceReset > 0 && /context|token|length|exceed|too large/i.test(errMsg)) {
        log(`Context overflow detected: ${errMsg}. Resetting chat and retrying.`);
        chat = createChat();
        turnsSinceReset = 0;
        userMessage = '[Context reset due to length limit. Continue the current task from where you left off.]';
        try {
          // @ts-ignore
          resp = await chat.sendMessage({ message: userMessage });
          turnsSinceReset++;
        } catch (retryErr) {
          writeOutput({ status: 'error', result: null, error: `Gemini error after context reset: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` });
          return;
        }
      } else {
        writeOutput({ status: 'error', result: null, error: `Gemini error: ${errMsg}` });
        return;
      }
    }

    // Extract text
    let text: string = (resp as any).text ?? '';
    // @ts-ignore
    const fnCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = (resp as any).functionCalls ?? [];

    // Strip <internal>...</internal> thinking tags — these are model self-talk, not user content
    const strippedText = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

    if (!fnCalls.length) {
      // If the model only output <internal> tags (no real content, no tool calls),
      // it's hallucinating actions instead of taking them.  Nudge it to actually act.
      if (!strippedText && text.includes('<internal>')) {
        consecutiveNudges++;
        if (consecutiveNudges <= MAX_CONSECUTIVE_NUDGES) {
          log(`Model returned only <internal> tags with no tool calls — nudging to take action (${consecutiveNudges}/${MAX_CONSECUTIVE_NUDGES})`);
          userMessage = 'You just produced internal thinking but did NOT actually call any tools or send any message. You MUST use the send_message tool to communicate with the user. For simple messages like greetings, just call send_message directly with a friendly response — no tools needed. Take action NOW.';
          continue;
        }
        // Exhausted nudge attempts — extract whatever text was in the internal tags
        // and use it as the final response rather than looping forever.
        log(`Max consecutive nudges reached (${MAX_CONSECUTIVE_NUDGES}), extracting internal text as response`);
        const internalMatch = text.match(/<internal>([\s\S]*?)<\/internal>/);
        const fallbackText = internalMatch ? internalMatch[1].trim() : 'Hi! How can I help you?';
        text = fallbackText;
      } else {
        consecutiveNudges = 0; // Reset on successful non-internal output
      }

      // Determine what to send as the final output.
      // If send_message/send_photo was already used during tool calls,
      // the user has already received the response via IPC.  Sending the
      // final text again would cause a visible duplicate.  Strip it or
      // use null so the streaming callback in the host skips it.
      let finalResult: string | null;
      if (usedSendMessage) {
        // Agent already communicated via IPC — suppress final text to prevent dupes.
        // Save the full model text to history so context isn't lost.
        finalResult = null;
        log('Suppressing final text output — agent already sent via send_message/send_photo');
      } else {
        // Use strippedText (normal case) or fall back to text which may have been
        // set from extracted <internal> content after exhausting nudge attempts.
        finalResult = strippedText || text || null;
      }

      // Save this exchange to persistent history (use stripped text to avoid poisoning history)
      const historyText = strippedText || text || '(completed)';
      chatHistory.push({ role: 'user', parts: [{ text: humanPrompt }] });
      chatHistory.push({ role: 'model', parts: [{ text: historyText }] });
      saveGeminiHistory(containerInput.chatJid, chatHistory);

      writeOutput({ status: 'success', result: finalResult });
      gotFinalAnswer = true;
      break;
    }

    // Execute tool calls
    consecutiveNudges = 0; // Model is taking action, reset nudge counter
    const fnResponses: object[] = [];
    for (const fn of fnCalls) {
      let result = '';
      try {
        const args = fn.args as Record<string, string>;
        if (fn.name === 'bash') {
          result = execSync(args.command, { cwd: '/workspace/group', shell: '/bin/bash', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).toString();
        } else if (fn.name === 'send_message') {
          if (sendMessageCount >= MAX_SEND_MESSAGES) {
            result = `Message suppressed — you have already sent ${MAX_SEND_MESSAGES} messages this turn. Combine your text into fewer, longer messages instead of many short ones.`;
            log(`send_message suppressed (${sendMessageCount}/${MAX_SEND_MESSAGES} cap reached)`);
          } else {
            const ipcFile = `/workspace/ipc/messages/gemini_${Date.now()}.json`;
            fs.writeFileSync(ipcFile, JSON.stringify({ type: 'message', chatJid: containerInput.chatJid, text: args.text }));
            result = 'Message sent';
            sendMessageCount++;
            usedSendMessage = true;
          }
        } else if (fn.name === 'read_file') {
          result = fs.existsSync(args.path) ? fs.readFileSync(args.path, 'utf-8') : 'File not found';
        } else if (fn.name === 'write_file') {
          fs.mkdirSync(path.dirname(args.path), { recursive: true });
          fs.writeFileSync(args.path, args.content);
          result = 'File written';
        } else if (fn.name === 'send_photo') {
          const srcPath = args.file_path;
          if (!fs.existsSync(srcPath)) {
            result = `File not found: ${srcPath}`;
          } else {
            const ext = path.extname(srcPath) || '.png';
            const mediaDir = '/workspace/ipc/media';
            fs.mkdirSync(mediaDir, { recursive: true });
            const mediaFile = `photo_${Date.now()}${ext}`;
            fs.copyFileSync(srcPath, path.join(mediaDir, mediaFile));
            const ipcFile = `/workspace/ipc/messages/photo_${Date.now()}.json`;
            fs.writeFileSync(ipcFile, JSON.stringify({
              type: 'photo',
              chatJid: containerInput.chatJid,
              mediaFile,
              caption: args.caption || '',
            }));
            result = `Photo queued for delivery: ${mediaFile}`;
            usedSendMessage = true;
          }
        } else if (fn.name === 'parallel_generate') {
          const geminiKey = (containerInput.secrets as Record<string, string> | undefined)?.GEMINI_API_KEY;
          const xaiKey = (containerInput.secrets as Record<string, string> | undefined)?.XAI_API_KEY;
          const backend = geminiKey ? 'gemini' : 'grok';
          const key = geminiKey || '';
          result = await parallelGenerate((fn.args as any).tasks, key, backend, xaiKey);
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      fnResponses.push({
        functionResponse: { ...(fn.id ? { id: fn.id } : {}), name: fn.name, response: { result: result.slice(0, 4000) } },
      });
    }

    if (shouldClose()) break conversationLoop;
    const ipcMessages = drainIpcInput();
    if (ipcMessages.length > 0) {
      // New user input arrived while the model was processing its current task.
      // DON'T append to fnResponses — that mixes them with tool results and the
      // model may ignore them.  Instead, save for a dedicated conversation turn
      // after the current turn completes.  This ensures the model gives a proper
      // response to follow-up messages (e.g. a design request sent while the
      // greeting was being generated).
      pendingIpcForNextTurn.push(...ipcMessages);
      log(`Saved ${ipcMessages.length} IPC message(s) for next conversation turn (${pendingIpcForNextTurn.length} total pending)`);
    }
    userMessage = fnResponses;
  } // end tool-use loop

  if (!gotFinalAnswer) {
    // Hit MAX_TURNS without a natural conclusion
    if (pendingIpcForNextTurn.length > 0 && !shouldClose()) {
      // There are piped user messages that haven't been addressed yet.
      // Instead of exiting, start a new conversation turn for them.
      log(`MAX_TURNS reached but ${pendingIpcForNextTurn.length} pending IPC message(s) — starting new conversation turn`);
      writeOutput({ status: 'success', result: null });
      humanPrompt = pendingIpcForNextTurn.join('\n');
      userMessage = humanPrompt;
      chatHistory.push({ role: 'user', parts: [{ text: humanPrompt }] });
      chatHistory.push({ role: 'model', parts: [{ text: '(completed previous task)' }] });
      saveGeminiHistory(containerInput.chatJid, chatHistory);
      chat = createChat();
      turnsSinceReset = 0;
      continue conversationLoop;
    }
    writeOutput({ status: 'success', result: 'Done' });
    break;
  }

  // If IPC messages arrived during the tool loop, process them immediately
  // as a new conversation turn instead of waiting in waitForIpcMessage.
  // Also drain any IPC messages that arrived after the last tool call.
  const finalDrainMessages = drainIpcInput();
  if (finalDrainMessages.length > 0) {
    pendingIpcForNextTurn.push(...finalDrainMessages);
  }

  if (pendingIpcForNextTurn.length > 0 && !shouldClose()) {
    log(`Current turn complete, ${pendingIpcForNextTurn.length} pending IPC message(s) — starting new conversation turn immediately`);
    // Signal current turn done
    writeOutput({ status: 'success', result: null });
    humanPrompt = pendingIpcForNextTurn.join('\n');
    userMessage = humanPrompt;
    // Reset counters for the new turn
    chat = createChat();
    turnsSinceReset = 0;
    continue conversationLoop;
  }

  // Signal host that we are idle and ready for the next message
  writeOutput({ status: 'success', result: null });

  if (shouldClose()) break;

  // Wait for the next user message via IPC (or _close sentinel)
  log('Gemini: waiting for next IPC message...');
  const nextMessage = await waitForIpcMessage();
  if (nextMessage === null) {
    log('Gemini: close sentinel received, exiting conversation loop');
    break;
  }

  log(`Gemini: got new message (${nextMessage.length} chars), continuing conversation`);
  humanPrompt = nextMessage;
  userMessage = nextMessage;
  // Recreate chat seeded with updated history for the new turn
  chat = createChat();
  turnsSinceReset = 0;

  } // end conversationLoop
}

main();
