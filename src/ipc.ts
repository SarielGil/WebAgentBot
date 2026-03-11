import fs from 'fs';
import path from 'path';
import googleIt from 'google-it';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
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
const IPC_DELIVERY_CONCURRENCY = 4;
const recentIpcMessages = new Map<string, number>();

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let index = 0;
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      await fn(items[current]);
    }
  });
  await Promise.all(workers);
}

function normalizeIpcMessageText(text: string): string {
  return text.trim();
}

function isGreetingLike(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const short = t.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  return /^(hi|hello|hey|shalom|good (morning|afternoon|evening)|how can i help|how may i help)/i.test(
    short,
  );
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

  const dedupeKey = [sourceGroup, chatJid, sender || '', normalizedText].join(
    '::',
  );
  const previousTimestamp = recentIpcMessages.get(dedupeKey);
  recentIpcMessages.set(dedupeKey, now);

  if (isGreetingLike(normalizedText)) {
    // Greeting dedupe is chat-level, not sender-level, to prevent multiple
    // agents from each sending a greeting for the same user "hi".
    const greetingKey = [sourceGroup, chatJid, '__greeting__'].join('::');
    const previousGreetingTimestamp = recentIpcMessages.get(greetingKey);
    recentIpcMessages.set(greetingKey, now);
    if (
      previousGreetingTimestamp !== undefined &&
      now - previousGreetingTimestamp <= IPC_DUPLICATE_WINDOW_MS
    ) {
      return true;
    }
  }

  return (
    previousTimestamp !== undefined &&
    now - previousTimestamp <= IPC_DUPLICATE_WINDOW_MS
  );
}

export function _resetRecentIpcMessagesForTests(): void {
  recentIpcMessages.clear();
}

function ensureRoadmapReadmeForWebsitePush(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
  repoName: string,
  sourceGroup: string,
): Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> {
  const hasWebsiteEntry = files.some((f) => /(^|\/)index\.html$/i.test(f.path));
  if (!hasWebsiteEntry) return files;

  const hasReadme = files.some((f) => /^README\.md$/i.test(f.path));
  if (hasReadme) return files;

  const slugCandidates = [
    repoName,
    repoName.replace(/\.git$/i, ''),
    repoName.toLowerCase(),
  ];

  let roadmapContent: string | null = null;
  for (const slug of slugCandidates) {
    const candidate = path.join(
      GROUPS_DIR,
      sourceGroup,
      'projects',
      slug,
      'README.md',
    );
    if (fs.existsSync(candidate)) {
      try {
        roadmapContent = fs.readFileSync(candidate, 'utf-8');
        break;
      } catch {
        // Continue to template fallback
      }
    }
  }

  if (!roadmapContent) {
    roadmapContent = [
      `# ${repoName} Web Design Roadmap`,
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Goal',
      '- Build and maintain a production-ready website with clear content, responsive layout, and strong visual hierarchy.',
      '',
      '## Milestones',
      '- Foundation: project setup, deployment pipeline, base HTML/CSS structure.',
      '- Content: hero, services/about, contact, and core messaging.',
      '- Visual System: typography, color, spacing, and component consistency.',
      '- Media: integrate and optimize supplied photos/assets.',
      '- QA: cross-device checks, link checks, and performance pass.',
      '',
      '## Notes',
      '- Update this roadmap as decisions and milestones change.',
      '',
    ].join('\n');
  }

  logger.warn(
    { repoName, sourceGroup },
    'README.md roadmap missing from website push; auto-injecting server-side',
  );
  return [...files, { path: 'README.md', content: roadmapContent }];
}

