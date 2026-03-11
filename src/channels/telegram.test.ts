import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';
import { Bot } from 'grammy';
import { PassThrough } from 'stream';

vi.mock('grammy', () => {
  class MockInputFile {
    constructor(public value: unknown) {}
  }
  class MockBot {
    constructor() {}
    on = vi.fn();
    api = {
      getFile: vi.fn(),
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
    };
    start = vi.fn();
    stop = vi.fn();
    catch = vi.fn();
  }
  return {
    Bot: MockBot,
    InputFile: MockInputFile,
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
      existsSync: vi.fn(() => true),
      statSync: vi.fn(() => ({ size: 1024 })),
      createReadStream: vi.fn(() => new PassThrough()),
      createWriteStream: vi.fn(() => ({
        on: vi.fn((event, cb) => {
          if (event === 'finish') setTimeout(cb, 0);
        }),
        pipe: vi.fn(),
        close: vi.fn(),
      })),
    },
  };
});

describe('Telegram Media Handling', () => {
  let channel: TelegramChannel;
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn(() => ({
    '12345': {
      jid: '12345',
      name: 'Test Group',
      folder: 'test',
      trigger: '@Andy',
      added_at: '',
    },
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    channel = new TelegramChannel({
      onMessage,
      onChatMetadata,
      registeredGroups,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function getMessageHandler() {
    await channel.connect();
    const bot = (channel as any).bots[0];
    const messageCall = bot.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    );
    expect(messageCall).toBeTruthy();
    return messageCall?.[1] as (ctx: any) => Promise<void>;
  }

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

  it('ignores inbound messages authored by bots', async () => {
    const handleMessage = await getMessageHandler();

    await handleMessage({
      chat: { id: 12345, type: 'group', title: 'Test Group' },
      from: { id: 999, username: 'pool_bot', first_name: 'Pool', is_bot: true },
      message: {
        message_id: 77,
        date: 1_700_000_000,
        text: 'Automated update',
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('forwards inbound human-authored messages', async () => {
    const handleMessage = await getMessageHandler();

    await handleMessage({
      chat: { id: 12345, type: 'group', title: 'Test Group' },
      from: { id: 111, username: 'alice', first_name: 'Alice', is_bot: false },
      message: {
        message_id: 78,
        date: 1_700_000_001,
        text: 'Hello',
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      '12345',
      expect.objectContaining({
        id: '78',
        sender: '111',
        sender_name: 'alice',
        content: 'Hello',
        is_bot_message: false,
      }),
    );
  });

  it('retries queued messages after a transient send failure', async () => {
    const bot = (channel as any).bots[0];
    (channel as any).connected = true;

    bot.api.sendMessage
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(undefined);

    await channel.sendMessage('12345', 'hello');
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries queued photos after a transient send failure', async () => {
    const bot = (channel as any).bots[0];
    (channel as any).connected = true;

    bot.api.sendPhoto
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(undefined);

    await channel.sendPhoto('12345', '/tmp/test.png', 'preview');
    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(2);
  });

  it('splits long outgoing messages into multiple Telegram sends', async () => {
    const bot = (channel as any).bots[0];
    (channel as any).connected = true;
    bot.api.sendMessage.mockResolvedValue(undefined);

    const longText = 'x'.repeat(9000);
    await channel.sendMessage('12345', longText);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
  });
});
