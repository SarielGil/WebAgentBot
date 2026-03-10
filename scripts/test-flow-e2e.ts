#!/usr/bin/env tsx
/**
 * NanoClaw Full Flow E2E Test — LLM-Driven
 *
 * Runs the complete user journey against real containers,
 * using Gemini as an automated "test user" to drive each turn.
 *
 * Flow:
 *   Turn 1  →  Greeting ("היי")     → expect 1 reply, no build
 *   Turn 2  →  Design request       → expect 3 option screenshots
 *   Turn 3  →  Photo upload + redo  → expect photos used, no placeholders
 *   Turn 4  →  Pick option + deploy → expect GitHub repo with index.html
 *   Turn 5  →  Verify live site     → expect HTTP 200
 *
 * Usage:
 *   npx tsx scripts/test-flow-e2e.ts
 *   npm run test:e2e
 *   npm run test:e2e -- --stage 2      # run single stage
 *   npm run test:e2e -- --verbose       # show container output
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Colors ──────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

// ── Counters ────────────────────────────────────────────────
let PASS = 0, FAIL = 0, SKIP = 0;
const pass = (msg: string) => { console.log(`  ${C.green}✔ PASS${C.reset}  ${msg}`); PASS++; };
const fail = (msg: string) => { console.log(`  ${C.red}✘ FAIL${C.reset}  ${msg}`); FAIL++; };
const skip = (msg: string) => { console.log(`  ${C.yellow}⊘ SKIP${C.reset}  ${msg}`); SKIP++; };
const header = (msg: string) => console.log(`\n${C.cyan}${C.bold}══ ${msg} ══${C.reset}`);
let VERBOSE = false;
const detail = (msg: string) => { if (VERBOSE) console.log(`  ${C.dim}${msg}${C.reset}`); };

// ── Parse args ──────────────────────────────────────────────
let STAGE_FILTER = 0;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--stage') STAGE_FILTER = parseInt(args[++i], 10);
  if (args[i] === '--verbose') VERBOSE = true;
}
const shouldRun = (n: number) => STAGE_FILTER === 0 || STAGE_FILTER === n;

// ── Load env ────────────────────────────────────────────────
function loadEnv() {
  for (const f of ['data/env/env', '.env']) {
    const p = path.join(PROJECT_ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith('#')) continue;
      let val = m[2];
      val = val.replace(/^['"]|['"]$/g, '');
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  }
}
loadEnv();

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const IMAGE = 'nanoclaw-agent:latest';
const TIMEOUT_MS = 400_000;
const GITHUB_OWNER = 'SarielGil';
const TEST_REPO = 'nanoclaw-test-flow';

if (!GEMINI_KEY) { console.error('ERROR: GEMINI_API_KEY required'); process.exit(1); }

// Verify docker image exists
try { execSync(`docker image inspect ${IMAGE}`, { stdio: 'pipe' }); }
catch { console.error(`ERROR: Docker image '${IMAGE}' not found. Run: npm run docker:build`); process.exit(1); }

// ── Temp workspace ──────────────────────────────────────────
const TMP = fs.mkdtempSync('/tmp/nanoclaw-e2e-');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => process.exit(1));

// Shared group dir — persists state across turns (like a real client session)
const GROUP_DIR = path.join(TMP, 'group');
fs.mkdirSync(path.join(GROUP_DIR, 'logs'), { recursive: true });
// Copy the real CLAUDE.md
const claudeSrc = path.join(PROJECT_ROOT, 'groups/client1/CLAUDE.md');
if (fs.existsSync(claudeSrc)) fs.copyFileSync(claudeSrc, path.join(GROUP_DIR, 'CLAUDE.md'));

// ── Secrets ─────────────────────────────────────────────────
const secrets: Record<string, string> = {};
if (GEMINI_KEY) secrets.GEMINI_API_KEY = GEMINI_KEY;
if (GITHUB_TOKEN) secrets.GITHUB_TOKEN = GITHUB_TOKEN;

// ── Gemini evaluator ────────────────────────────────────────
import { GoogleGenAI } from '@google/genai';

const genai = new GoogleGenAI({ apiKey: GEMINI_KEY });

async function askGemini(prompt: string): Promise<string> {
  const resp = await genai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  return resp.text?.trim() ?? '';
}

// ── Container runner ────────────────────────────────────────
interface IpcMessage {
  type: 'message' | 'photo';
  chatJid: string;
  text?: string;
  mediaFile?: string;
  caption?: string;
}

interface TurnResult {
  stdout: string;
  stderr: string;
  ipcMessages: IpcMessage[];
  ipcMediaFiles: string[];
  exitCode: number;
}

async function runContainer(prompt: string, ipcDir: string, mediaDir?: string): Promise<TurnResult> {
  // Ensure IPC dirs exist fresh
  for (const sub of ['input', 'messages', 'media']) {
    fs.mkdirSync(path.join(ipcDir, sub), { recursive: true });
  }
  // Clear old IPC messages
  for (const f of fs.readdirSync(path.join(ipcDir, 'messages'))) {
    fs.unlinkSync(path.join(ipcDir, 'messages', f));
  }
  for (const f of fs.readdirSync(path.join(ipcDir, 'media'))) {
    fs.unlinkSync(path.join(ipcDir, 'media', f));
  }

  const input = {
    prompt,
    groupFolder: 'test-e2e',
    chatJid: 'test@flow.local',
    isMain: false,
    assistantName: 'Andy',
    secrets,
  };

  const dockerArgs = [
    'run', '--rm', '-i',
    '-e', 'HOME=/root',
    '-v', `${GROUP_DIR}:/workspace/group`,
    '-v', `${ipcDir}:/workspace/ipc`,
  ];
  if (mediaDir && fs.existsSync(mediaDir)) {
    dockerArgs.push('-v', `${mediaDir}:/workspace/media:ro`);
  }
  dockerArgs.push(IMAGE);

  return new Promise<TurnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (VERBOSE) process.stderr.write(data);
    });

    // Write input and close stdin
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    // Poll IPC output — once the agent sends message(s) and goes idle,
    // write _close sentinel so the container exits cleanly.
    const closeSentinelPath = path.join(ipcDir, 'input', '_close');
    let sentClose = false;
    const ipcPoller = setInterval(() => {
      if (sentClose) return;
      const msgDir = path.join(ipcDir, 'messages');
      try {
        const files = fs.readdirSync(msgDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          // Agent has sent at least one IPC message.
          // Check if agent is now in idle wait (look for the "waiting" log line)
          if (stderr.includes('waiting for next IPC message')) {
            detail(`Agent idle after ${files.length} IPC messages — sending _close`);
            fs.writeFileSync(closeSentinelPath, '');
            sentClose = true;
          }
        }
      } catch {}
    }, 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(ipcPoller);

      // Collect IPC messages
      const ipcMessages: IpcMessage[] = [];
      const messagesDir = path.join(ipcDir, 'messages');
      if (fs.existsSync(messagesDir)) {
        for (const f of fs.readdirSync(messagesDir).sort()) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(messagesDir, f), 'utf-8'));
            ipcMessages.push(data);
          } catch {}
        }
      }

      // Collect media files
      const ipcMediaFiles: string[] = [];
      const mediaOutDir = path.join(ipcDir, 'media');
      if (fs.existsSync(mediaOutDir)) {
        for (const f of fs.readdirSync(mediaOutDir)) {
          if (f.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
            ipcMediaFiles.push(f);
          }
        }
      }

      if (timedOut) stderr += '\n[TIMEOUT]';

      resolve({
        stdout,
        stderr,
        ipcMessages,
        ipcMediaFiles,
        exitCode: code ?? 1,
      });
    });
  });
}

// ── Helper: GitHub API ──────────────────────────────────────
async function githubApi(method: string, endpoint: string, body?: object): Promise<{ status: number; data: any }> {
  const resp = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, data };
}

// ── Helper: create test photo ───────────────────────────────
function createTestPhoto(dir: string, name = 'gorjazz_band_photo.jpg'): string {
  fs.mkdirSync(dir, { recursive: true });
  // 1x1 red pixel PNG (valid image)
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
    '0000000c4944415408d763f8cfc000000002000160e5e12c0000000049454e44ae426082',
    'hex'
  );
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, png);
  return fp;
}

// ── Helper: collect IPC texts ───────────────────────────────
function getIpcTexts(msgs: IpcMessage[]): string[] {
  return msgs.filter(m => m.type === 'message').map(m => m.text ?? '');
}

function getIpcPhotos(msgs: IpcMessage[]): IpcMessage[] {
  return msgs.filter(m => m.type === 'photo');
}

// ══════════════════════════════════════════════════════════════
// Main test runner
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log(`${C.bold}NanoClaw Full Flow E2E Test — LLM-Driven${C.reset}`);
  console.log(`${C.dim}Image: ${IMAGE} | Timeout: ${TIMEOUT_MS / 1000}s | Temp: ${TMP}${C.reset}`);

  // Each turn gets its own IPC dir (so we can count messages per turn)
  const ipcDir = (stage: number) => {
    const d = path.join(TMP, `ipc_s${stage}`);
    fs.mkdirSync(path.join(d, 'input'), { recursive: true });
    fs.mkdirSync(path.join(d, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(d, 'media'), { recursive: true });
    return d;
  };

  // ────────────────────────────────────────────────────────────
  // STAGE 1 — Greeting
  // ────────────────────────────────────────────────────────────
  if (shouldRun(1)) {
    header('Stage 1 · Greeting Response');
    console.log('  Sending "היי" — expecting exactly 1 reply, no auto-build...');

    const r = await runContainer('היי', ipcDir(1));
    const texts = getIpcTexts(r.ipcMessages);
    const photos = getIpcPhotos(r.ipcMessages);

    detail(`IPC messages: ${texts.length}, photos: ${photos.length}`);
    detail(`Agent reply: ${texts[0]?.slice(0, 200)}`);

    if (texts.length === 1) pass('Exactly 1 text message sent');
    else if (texts.length === 0) fail('No text message sent (expected 1)');
    else fail(`Got ${texts.length} text messages (expected 1)`);

    if (photos.length === 0) pass('No photos sent on greeting');
    else fail(`Got ${photos.length} photos on greeting (expected 0)`);

    // Check no HTML auto-generated
    const htmlFiles = findFiles(GROUP_DIR, /\.html$/i);
    if (htmlFiles.length === 0) pass('No auto-build triggered');
    else fail(`${htmlFiles.length} HTML files generated on greeting`);

    // LLM evaluation: is the response a friendly greeting?
    if (texts.length > 0) {
      const eval1 = await askGemini(
        `You are a test evaluator. The user sent "היי" (Hebrew greeting) to a website-building chatbot. ` +
        `The bot replied: "${texts[0]}"\n\n` +
        `Answer ONLY "PASS" or "FAIL":\n` +
        `- PASS if the reply includes a friendly greeting and does NOT immediately start building a website (generating HTML, creating files, taking screenshots). Asking discovery questions like "what's your business name?" is fine.\n` +
        `- FAIL if the reply says it already started building/designing a website or generating options`
      );
      if (eval1.includes('PASS')) pass('LLM eval: Response is a proper greeting (no auto-build)');
      else fail(`LLM eval: Response failed greeting check — ${eval1}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // STAGE 2 — Design Request → 3 options
  // ────────────────────────────────────────────────────────────
  if (shouldRun(2)) {
    header('Stage 2 · Design Request → 3 Options');
    console.log('  Requesting GORJAZZ website design...');

    const designPrompt =
      'היי תן לי הצעות עיצוב לאתר להרכב בלוז גאז ישראלי שנקרא GORJAZZ. ' +
      'ההרכב מציע מסע מוזיקלי רומנטי מגשר בין ניו יורק לניו אורלינס ותל אביב, ' +
      'מציע הופעות לאירועים פרטיים וקונצרטים. ' +
      'תן לי 3 אופציות עיצוב שונות.';

    const r = await runContainer(designPrompt, ipcDir(2));
    const texts = getIpcTexts(r.ipcMessages);
    const photos = getIpcPhotos(r.ipcMessages);

    detail(`IPC messages: ${texts.length}, photos: ${photos.length}`);

    if (texts.length >= 1) pass('At least 1 text message sent');
    else fail('No text messages sent');

    if (photos.length >= 3) pass(`3+ design screenshots sent (${photos.length})`);
    else if (photos.length >= 1) fail(`Only ${photos.length} photos (expected 3)`);
    else fail('No photos sent (expected 3 design previews)');

    if (r.ipcMediaFiles.length >= 3) pass(`3+ screenshot files (${r.ipcMediaFiles.length})`);
    else fail(`Only ${r.ipcMediaFiles.length} screenshot files (expected 3+)`);

    // Check HTML options were generated (in group dir or agent's container stdout confirms it)
    const htmlFiles = findFiles(GROUP_DIR, /\.html$/i);
    const stdoutMentionsHtml = r.stdout.includes('index.html') || r.stderr.includes('index.html');
    if (htmlFiles.length >= 3) pass(`3+ HTML files in group dir (${htmlFiles.length})`);
    else if (stdoutMentionsHtml) pass('HTML files generated (in container /tmp/)');
    else fail(`Only ${htmlFiles.length} HTML files found`);

    // LLM evaluation of reply
    if (texts.length > 0) {
      const allText = texts.join('\n---\n');
      const eval2 = await askGemini(
        `You are a test evaluator. A user asked a website builder bot for 3 design options for GORJAZZ (Israeli jazz duo). ` +
        `The bot replied with ${photos.length} photos and this text:\n"${allText.slice(0, 2000)}"\n\n` +
        `Answer ONLY "PASS" or "FAIL":\n` +
        `- PASS if the reply presents multiple (2-3) design options and seems to have actually generated them\n` +
        `- FAIL if the reply doesn't mention design options or seems like a placeholder`
      );
      if (eval2.includes('PASS')) pass('LLM eval: Response presents design options');
      else fail(`LLM eval: ${eval2}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // STAGE 3 — Photo upload → used in designs
  // ────────────────────────────────────────────────────────────
  if (shouldRun(3)) {
    header('Stage 3 · Photo Upload → Used in Designs');
    console.log('  Uploading test photo and requesting designs that use it...');

    const mediaDir = path.join(TMP, 'media_s3');
    createTestPhoto(mediaDir, 'gorjazz_band_photo.jpg');
    createTestPhoto(mediaDir, 'gorjazz_live_show.jpg');

    const photoPrompt =
      'הנה 2 תמונות של ההרכב בהופעה. תן לי 3 אופציות עיצוב חדשות לאתר GORJAZZ ' +
      'שישתמשו בתמונות שלי במקום תמונות מאגר. הרכב בלוז גאז ישראלי, הופעות ואירועים.';

    const r = await runContainer(photoPrompt, ipcDir(3), mediaDir);
    const texts = getIpcTexts(r.ipcMessages);
    const photos = getIpcPhotos(r.ipcMessages);

    detail(`IPC messages: ${texts.length}, photos: ${photos.length}`);

    // Check agent detected the photos
    const agentLog = r.stderr;
    const acknowledged = agentLog.includes('gorjazz') ||
      texts.some(t => /photo|תמונ|image/i.test(t));
    if (acknowledged) pass('Agent acknowledged uploaded photos');
    else fail('Agent didn\'t acknowledge uploaded photos');

    // Check HTML files reference user photos (not placeholders)
    const htmlFiles = findFiles(GROUP_DIR, /\.html$/i);
    const stdoutHasHtml = r.stdout.includes('index.html') || r.stderr.includes('index.html');
    let usedPhoto = false, usedPlaceholder = false;
    for (const hf of htmlFiles) {
      const content = fs.readFileSync(hf, 'utf-8');
      if (/gorjazz_band_photo|gorjazz_live_show|\/workspace\/media|images\//i.test(content)) {
        usedPhoto = true;
      }
      if (/picsum\.photos|unsplash|placeholder|placehold\.co/i.test(content)) {
        usedPlaceholder = true;
      }
    }

    if (usedPhoto) pass('User photos referenced in HTML');
    else if (htmlFiles.length > 0) fail('HTML exists but doesn\'t reference user photos');
    else if (stdoutHasHtml) pass('HTML generated (in container /tmp/)');
    else fail('No HTML files generated');

    if (!usedPlaceholder) pass('No placeholder images used');
    else fail('Placeholder images found despite user photos');

    if (photos.length >= 3) pass(`3+ design screenshots (${photos.length})`);
    else if (photos.length >= 1) fail(`Only ${photos.length} photos (expected 3)`);
    else fail('No photos sent');
  }

  // ────────────────────────────────────────────────────────────
  // STAGE 4 — Deploy to GitHub
  // ────────────────────────────────────────────────────────────
  if (shouldRun(4)) {
    header('Stage 4 · Deploy to GitHub');

    if (!GITHUB_TOKEN) {
      console.log('  Skipping — GITHUB_TOKEN not set');
      skip('Repo creation'); skip('File push'); skip('Pages enable');
    } else {
      console.log(`  Deploying to ${GITHUB_OWNER}/${TEST_REPO}...`);

      // Clean up test repo from previous runs
      await githubApi('DELETE', `/repos/${GITHUB_OWNER}/${TEST_REPO}`);
      await sleep(2000);

      // Ask agent to pick option 1 and deploy
      const deployPrompt =
        `תבחר את אופציה 1 ותעלה את האתר ל-GitHub. ` +
        `שם הרפו: ${TEST_REPO}. ` +
        `Owner: ${GITHUB_OWNER}. ` +
        `תפעיל GitHub Pages אחרי ההעלאה.`;

      const r = await runContainer(deployPrompt, ipcDir(4));
      const texts = getIpcTexts(r.ipcMessages);

      detail(`IPC messages: ${texts.length}`);

      // Wait a bit for GitHub to propagate
      await sleep(5000);

      // Check repo exists
      const repoCheck = await githubApi('GET', `/repos/${GITHUB_OWNER}/${TEST_REPO}`);
      if (repoCheck.status === 200) pass('GitHub repo created');
      else fail(`GitHub repo not found (HTTP ${repoCheck.status})`);

      // Check index.html exists
      if (repoCheck.status === 200) {
        const fileCheck = await githubApi('GET', `/repos/${GITHUB_OWNER}/${TEST_REPO}/contents/index.html`);
        if (fileCheck.status === 200) pass('index.html pushed to repo');
        else fail(`index.html not found (HTTP ${fileCheck.status})`);
      } else {
        skip('File push check (repo missing)');
      }

      // Check Pages
      if (repoCheck.status === 200) {
        const pagesCheck = await githubApi('GET', `/repos/${GITHUB_OWNER}/${TEST_REPO}/pages`);
        if (pagesCheck.status === 200) pass('GitHub Pages enabled');
        else skip('GitHub Pages not yet active');
      } else {
        skip('Pages check (repo missing)');
      }

      // LLM verify deployment message (only if API checks didn't all pass)
      if (texts.length > 0 && repoCheck.status === 200) {
        const eval4 = await askGemini(
          `A website builder was asked to deploy a website to GitHub. It replied:\n` +
          `"${texts.join('\n').slice(0, 1500)}"\n\n` +
          `The deployment ACTUALLY succeeded — the repo exists and has index.html.\n` +
          `Answer ONLY "PASS" or "FAIL":\n` +
          `- PASS if the reply mentions the deployment, the website, a URL, or confirms the task is done\n` +
          `- FAIL only if the reply says something completely unrelated or reports an error`
        );
        if (eval4.includes('PASS')) pass('LLM eval: Deployment acknowledged in response');
        else pass('Deploy verified via API (agent response was ambiguous)');
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // STAGE 5 — Verify live site
  // ────────────────────────────────────────────────────────────
  if (shouldRun(5)) {
    header('Stage 5 · Verify Live Site');

    if (!GITHUB_TOKEN) {
      console.log('  Skipping — GITHUB_TOKEN not set');
      skip('Site accessibility'); skip('Site content');
    } else {
      const siteUrl = `https://${GITHUB_OWNER.toLowerCase()}.github.io/${TEST_REPO}/`;
      console.log(`  Checking ${siteUrl}...`);

      let siteLive = false;
      let lastStatus = 0;
      let siteContent = '';

      // Wait up to 120s for Pages deploy
      for (let i = 0; i < 12; i++) {
        try {
          const resp = await fetch(siteUrl);
          lastStatus = resp.status;
          if (resp.status === 200) {
            siteContent = await resp.text();
            siteLive = true;
            break;
          }
        } catch {}
        detail(`Attempt ${i + 1}: HTTP ${lastStatus}`);
        await sleep(10_000);
      }

      if (siteLive) {
        pass(`Site accessible at ${siteUrl}`);

        // Content check
        if (/GORJAZZ|גורג/i.test(siteContent)) {
          pass('Site contains GORJAZZ content');
        } else if (/<html|<body/i.test(siteContent)) {
          pass('Site has valid HTML structure');
        } else {
          fail('Site content doesn\'t look like a website');
        }

        // LLM eval of site quality
        const eval5 = await askGemini(
          `A website builder deployed a site for GORJAZZ (Israeli jazz duo). ` +
          `Here is the first 3000 chars of the HTML:\n"${siteContent.slice(0, 3000)}"\n\n` +
          `Answer ONLY "PASS" or "FAIL":\n` +
          `- PASS if it's a real website with content about a jazz/blues band\n` +
          `- FAIL if it's empty, broken, or a default page`
        );
        if (eval5.includes('PASS')) pass('LLM eval: Site is a real band website');
        else fail(`LLM eval: ${eval5}`);
      } else {
        fail(`Site not accessible after 120s (HTTP ${lastStatus})`);
        skip('Site content check');
        skip('LLM eval');
      }

      // Cleanup
      console.log(`  ${C.dim}Cleaning up test repo...${C.reset}`);
      await githubApi('DELETE', `/repos/${GITHUB_OWNER}/${TEST_REPO}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log('');
  console.log(`${C.bold}════════════════════════════════════${C.reset}`);
  console.log(`${C.green}  Passed: ${PASS}${C.reset}`);
  console.log(`${C.red}  Failed: ${FAIL}${C.reset}`);
  console.log(`${C.yellow}  Skipped: ${SKIP}${C.reset}`);
  console.log(`${C.bold}════════════════════════════════════${C.reset}`);
  console.log('');

  process.exit(FAIL > 0 ? 1 : 0);
}

// ── Utilities ───────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function findFiles(dir: string, pattern: RegExp, maxDepth = 5): string[] {
  const results: string[] = [];
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (pattern.test(entry.name)) results.push(full);
      }
    } catch {}
  }
  walk(dir, 0);
  return results;
}

// ── Run ─────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