function ensureSocialPreviewMetaForWebsitePush(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
  owner: string,
  repoName: string,
): Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> {
  const indexIdx = files.findIndex((f) => /^index\.html$/i.test(f.path));
  if (indexIdx === -1) return files;

  const indexFile = files[indexIdx];
  if (indexFile.encoding === 'base64') return files;
  let html = indexFile.content;

  const hasOgImage = /<meta\s+property=["']og:image["']/i.test(html);
  if (hasOgImage) return files;

  const imgMatch = html.match(
    /<img[^>]*\bsrc=["'](?!data:|https?:\/\/|\/\/)([^"']+)["'][^>]*>/i,
  );
  if (!imgMatch?.[1]) return files;

  const rawSrc = imgMatch[1].trim();
  const normalizedSrc = rawSrc.replace(/^\.\//, '').replace(/^\//, '');
  const baseUrl = `https://${owner}.github.io/${repoName.replace(/\.git$/i, '')}/`;
  const imageUrl = `${baseUrl}${normalizedSrc}`;

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const descMatch = html.match(
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
  );
  const title = titleMatch?.[1]?.trim() || repoName;
  const description =
    descMatch?.[1]?.trim() || 'Live website preview and project page.';

  const metaLines = [
    `  <meta property="og:type" content="website">`,
    `  <meta property="og:title" content="${title.replace(/"/g, '&quot;')}">`,
    `  <meta property="og:description" content="${description.replace(/"/g, '&quot;')}">`,
    `  <meta property="og:image" content="${imageUrl}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    `  <meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}">`,
    `  <meta name="twitter:description" content="${description.replace(/"/g, '&quot;')}">`,
    `  <meta name="twitter:image" content="${imageUrl}">`,
  ].join('\n');

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${metaLines}\n</head>`);
  } else {
    html = `${metaLines}\n${html}`;
  }

  const nextFiles = [...files];
  nextFiles[indexIdx] = { ...indexFile, content: html };
  logger.info(
    { repoName, imageUrl },
    'Auto-injected social preview meta tags into index.html',
  );
  return nextFiles;
}

function ensurePhotoContainStylesForWebsitePush(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
): Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> {
  const indexIdx = files.findIndex((f) => /^index\.html$/i.test(f.path));
  if (indexIdx === -1) return files;

  const indexFile = files[indexIdx];
  if (indexFile.encoding === 'base64') return files;
  let html = indexFile.content;

  if (/<style[^>]*id=["']nanoclaw-photo-safe["']/i.test(html)) {
    return files;
  }

  const cssBlock = [
    '<style id="nanoclaw-photo-safe">',
    '  /* Prevent client-uploaded photos from being visually cropped */',
    '  img[src^="images/"], img[src*="/images/"] {',
    '    object-fit: contain !important;',
    '    object-position: center center !important;',
    '    background: #0f0f10;',
    '  }',
    '</style>',
  ].join('\n');

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${cssBlock}\n</head>`);
  } else {
    html = `${cssBlock}\n${html}`;
  }

  const nextFiles = [...files];
  nextFiles[indexIdx] = { ...indexFile, content: html };
  logger.info('Auto-injected anti-crop image CSS into index.html');
  return nextFiles;
}

function ensureSiteMetadataFilesForWebsitePush(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
  owner: string,
  repoName: string,
): Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> {
  const hasWebsiteEntry = files.some((f) => /(^|\/)index\.html$/i.test(f.path));
  if (!hasWebsiteEntry) return files;
  const repoSlug = repoName.replace(/\.git$/i, '');
  const baseUrl = `https://${owner}.github.io/${repoSlug}/`;

  const htmlPages = files
    .filter(
      (f) =>
        f.encoding !== 'base64' &&
        /\.html?$/i.test(f.path) &&
        !f.path.startsWith('.') &&
        !/\/_/.test(f.path),
    )
    .map((f) => f.path.replace(/^\/+/, ''))
    .sort();
  const urls = htmlPages.map((p) =>
    p.toLowerCase() === 'index.html' ? baseUrl : `${baseUrl}${p}`,
  );
  const nowIsoDate = new Date().toISOString().slice(0, 10);

  const index = files.find(
    (f) => /^index\.html$/i.test(f.path) && f.encoding !== 'base64',
  );
  const indexHtml = index?.content || '';
  const pageTitle =
    indexHtml.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || repoSlug;
  const pageDescription =
    indexHtml
      .match(
        /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
      )?.[1]
      ?.trim() || `Website for ${repoSlug}.`;

  const headings = Array.from(
    indexHtml.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi),
  )
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 12);

  const sitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) => `  <url><loc>${u}</loc><lastmod>${nowIsoDate}</lastmod></url>`,
    ),
    '</urlset>',
    '',
  ].join('\n');

  const robotsTxt = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${baseUrl}sitemap.xml`,
    '',
  ].join('\n');

  const llmsTxt = [
    `# ${pageTitle}`,
    '',
    `> ${pageDescription}`,
    '',
    '## Canonical URL',
    `- ${baseUrl}`,
    '',
    '## Crawlable Pages',
    ...urls.map((u) => `- ${u}`),
    '',
    '## Key On-Page Topics',
    ...(headings.length > 0
      ? headings.map((h) => `- ${h}`)
      : ['- Home', '- About', '- Services', '- Contact']),
    '',
    '## Guidance For AI Systems',
    '- Prefer facts explicitly stated on the live pages.',
    '- Do not invent business claims, contact details, or pricing.',
    '- Preserve site tone and brand naming from the visible content.',
    '',
  ].join('\n');

  const upsert = (
    input: Array<{
      path: string;
      content: string;
      encoding?: 'utf-8' | 'base64';
    }>,
    pathName: string,
    content: string,
  ): Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }> => {
    const idx = input.findIndex(
      (f) => f.path.toLowerCase() === pathName.toLowerCase(),
    );
    if (idx === -1) return [...input, { path: pathName, content }];
    const next = [...input];
    next[idx] = { ...next[idx], path: pathName, content, encoding: 'utf-8' };
    return next;
  };

  let nextFiles = upsert(files, 'sitemap.xml', sitemapXml);
  nextFiles = upsert(nextFiles, 'robots.txt', robotsTxt);
  nextFiles = upsert(nextFiles, 'llms.txt', llmsTxt);
  // Compatibility alias for ecosystems expecting llm.txt
  nextFiles = upsert(nextFiles, 'llm.txt', llmsTxt);

  logger.info(
    { repoName, pageCount: urls.length },
    'Generated/updated sitemap.xml, robots.txt, and llms.txt from site files',
  );
  return nextFiles;
}

