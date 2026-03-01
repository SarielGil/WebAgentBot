import { Bot } from 'grammy';
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

    /** All active bot instances. bots[0] = client bot, bots[1] = admin bot. */
    private bots: Bot[] = [];
    private connected = false;
    private outgoingQueue: Array<{ jid: string; text: string }> = [];
    private flushing = false;
    private opts: TelegramChannelOpts;
    private adminFolder: string;

    constructor(opts: TelegramChannelOpts) {
        this.opts = opts;
        this.adminFolder = opts.adminFolder ?? 'main';

        const envs = readEnvFile(['TELEGRAM_BOT_TOKEN', 'ADMIN_TELEGRAM_BOT_TOKEN']);
        const token1 = envs.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        const token2 = envs.ADMIN_TELEGRAM_BOT_TOKEN || process.env.ADMIN_TELEGRAM_BOT_TOKEN;

        if (!token1) {
            throw new Error('TELEGRAM_BOT_TOKEN is required in .env');
        }

        this.bots.push(new Bot(token1));
        if (token2 && token2 !== token1) {
            this.bots.push(new Bot(token2));
            logger.info('TelegramChannel: dual-bot mode enabled (client=bot0, admin=bot1)');
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
                const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
                const timestamp = new Date(ctx.message.date * 1000).toISOString();

                this.opts.onChatMetadata(
                    routingJid,
                    timestamp,
                    ctx.chat.title || ctx.chat.first_name || 'Telegram Chat',
                    'telegram',
                    isGroup
                );

                if (isAdminBot) {
                    // Admin bot: only respond to chats registered in the admin folder
                    const group = this.opts.registeredGroups()[routingJid];
                    if (!group || group.folder !== this.adminFolder) return;
                }
                // Client bot: processes all JIDs (namespaced, so no collision with admin)

                const senderId = ctx.from?.id.toString() || 'unknown';
                const senderName = ctx.from?.username || ctx.from?.first_name || senderId;
                let content = ctx.message.text || ctx.message.caption || '';
                let mediaPath: string | undefined;

                // Handle Media
                if (ctx.message.photo) {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    mediaPath = await this.downloadTelegramFile(bot, photo.file_id, 'photo');
                } else if (ctx.message.video) {
                    mediaPath = await this.downloadTelegramFile(bot, ctx.message.video.file_id, 'video');
                } else if (ctx.message.document) {
                    mediaPath = await this.downloadTelegramFile(bot, ctx.message.document.file_id, 'doc');
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

        logger.info({ botCount: this.bots.length }, 'Telegram bot(s) polling started');
        this.connected = true;

        this.flushOutgoingQueue().catch(err => logger.error({ err }, 'Failed to flush queue'));
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
            this.outgoingQueue.push({ jid, text });
            return;
        }
        const bot = this.botForJid(jid);
        const chatId = this.rawChatId(jid);
        try {
            await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
            logger.info({ jid, botIndex: this.bots.indexOf(bot) }, 'Message sent via Telegram');
        } catch (err) {
            this.outgoingQueue.push({ jid, text });
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
        await Promise.all(this.bots.map(b => b.stop()));
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
                await this.botForJid(item.jid).api.sendMessage(this.rawChatId(item.jid), item.text);
            }
        } finally {
            this.flushing = false;
        }
    }

    private async downloadTelegramFile(bot: Bot, fileId: string, prefix: string): Promise<string | undefined> {
        try {
            const file = await bot.api.getFile(fileId);
            if (!file.file_path) return undefined;

            const ext = path.extname(file.file_path) || (prefix === 'photo' ? '.jpg' : '');
            const fileName = `${prefix}_${Date.now()}${ext}`;
            const targetPath = path.join(MEDIA_DIR, fileName);

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
