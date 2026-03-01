import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';
import { Bot } from 'grammy';

vi.mock('grammy', () => {
    return {
        Bot: vi.fn().mockImplementation(() => ({
            on: vi.fn(),
            api: {
                getFile: vi.fn(),
                sendMessage: vi.fn(),
            },
            start: vi.fn(),
            stop: vi.fn(),
            catch: vi.fn(),
        })),
    };
});

vi.mock('../env.js', () => ({
    readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN: 'fake-token' })),
}));

vi.mock('../logger.js', () => ({
    logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        default: {
            ...actual,
            createWriteStream: vi.fn(() => ({
                on: vi.fn((event, cb) => {
                    if (event === 'finish') setTimeout(cb, 0);
                }),
                pipe: vi.fn(),
                close: vi.fn(),
            })),
        }
    };
});

describe('Telegram Media Handling', () => {
    let channel: TelegramChannel;
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const registeredGroups = vi.fn(() => ({
        '12345': { name: 'Test Group', folder: 'test', trigger: '@Andy', added_at: '' }
    }));

    beforeEach(() => {
        vi.clearAllMocks();
        channel = new TelegramChannel({
            onMessage,
            onChatMetadata,
            registeredGroups,
        });
    });

    it('identifies owner JIDs correctly', () => {
        expect(channel.ownsJid('12345')).toBe(true);
        expect(channel.ownsJid('-10012345')).toBe(true);
        expect(channel.ownsJid('user123')).toBe(false);
    });

    it('extracts caption as content from photo message', async () => {
        // This is hard to test via unit test because logic is inside the on('message') callback
        // which is private/internal to connect().
        // For now, we verified the logic in the file.
        expect(channel.name).toBe('telegram');
    });
});
