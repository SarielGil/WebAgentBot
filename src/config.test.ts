import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env to avoid side effects during config import
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  BATCH_DELAY,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  TRIGGER_PATTERN,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  MAX_CONCURRENT_CONTAINERS,
  HOST_PROJECT_ROOT,
  MOUNT_ALLOWLIST_PATH,
  CONTAINER_IMAGE,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
  MEDIA_DIR,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';

describe('config constants', () => {
  describe('timing constants', () => {
    it('IDLE_TIMEOUT is a positive number', () => {
      expect(typeof IDLE_TIMEOUT).toBe('number');
      expect(IDLE_TIMEOUT).toBeGreaterThan(0);
    });

    it('BATCH_DELAY is a positive number', () => {
      expect(typeof BATCH_DELAY).toBe('number');
      expect(BATCH_DELAY).toBeGreaterThan(0);
    });

    it('POLL_INTERVAL is a positive number', () => {
      expect(typeof POLL_INTERVAL).toBe('number');
      expect(POLL_INTERVAL).toBeGreaterThan(0);
    });

    it('SCHEDULER_POLL_INTERVAL is a positive number', () => {
      expect(typeof SCHEDULER_POLL_INTERVAL).toBe('number');
      expect(SCHEDULER_POLL_INTERVAL).toBeGreaterThan(0);
    });

    it('CONTAINER_TIMEOUT is a positive number', () => {
      expect(typeof CONTAINER_TIMEOUT).toBe('number');
      expect(CONTAINER_TIMEOUT).toBeGreaterThan(0);
    });

    it('BATCH_DELAY is shorter than IDLE_TIMEOUT', () => {
      expect(BATCH_DELAY).toBeLessThan(IDLE_TIMEOUT);
    });

    it('POLL_INTERVAL is shorter than IDLE_TIMEOUT', () => {
      expect(POLL_INTERVAL).toBeLessThan(IDLE_TIMEOUT);
    });
  });

  describe('size constants', () => {
    it('CONTAINER_MAX_OUTPUT_SIZE is a positive number', () => {
      expect(typeof CONTAINER_MAX_OUTPUT_SIZE).toBe('number');
      expect(CONTAINER_MAX_OUTPUT_SIZE).toBeGreaterThan(0);
    });

    it('MAX_CONCURRENT_CONTAINERS is at least 1', () => {
      expect(MAX_CONCURRENT_CONTAINERS).toBeGreaterThanOrEqual(1);
    });
  });

  describe('path constants', () => {
    it('HOST_PROJECT_ROOT is a non-empty string', () => {
      expect(typeof HOST_PROJECT_ROOT).toBe('string');
      expect(HOST_PROJECT_ROOT.length).toBeGreaterThan(0);
    });

    it('MOUNT_ALLOWLIST_PATH contains mount-allowlist.json', () => {
      expect(MOUNT_ALLOWLIST_PATH).toContain('mount-allowlist.json');
    });

    it('MOUNT_ALLOWLIST_PATH is under .config/nanoclaw/', () => {
      expect(MOUNT_ALLOWLIST_PATH).toContain('.config/nanoclaw');
    });

    it('STORE_DIR is an absolute path', () => {
      expect(STORE_DIR.startsWith('/')).toBe(true);
    });

    it('GROUPS_DIR is an absolute path', () => {
      expect(GROUPS_DIR.startsWith('/')).toBe(true);
    });

    it('DATA_DIR is an absolute path', () => {
      expect(DATA_DIR.startsWith('/')).toBe(true);
    });

    it('MEDIA_DIR is under DATA_DIR', () => {
      expect(MEDIA_DIR.startsWith(DATA_DIR)).toBe(true);
    });
  });

  describe('string constants', () => {
    it('ASSISTANT_NAME defaults to non-empty string', () => {
      expect(typeof ASSISTANT_NAME).toBe('string');
      expect(ASSISTANT_NAME.length).toBeGreaterThan(0);
    });

    it('MAIN_GROUP_FOLDER is "main"', () => {
      expect(MAIN_GROUP_FOLDER).toBe('main');
    });

    it('CONTAINER_IMAGE is a non-empty string', () => {
      expect(typeof CONTAINER_IMAGE).toBe('string');
      expect(CONTAINER_IMAGE.length).toBeGreaterThan(0);
    });

    it('TIMEZONE is a non-empty string', () => {
      expect(typeof TIMEZONE).toBe('string');
      expect(TIMEZONE.length).toBeGreaterThan(0);
    });
  });

  describe('TRIGGER_PATTERN', () => {
    it('is a RegExp', () => {
      expect(TRIGGER_PATTERN).toBeInstanceOf(RegExp);
    });

    it('is case-insensitive', () => {
      expect(TRIGGER_PATTERN.flags).toContain('i');
    });

    it('matches @AssistantName at start of message', () => {
      const testName = ASSISTANT_NAME;
      expect(TRIGGER_PATTERN.test(`@${testName} hello`)).toBe(true);
    });

    it('does not match mid-sentence trigger', () => {
      const testName = ASSISTANT_NAME;
      // Reset lastIndex since we're reusing the regex
      TRIGGER_PATTERN.lastIndex = 0;
      expect(TRIGGER_PATTERN.test(`hello @${testName}`)).toBe(false);
    });

    it('matches case-insensitively', () => {
      const lower = `@${ASSISTANT_NAME.toLowerCase()} test`;
      const upper = `@${ASSISTANT_NAME.toUpperCase()} test`;
      TRIGGER_PATTERN.lastIndex = 0;
      const lowResult = TRIGGER_PATTERN.test(lower);
      TRIGGER_PATTERN.lastIndex = 0;
      const upResult = TRIGGER_PATTERN.test(upper);
      expect(lowResult).toBe(true);
      expect(upResult).toBe(true);
    });

    it('requires word boundary after name', () => {
      // @Andy should match, but @Andyman should not
      TRIGGER_PATTERN.lastIndex = 0;
      expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME} hi`)).toBe(true);
      TRIGGER_PATTERN.lastIndex = 0;
      expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}man hi`)).toBe(false);
    });
  });
});