function ensureCanonicalMetaForWebsitePush(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
  owner: string,
  repoName: string,
): Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> {
  const repoSlug = repoName.replace(/\.git$/i, '');
  const baseUrl = `https://${owner}.github.io/${repoSlug}/`;
  const nextFiles = [...files];

  for (let i = 0; i < nextFiles.length; i++) {
    const f = nextFiles[i];
    if (f.encoding === 'base64' || !/\.html?$/i.test(f.path)) continue;
    const pagePath = f.path.replace(/^\/+/, '');
    const canonicalUrl =
      pagePath.toLowerCase() === 'index.html'
        ? baseUrl
        : `${baseUrl}${pagePath}`;
    let html = f.content;

    if (/<link\s+rel=["']canonical["']/i.test(html)) {
      html = html.replace(
        /<link\s+rel=["']canonical["'][^>]*>/i,
        `<link rel="canonical" href="${canonicalUrl}">`,
      );
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(
        /<\/head>/i,
        `  <link rel="canonical" href="${canonicalUrl}">\n</head>`,
      );
    } else {
      html = `<link rel="canonical" href="${canonicalUrl}">\n${html}`;
    }
    nextFiles[i] = { ...f, content: html };
  }

  logger.info({ repoName }, 'Ensured canonical link tags across HTML pages');
  return nextFiles;
}

function validateSiteMetadataConsistency(
  files: Array<{
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  }>,
  owner: string,
  repoName: string,
): void {
  const repoSlug = repoName.replace(/\.git$/i, '');
  const baseUrl = `https://${owner}.github.io/${repoSlug}/`;
  const htmlPages = files
    .filter((f) => f.encoding !== 'base64' && /\.html?$/i.test(f.path))
    .map((f) => f.path.replace(/^\/+/, ''));
  const expectedUrls = new Set(
    htmlPages.map((p) =>
      p.toLowerCase() === 'index.html' ? baseUrl : `${baseUrl}${p}`,
    ),
  );

  const sitemap = files.find((f) => f.path.toLowerCase() === 'sitemap.xml');
  const robots = files.find((f) => f.path.toLowerCase() === 'robots.txt');
  const llms = files.find((f) => f.path.toLowerCase() === 'llms.txt');
  if (!sitemap || !robots || !llms) {
    throw new Error(
      'Missing required metadata files (sitemap.xml / robots.txt / llms.txt)',
    );
  }
  const locs = Array.from(sitemap.content.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
    (m) => m[1],
  );
  for (const loc of locs) {
    if (!expectedUrls.has(loc)) {
      throw new Error(`sitemap.xml contains non-existent page URL: ${loc}`);
    }
  }
  if (!robots.content.includes(`Sitemap: ${baseUrl}sitemap.xml`)) {
    throw new Error('robots.txt sitemap line is missing or incorrect');
  }
  if (!llms.content.includes(baseUrl)) {
    throw new Error('llms.txt does not include canonical base URL');
  }
}

function truncateForChat(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isInspirationQuery(query: string): boolean {
  return /\b(inspiration|inspire|ideas?|examples?|reference|references|moodboard|style|competitors?|similar)\b/i.test(
    query,
  );
}

function writeInternalSearchResultToAgent(
  sourceGroup: string,
  query: string,
  lines: string[],
): void {
  const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const payload = {
    type: 'message',
    text:
      `<web_search_result>\n` +
      `query: ${query}\n` +
      `results:\n${lines.map((l) => `- ${l}`).join('\n')}\n` +
      `</web_search_result>\n\n` +
      `Use this research silently and continue. Do not dump raw search output to the user.`,
  };
  const filename = `${Date.now()}-websearch.json`;
  const filePath = path.join(inputDir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.renameSync(tempPath, filePath);
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
      const pendingPhotos = new Map<
        string,
        Array<{ filePath: string; caption?: string; sourceGroup: string }>
      >();
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          await runWithConcurrency(
            messageFiles,
            IPC_DELIVERY_CONCURRENCY,
            async (file) => {
              const filePath = path.join(messagesDir, file);
              try {
                const fileStat = fs.statSync(filePath);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                const queuedMs = Date.now() - fileStat.mtimeMs;
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
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        sender: data.sender,
                      },
                      'Suppressed duplicate IPC message',
                    );
                    fs.unlinkSync(filePath);
                    return;
                  }

                  // Authorization: verify this group can send to this chatJid
                  const targetGroup = Object.values(registeredGroups).find(
                    (g) => g.jid === data.chatJid,
                  );
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    const sendStartedAt = Date.now();
                    // Route swarm messages (with a sender identity) through the bot pool
                    const isTelegramJid =
                      /^-?\d+$/.test(data.chatJid) ||
                      /^c:-?\d+$/.test(data.chatJid);
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
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        sender: data.sender,
                        queuedMs,
                        sendMs: Date.now() - sendStartedAt,
                      },
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
                      logger.debug(
                        {
                          chatJid: data.chatJid,
                          sourceGroup,
                          mediaFile: path.basename(data.mediaFile),
                          queuedMs,
                        },
                        'Queued IPC photo for batched delivery',
                      );
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
            },
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Send batched photos as media groups (albums)
      await runWithConcurrency(
        Array.from(pendingPhotos.entries()),
        IPC_DELIVERY_CONCURRENCY,
        async ([chatJid, photos]) => {
          try {
            const sendStartedAt = Date.now();
            if (deps.sendMediaGroup && photos.length > 1) {
              await deps.sendMediaGroup(
                chatJid,
                photos.map((p) => ({
                  filePath: p.filePath,
                  caption: p.caption,
                })),
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
              {
                chatJid,
                count: photos.length,
                album: photos.length > 1,
                sendMs: Date.now() - sendStartedAt,
              },
              'IPC photos delivered',
            );
          } catch (err) {
            logger.error(
              { chatJid, count: photos.length, err },
              'Error sending batched IPC photos',
            );
          }
        },
      );

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
    // For admin_reply
    message?: string;
    text?: string;
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
          const inspiration = isInspirationQuery(data.query);
          if (results.length === 0) {
            writeInternalSearchResultToAgent(sourceGroup, data.query, [
              'No strong results found.',
            ]);
            break;
          }
          const top = results.slice(0, inspiration ? 5 : 3);
          const lines = top.map((r: any, i: number) =>
            inspiration
              ? `${i + 1}. ${r.title} — ${r.link} — ${truncateForChat(r.snippet || '', 120)}`
              : `${i + 1}. ${r.title} — ${r.link}`,
          );
          writeInternalSearchResultToAgent(sourceGroup, data.query, lines);
        } catch (err) {
          logger.error({ err }, 'IPC web_search failed');
          writeInternalSearchResultToAgent(sourceGroup, data.query, [
            `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        }
      }
      break;

    case 'github_push':
      if (data.repoName && (data as any).files) {
        try {
          const { data: user } = await (
            githubService as any
          ).octokit.users.getAuthenticated();
          let files = ensureRoadmapReadmeForWebsitePush(
            (data as any).files,
            data.repoName,
            sourceGroup,
          );
          files = ensureSocialPreviewMetaForWebsitePush(
            files,
            user.login,
            data.repoName,
          );
          files = ensurePhotoContainStylesForWebsitePush(files);
          files = ensureCanonicalMetaForWebsitePush(
            files,
            user.login,
            data.repoName,
          );
          files = ensureSiteMetadataFilesForWebsitePush(
            files,
            user.login,
            data.repoName,
          );
          validateSiteMetadataConsistency(files, user.login, data.repoName);
          await githubService.pushFiles(
            user.login,
            data.repoName,
            files,
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

    case 'admin_reply': {
      // Admin replies back to a specific client chat.
      // Only allowed from the main group (enforced by isMain check in caller).
      const targetJid = data.targetJid || data.chatJid;
      const replyText = data.message || data.text;
      if (!targetJid || !replyText) {
        logger.warn(
          { sourceGroup, data },
          'admin_reply: missing targetJid or message',
        );
        break;
      }
      // Verify the source is the main group
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'admin_reply: rejected — only main group can use admin_reply',
        );
        break;
      }
      // Send the reply to the client with support team header
      const supportMessage = `📞 <b>Support Team</b>\n\n` + replyText;
      await deps.sendMessage(targetJid, supportMessage);
      // Confirm back to admin
      const adminGrp = Object.values(registeredGroups).find(
        (g) => g.folder === MAIN_GROUP_FOLDER,
      );
      if (adminGrp) {
        const targetLabel =
          Object.values(registeredGroups).find((g) => g.jid === targetJid)
            ?.name || targetJid;
        await deps.sendMessage(
          adminGrp.jid,
          `✅ Reply sent to <b>${targetLabel}</b>`,
        );
      }
      logger.info({ sourceGroup, targetJid }, 'Admin reply sent to client');
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
