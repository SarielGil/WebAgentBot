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
            if (!ctx.message || !ctx.message.text) return;

            // Use stringified chat ID as JID
            const chatId = ctx.chat.id.toString();
            const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
            const timestamp = new Date(ctx.message.date * 1000).toISOString();

            // Ensure chat metadata is registered
            this.opts.onChatMetadata(
                chatId,
                timestamp,
                ctx.chat.title || ctx.chat.first_name || 'Telegram Chat',
                'telegram',
                isGroup
            );

            const registeredGroups = this.opts.registeredGroups();

            // Since default nanoclaw only listens to registered groups, 
            // if it's not setup yet via main channel, it drops the msg.
            // But we always need to handle it if we want to auto-onboard users.
            // For now, if the group is registered, process it.
            if (registeredGroups[chatId]) {
                const textStr = ctx.message.text;
                const senderId = ctx.from.id.toString();
                const senderName = ctx.from.username || ctx.from.first_name || senderId;

                this.opts.onMessage(chatId, {
                    id: ctx.message.message_id.toString(),
                    chat_jid: chatId,
                    sender: senderId,
                    sender_name: senderName,
                    content: textStr,
                    timestamp,
                    is_from_me: false,
                    is_bot_message: false,
                });
            }
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
}
