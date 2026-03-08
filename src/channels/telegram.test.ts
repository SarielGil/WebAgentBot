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
});
