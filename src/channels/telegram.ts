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
}

export class TelegramChannel implements Channel {
    name = 'telegram';

    private bot!: Bot;
    private connected = false;
    private outgoingQueue: Array<{ jid: string; text: string }> = [];
    private flushing = false;
    private opts: TelegramChannelOpts;

    constructor(opts: TelegramChannelOpts) {
        this.opts = opts;

        // Read from our new .env via env utils
        const envs = readEnvFile(['TELEGRAM_BOT_TOKEN']);
        const token = envs.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

        if (!token) {
            throw new Error('TELEGRAM_BOT_TOKEN is required in .env');
        }

        this.bot = new Bot(token);
    }

    async connect(): Promise<void> {
        this.bot.on('message', async (ctx) => {
            const chatId = ctx.chat.id.toString();
            const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const registeredGroups = this.opts.registeredGroups();

            // Ignore non-registered groups if needed, but always sync metadata
            this.opts.onChatMetadata(
                chatId,
                timestamp,
                ctx.chat.title || ctx.chat.first_name || 'Telegram Chat',
                'telegram',
                isGroup
            );

            if (!registeredGroups[chatId]) return;

            const senderId = ctx.from?.id.toString() || 'unknown';
            const senderName = ctx.from?.username || ctx.from?.first_name || senderId;
            let content = ctx.message.text || ctx.message.caption || '';
            let mediaPath: string | undefined;

            // Handle Media
            if (ctx.message.photo) {
                const photo = ctx.message.photo[ctx.message.photo.length - 1];
                mediaPath = await this.downloadTelegramFile(photo.file_id, 'photo');
            } else if (ctx.message.video) {
                mediaPath = await this.downloadTelegramFile(ctx.message.video.file_id, 'video');
            } else if (ctx.message.document) {
                mediaPath = await this.downloadTelegramFile(ctx.message.document.file_id, 'doc');
            }

            if (!content && !mediaPath) return;

            this.opts.onMessage(chatId, {
                id: ctx.message.message_id.toString(),
                chat_jid: chatId,
                sender: senderId,
                sender_name: senderName,
                content,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
                media_path: mediaPath,
            });
        });

        this.bot.catch((err) => {
            logger.error({ err }, 'Telegram Bot Error');
        });

        logger.info('Starting Telegram Bot Polling...');
        this.bot.start();
        this.connected = true;

        this.flushOutgoingQueue().catch(err => logger.error({ err }, 'Failed to flush queue'));
    }

    async sendMessage(jid: string, text: string): Promise<void> {
        if (!this.connected) {
            this.outgoingQueue.push({ jid, text });
            return;
        }
        try {
            await this.bot.api.sendMessage(jid, text, { parse_mode: 'HTML' });
            logger.info({ jid }, 'Message sent via Telegram');
        } catch (err) {
            this.outgoingQueue.push({ jid, text });
            logger.warn({ err, jid }, 'Failed to send Telegram message, queued');
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    ownsJid(jid: string): boolean {
        // In telegram, chat IDs are numeric strings (or negative for groups)
        return /^-?\d+$/.test(jid);
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        await this.bot.stop();
    }

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
        if (!this.connected) return;
        try {
            if (isTyping) {
                await this.bot.api.sendChatAction(jid, 'typing');
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
                await this.bot.api.sendMessage(item.jid, item.text);
            }
        } finally {
            this.flushing = false;
        }
    }

    private async downloadTelegramFile(fileId: string, prefix: string): Promise<string | undefined> {
        try {
            const file = await this.bot.api.getFile(fileId);
            if (!file.file_path) return undefined;

            const ext = path.extname(file.file_path) || (prefix === 'photo' ? '.jpg' : '');
            const fileName = `${prefix}_${Date.now()}${ext}`;
            const targetPath = path.join(MEDIA_DIR, fileName);

            const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

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
