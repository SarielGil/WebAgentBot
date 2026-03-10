import { Api, Bot, InputFile } from 'grammy';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { readEnvFile } from '../env.js';
import { MEDIA_DIR } from '../config.js';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

// ---------------------------------------------------------------------------
// Agent Swarm — module-level bot pool (send-only Api instances, no polling)
// ---------------------------------------------------------------------------

const poolApis: Api[] = [];
/** Maps "{groupFolder}:{senderName}" → pool Api index for stable per-group assignment. */
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Call once on startup after reading TELEGRAM_BOT_POOL.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * Falls back to `fallback` if no pool bots are configured.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  fallback?: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  if (poolApis.length === 0) {
    if (fallback) await fallback(chatId, text);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  // Strip 'c:' prefix if present to get the raw Telegram numeric chat ID
  const rawId = chatId.startsWith('c:') ? chatId.slice(2) : chatId;
  const MAX_LENGTH = 4096;
  try {
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(rawId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(rawId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * The folder name for the admin/main group.
   * Messages on the admin bot are only processed for this folder.
   * Replies for this folder are sent via the admin bot.
   * Defaults to 'main'.
   */
  adminFolder?: string;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private static readonly OUTGOING_RETRY_MS = 5000;

  /** All active bot instances. bots[0] = client bot, bots[1] = admin bot. */
  private bots: Bot[] = [];
  private connected = false;
  private outgoingQueue: Array<
    | { type: 'message'; jid: string; text: string }
    | { type: 'photo'; jid: string; filePath: string; caption?: string }
  > = [];
  private flushing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private opts: TelegramChannelOpts;
  private adminFolder: string;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.adminFolder = opts.adminFolder ?? 'main';

    const envs = readEnvFile([
      'TELEGRAM_BOT_TOKEN',
      'ADMIN_TELEGRAM_BOT_TOKEN',
    ]);
    const token1 = envs.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const token2 =
      envs.ADMIN_TELEGRAM_BOT_TOKEN || process.env.ADMIN_TELEGRAM_BOT_TOKEN;

    if (!token1) {
      throw new Error('TELEGRAM_BOT_TOKEN is required in .env');
    }

    this.bots.push(new Bot(token1));
    if (token2 && token2 !== token1) {
      this.bots.push(new Bot(token2));
      logger.info(
        'TelegramChannel: dual-bot mode enabled (client=bot0, admin=bot1)',
      );
    }
  }

  /**
   * In dual-bot mode, client bot JIDs are prefixed with 'c:' to namespace
   * them from admin bot JIDs. This lets the same Telegram user talk to both
   * bots independently (e.g. admin account testing the client bot).
   */
  private clientJid(chatId: string): string {
    return this.bots.length > 1 ? `c:${chatId}` : chatId;
  }

  /** Strip the 'c:' prefix to get the real Telegram chat ID for API calls. */
  private rawChatId(jid: string): string {
    return jid.startsWith('c:') ? jid.slice(2) : jid;
  }

  async connect(): Promise<void> {
    for (const [botIndex, bot] of this.bots.entries()) {
      const isAdminBot = botIndex === 1;

      bot.on('message', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        // In dual-bot mode, client bot uses namespaced JID 'c:<chatId>'
        // so the same user can talk to both bots independently.
        const routingJid = isAdminBot ? chatId : this.clientJid(chatId);
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        const timestamp = new Date(ctx.message.date * 1000).toISOString();

        this.opts.onChatMetadata(
          routingJid,
          timestamp,
          ctx.chat.title || ctx.chat.first_name || 'Telegram Chat',
          'telegram',
          isGroup,
        );

        if (isAdminBot) {
          // Admin bot: only respond to chats registered in the admin folder
          const group = Object.values(this.opts.registeredGroups()).find(
            (g) => g.jid === routingJid,
          );
          if (!group || group.folder !== this.adminFolder) return;
        }
        // Client bot: processes all JIDs (namespaced, so no collision with admin)

        // Ignore messages authored by bots, including our own send-only pool bots.
        // Otherwise Telegram group updates can feed our outbound messages back into
        // the router as fresh inbound user messages, causing a second round.
        if (ctx.from?.is_bot) {
          logger.debug(
            { routingJid, senderId: ctx.from.id.toString() },
            'Ignoring Telegram bot-authored message',
          );
          return;
        }

        const senderId = ctx.from?.id.toString() || 'unknown';
        const senderName =
          ctx.from?.username || ctx.from?.first_name || senderId;
        let content = ctx.message.text || ctx.message.caption || '';
        let mediaPath: string | undefined;

        // Handle Media
        if (ctx.message.photo) {
          const photo = ctx.message.photo[ctx.message.photo.length - 1];
          mediaPath = await this.downloadTelegramFile(
            bot,
            photo.file_id,
            'photo',
          );
        } else if (ctx.message.video) {
          mediaPath = await this.downloadTelegramFile(
            bot,
            ctx.message.video.file_id,
            'video',
          );
        } else if (ctx.message.document) {
          mediaPath = await this.downloadTelegramFile(
            bot,
            ctx.message.document.file_id,
            'doc',
          );
        }

        if (!content && !mediaPath) return;

        this.opts.onMessage(routingJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: routingJid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
          media_path: mediaPath,
        });
      });

      bot.catch((err) => {
        logger.error({ err }, 'Telegram Bot Error');
      });

      bot.start();
    }

    logger.info(
      { botCount: this.bots.length },
      'Telegram bot(s) polling started',
    );
    this.connected = true;

    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush queue'),
    );
  }

  /** Pick the correct bot for a given JID. Client JIDs ('c:...') → bots[0], others → bots[1] or bots[0]. */
  private botForJid(jid: string): Bot {
    if (jid.startsWith('c:')) return this.bots[0];
    // Admin JID: use bots[1] if available
    if (this.bots.length > 1) return this.bots[1];
    return this.bots[0];
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.enqueueOutgoing({ type: 'message', jid, text });
      return;
    }
    const bot = this.botForJid(jid);
    const chatId = this.rawChatId(jid);
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
      logger.info(
        { jid, botIndex: this.bots.indexOf(bot) },
        'Message sent via Telegram',
      );
    } catch (err) {
      this.enqueueOutgoing({ type: 'message', jid, text });
      logger.warn({ err, jid }, 'Failed to send Telegram message, queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Telegram chat IDs are plain numeric or namespaced 'c:<numeric>' for client bot
    return /^-?\d+$/.test(jid) || /^c:-?\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await Promise.all(this.bots.map((b) => b.stop()));
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) {
      this.enqueueOutgoing({ type: 'photo', jid, filePath, caption });
      return;
    }
    const bot = this.botForJid(jid);
    const chatId = this.rawChatId(jid);
    try {
      const stream = fs.createReadStream(filePath);
      const opts: Record<string, unknown> = {};
      if (caption) opts.caption = caption;
      await bot.api.sendPhoto(chatId, new InputFile(stream), opts as any);
      logger.info({ jid }, 'Photo sent via Telegram');
      try {
        fs.unlinkSync(filePath);
      } catch {}
    } catch (err) {
      this.enqueueOutgoing({ type: 'photo', jid, filePath, caption });
      logger.warn({ err, jid, filePath }, 'Failed to send Telegram photo');
    }
  }

  /**
   * Send multiple photos as a Telegram media group (album).
   * Photos appear bundled together in the chat instead of as separate messages.
   */
  async sendMediaGroup(
    jid: string,
    photos: Array<{ filePath: string; caption?: string }>,
  ): Promise<void> {
    if (photos.length === 0) return;
    // Fall back to single sendPhoto for 1 photo
    if (photos.length === 1) {
      return this.sendPhoto(jid, photos[0].filePath, photos[0].caption);
    }
    if (!this.connected) {
      // Fall back to individual queuing
      for (const p of photos) {
        this.enqueueOutgoing({
          type: 'photo',
          jid,
          filePath: p.filePath,
          caption: p.caption,
        });
      }
      return;
    }
    const bot = this.botForJid(jid);
    const chatId = this.rawChatId(jid);
    try {
      const media = photos.map((p, i) => {
        const stream = fs.createReadStream(p.filePath);
        const item: Record<string, unknown> = {
          type: 'photo',
          media: new InputFile(stream),
        };
        if (p.caption) item.caption = p.caption;
        return item;
      });
      await (bot.api as any).sendMediaGroup(chatId, media);
      logger.info(
        { jid, count: photos.length },
        'Media group sent via Telegram',
      );
      for (const p of photos) {
        try {
          fs.unlinkSync(p.filePath);
        } catch {}
      }
    } catch (err) {
      logger.warn(
        { err, jid, count: photos.length },
        'Failed to send media group, falling back to individual photos',
      );
      // Fall back to sending individually
      for (const p of photos) {
        try {
          await this.sendPhoto(jid, p.filePath, p.caption);
        } catch {}
      }
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    const bot = this.botForJid(jid);
    const chatId = this.rawChatId(jid);
    try {
      if (isTyping) {
        await bot.api.sendChatAction(chatId, 'typing');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to set Telegram typing status');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        try {
          await this.sendQueuedItem(item);
        } catch (err) {
          // Detect permanent failures (e.g. file too big) — don't retry forever
          const errMsg = err instanceof Error ? err.message : String(err);
          if (/too big|too large|file.*size/i.test(errMsg)) {
            logger.error(
              { jid: item.jid, err },
              'Permanent send failure (file too large), dropping from queue',
            );
            // Try to send caption as plain text so user gets some feedback
            if (item.type === 'photo' && item.caption) {
              try {
                const bot = this.botForJid(item.jid);
                const chatId = this.rawChatId(item.jid);
                await bot.api.sendMessage(chatId, item.caption);
              } catch {}
            }
            if (item.type === 'photo' && item.filePath) {
              try {
                fs.unlinkSync(item.filePath);
              } catch {}
            }
            continue; // Skip to next item instead of retrying
          }
          this.outgoingQueue.unshift(item);
          this.scheduleRetry();
          logger.warn(
            { err, jid: item.jid, queueLength: this.outgoingQueue.length },
            'Failed to flush Telegram queue, will retry',
          );
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private enqueueOutgoing(
    item:
      | { type: 'message'; jid: string; text: string }
      | { type: 'photo'; jid: string; filePath: string; caption?: string },
  ): void {
    this.outgoingQueue.push(item);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.connected || this.outgoingQueue.length === 0)
      return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushOutgoingQueue().catch((err) =>
        logger.error({ err }, 'Failed to flush queue'),
      );
    }, TelegramChannel.OUTGOING_RETRY_MS);
  }

  private async sendQueuedItem(
    item:
      | { type: 'message'; jid: string; text: string }
      | { type: 'photo'; jid: string; filePath: string; caption?: string },
  ): Promise<void> {
    const bot = this.botForJid(item.jid);
    const chatId = this.rawChatId(item.jid);

    if (item.type === 'message') {
      await bot.api.sendMessage(chatId, item.text, { parse_mode: 'HTML' });
      logger.info(
        { jid: item.jid, botIndex: this.bots.indexOf(bot) },
        'Message sent via Telegram',
      );
      return;
    }

    if (!fs.existsSync(item.filePath)) {
      logger.warn(
        { filePath: item.filePath, jid: item.jid },
        'Photo file no longer exists, dropping from queue',
      );
      return;
    }

    // Telegram limit: photos must be <10MB. If larger, try as document; if that
    // also fails, send just the caption as text and discard the file.
    const TELEGRAM_PHOTO_MAX = 10 * 1024 * 1024; // 10MB
    const fileSize = fs.statSync(item.filePath).size;

    if (fileSize > TELEGRAM_PHOTO_MAX) {
      logger.warn(
        { jid: item.jid, filePath: item.filePath, fileSize },
        `Photo exceeds Telegram 10MB limit (${(fileSize / 1024 / 1024).toFixed(1)}MB), sending as document`,
      );
      try {
        const docStream = fs.createReadStream(item.filePath);
        const docOpts: Record<string, unknown> = {};
        if (item.caption) docOpts.caption = item.caption;
        await bot.api.sendDocument(
          chatId,
          new InputFile(docStream),
          docOpts as any,
        );
        logger.info({ jid: item.jid }, 'Oversized photo sent as document');
        try {
          fs.unlinkSync(item.filePath);
        } catch {}
        return;
      } catch (docErr) {
        logger.warn(
          { jid: item.jid, err: docErr },
          'Failed to send oversized photo as document, sending caption only',
        );
        if (item.caption) {
          try {
            await bot.api.sendMessage(chatId, item.caption);
          } catch {}
        }
        try {
          fs.unlinkSync(item.filePath);
        } catch {}
        return; // Don't throw — this is a permanent failure, not retryable
      }
    }

    const stream = fs.createReadStream(item.filePath);
    const opts: Record<string, unknown> = {};
    if (item.caption) opts.caption = item.caption;
    await bot.api.sendPhoto(chatId, new InputFile(stream), opts as any);
    logger.info({ jid: item.jid }, 'Photo sent via Telegram');
    try {
      fs.unlinkSync(item.filePath);
    } catch {}
  }

  private async downloadTelegramFile(
    bot: Bot,
    fileId: string,
    prefix: string,
  ): Promise<string | undefined> {
    try {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return undefined;

      const ext =
        path.extname(file.file_path) || (prefix === 'photo' ? '.jpg' : '');
      // Use a stable name derived from fileId so re-processing the same message
      // never downloads the same file twice.
      const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
      const fileName = `${prefix}_${safeId}${ext}`;
      const targetPath = path.join(MEDIA_DIR, fileName);

      // Skip download entirely if this exact file already exists on disk.
      if (fs.existsSync(targetPath)) {
        logger.debug(
          { fileId, targetPath },
          'Media file already cached, skipping download',
        );
        return targetPath;
      }

      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

      return new Promise((resolve, reject) => {
        https.get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download file: ${res.statusCode}`));
            return;
          }
          const writeStream = fs.createWriteStream(targetPath);
          res.pipe(writeStream);
          writeStream.on('finish', () => {
            writeStream.close();
            resolve(targetPath);
          });
          writeStream.on('error', reject);
        });
      });
    } catch (err) {
      logger.error({ err, fileId }, 'Failed to download Telegram file');
      return undefined;
    }
  }
}
