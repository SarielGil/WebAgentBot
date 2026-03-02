import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 1. Mock config BEFORE importing anything else
vi.mock('./config.js', async () => {
    const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
    return {
        ...actual,
        BATCH_DELAY: 10,
        TRIGGER_PATTERN: /^@Andy\b/i,
    };
});

// 2. Mock container-runner
vi.mock('./container-runner.js', async () => {
    const actual = await vi.importActual<typeof import('./container-runner.js')>('./container-runner.js');
    return {
        ...actual,
        runContainerAgent: vi.fn(),
    };
});

// 3. Mock grammy
vi.mock('grammy', () => ({
    Bot: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        api: {
            sendMessage: vi.fn(),
            sendChatAction: vi.fn(),
        },
        start: vi.fn(),
        stop: vi.fn(),
        catch: vi.fn(),
    })),
}));

// Now import the rest
import {
    _initTestDatabase,
    storeMessage,
    setRegisteredGroup,
    getRouterState,
    storeChatMetadata
} from './db.js';
import { routeNewMessages, channels, queue, batchTimers, _setRegisteredGroups } from './index.js';
import { ASSISTANT_NAME } from './config.js';

describe('End-to-End Routing Logic', () => {
    const chatJid = '12345';
    const groupFolder = 'test-group';

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        _initTestDatabase();

        // Clear batch timers
        for (const timer of batchTimers.values()) {
            clearTimeout(timer);
        }
        batchTimers.clear();

        // Store chat metadata
        storeChatMetadata(chatJid, new Date().toISOString(), 'Test Group', 'telegram', true);

        const group = {
            jid: chatJid,
            name: 'Test Group',
            folder: groupFolder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: true,
        };

        // Register in DB
        setRegisteredGroup(chatJid, group);

        // CRITICAL: Sync index.ts's in-memory registeredGroups
        _setRegisteredGroups({ [groupFolder]: { ...group, jid: chatJid } });

        // Mock the Telegram channel
        const mockTelegram = {
            name: 'telegram',
            sendMessage: vi.fn().mockResolvedValue(undefined),
            setTyping: vi.fn().mockResolvedValue(undefined),
            isConnected: () => true,
            ownsJid: (jid: string) => jid === chatJid,
        };

        channels.length = 0;
        channels.push(mockTelegram as any);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('correctly batches messages and moves cursor when piped to container', async () => {
        const timestamp = new Date().toISOString();
        const message = {
            id: 'msg_1',
            chat_jid: chatJid,
            sender: 'user_1',
            sender_name: 'User One',
            content: `@Andy help`,
            timestamp,
        };

        storeMessage({ ...message, is_from_me: false });

        vi.spyOn(queue, 'sendMessage').mockReturnValue(true);

        const p = routeNewMessages([message]);

        // Fast-forward
        vi.advanceTimersByTime(20);

        await p;

        // Verify database cursor
        const lastAgentTs = JSON.parse(getRouterState('last_agent_timestamp') || '{}');
        expect(lastAgentTs[groupFolder]).toBe(timestamp);

        expect(queue.sendMessage).toHaveBeenCalled();
    });

    it('enqueues a message check when no active container exists', async () => {
        const timestamp = new Date().toISOString();
        const message = {
            id: 'msg_2',
            chat_jid: chatJid,
            sender: 'user_1',
            sender_name: 'User One',
            content: `@Andy test`,
            timestamp,
        };

        storeMessage({ ...message, is_from_me: false });

        // Mock GroupQueue to simulate NO active container
        vi.spyOn(queue, 'sendMessage').mockReturnValue(false);
        vi.spyOn(queue, 'enqueueMessageCheck').mockImplementation(() => { });

        const p = routeNewMessages([message]);

        vi.advanceTimersByTime(20);

        await p;

        expect(queue.enqueueMessageCheck).toHaveBeenCalledWith(groupFolder);
    });
});
