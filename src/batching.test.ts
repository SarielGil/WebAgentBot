import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NewMessage } from './types.js';

// Setup mocks before importing index.js
vi.mock('./db.js', () => ({
  getMessagesSince: vi.fn(),
  saveState: vi.fn(),
  initDatabase: vi.fn(),
  getRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllChats: vi.fn(() => []),
  setSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('./router.js', async () => {
  const actual = await vi.importActual('./router.js');
  return {
    ...actual,
    findChannel: vi.fn(),
    formatMessages: vi.fn((msgs: NewMessage[]) =>
      msgs.map((m) => m.content).join('\n'),
    ),
  };
});

vi.mock('./config.js', () => ({
  BATCH_DELAY: 5000,
  MAIN_GROUP_FOLDER: 'main',
  TRIGGER_PATTERN: /@Andy/i,
  ASSISTANT_NAME: 'Andy',
}));

// Now import
import {
  routeNewMessages,
  batchTimers,
  _setRegisteredGroups,
  queue,
  channels,
} from './index.js';
import * as router from './router.js';
import * as db from './db.js';

describe('Message Batching', () => {
  const chatJid = 'test-chat@g.us';
  const group = {
    name: 'Test Group',
    folder: 'test-folder',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    batchTimers.clear();
    _setRegisteredGroups({ [group.folder]: { ...group, jid: chatJid } });

    // Mock channel
    const mockChannel = {
      name: 'telegram',
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    (router.findChannel as any).mockReturnValue(mockChannel);
    channels.push(mockChannel as any);

    // Mock queue
    vi.spyOn(queue, 'sendMessage').mockReturnValue(true);
    vi.spyOn(queue, 'enqueueMessageCheck').mockReturnValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    channels.length = 0;
  });

  it('batches multiple messages and only sends once after quiet period', async () => {
    const msg1 = {
      id: '1',
      chat_jid: chatJid,
      content: '@Andy hello',
      timestamp: '1000',
    } as NewMessage;
    const msg2 = {
      id: '2',
      chat_jid: chatJid,
      content: 'how are you?',
      timestamp: '2000',
    } as NewMessage;

    // Mock DB: initially empty, then both messages
    (db.getMessagesSince as any)
      .mockReturnValueOnce([])
      .mockReturnValue([msg1, msg2]);

    // Send first message
    await routeNewMessages([msg1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(batchTimers.has(group.folder)).toBe(true);
    expect(queue.sendMessage).not.toHaveBeenCalled();

    // Advance 3s
    await vi.advanceTimersByTimeAsync(3000);

    // Send second message - should reset quiet period
    await routeNewMessages([msg2]);
    await vi.advanceTimersByTimeAsync(0);

    // Total 7s elapsed since first message (1 + 3 + 3),
    // 4s since msg2. Quiet period (5s) shouldn't have passed since msg2.
    await vi.advanceTimersByTimeAsync(4000);
    expect(queue.sendMessage).not.toHaveBeenCalled();

    // One more second - total 5s since msg2
    await vi.advanceTimersByTimeAsync(1100);

    expect(queue.sendMessage).toHaveBeenCalledWith(
      group.folder,
      '@Andy hello\nhow are you?',
    );
    expect(batchTimers.has(group.folder)).toBe(false);
  });
});
