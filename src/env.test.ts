import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Store original env
const originalEnv = { ...process.env };

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// We'll control fs.readFileSync dynamically
let mockFileContent: string | null = null;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((...args: unknown[]) => {
        // Only intercept .env reads
        const filePath = args[0] as string;
        if (filePath.endsWith('.env')) {
          if (mockFileContent === null) {
            throw new Error('ENOENT: no such file or directory');
          }
          return mockFileContent;
        }
        return actual.readFileSync(
          filePath as string,
          args[1] as BufferEncoding,
        );
      }),
    },
  };
});

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  beforeEach(() => {
    // Clear process.env additions from previous tests
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    mockFileContent = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when .env file exists', () => {
    it('parses simple KEY=VALUE pairs', () => {
      mockFileContent = 'API_KEY=abc123\nSECRET=xyz';
      const result = readEnvFile(['API_KEY', 'SECRET']);
      expect(result).toEqual({ API_KEY: 'abc123', SECRET: 'xyz' });
    });

    it('only returns requested keys', () => {
      mockFileContent = 'API_KEY=abc123\nSECRET=xyz\nOTHER=skip';
      const result = readEnvFile(['API_KEY']);
      expect(result).toEqual({ API_KEY: 'abc123' });
      expect(result).not.toHaveProperty('SECRET');
      expect(result).not.toHaveProperty('OTHER');
    });

    it('strips double quotes from values', () => {
      mockFileContent = 'API_KEY="quoted-value"';
      const result = readEnvFile(['API_KEY']);
      expect(result.API_KEY).toBe('quoted-value');
    });

    it('strips single quotes from values', () => {
      mockFileContent = "API_KEY='single-quoted'";
      const result = readEnvFile(['API_KEY']);
      expect(result.API_KEY).toBe('single-quoted');
    });

    it('ignores comments', () => {
      mockFileContent = '# This is a comment\nAPI_KEY=value\n# Another comment';
      const result = readEnvFile(['API_KEY']);
      expect(result).toEqual({ API_KEY: 'value' });
    });

    it('ignores blank lines', () => {
      mockFileContent = '\nAPI_KEY=value\n\n\nSECRET=val2\n';
      const result = readEnvFile(['API_KEY', 'SECRET']);
      expect(result).toEqual({ API_KEY: 'value', SECRET: 'val2' });
    });

    it('ignores lines without = sign', () => {
      mockFileContent = 'INVALID_LINE\nAPI_KEY=value';
      const result = readEnvFile(['API_KEY', 'INVALID_LINE']);
      expect(result).toEqual({ API_KEY: 'value' });
    });

    it('handles values with = signs inside', () => {
      mockFileContent = 'API_KEY=abc=def=ghi';
      const result = readEnvFile(['API_KEY']);
      expect(result.API_KEY).toBe('abc=def=ghi');
    });

    it('trims whitespace around keys and values', () => {
      mockFileContent = '  API_KEY  =  value  ';
      const result = readEnvFile(['API_KEY']);
      expect(result.API_KEY).toBe('value');
    });

    it('skips empty values', () => {
      mockFileContent = 'API_KEY=\nSECRET=real';
      const result = readEnvFile(['API_KEY', 'SECRET']);
      expect(result).toEqual({ SECRET: 'real' });
      expect(result).not.toHaveProperty('API_KEY');
    });

    it('falls back to process.env for keys missing from file', () => {
      mockFileContent = 'API_KEY=from-file';
      process.env.SECRET = 'from-env';
      const result = readEnvFile(['API_KEY', 'SECRET']);
      expect(result.API_KEY).toBe('from-file');
      expect(result.SECRET).toBe('from-env');
      delete process.env.SECRET;
    });

    it('file values take precedence over process.env', () => {
      mockFileContent = 'API_KEY=from-file';
      process.env.API_KEY = 'from-env';
      const result = readEnvFile(['API_KEY']);
      expect(result.API_KEY).toBe('from-file');
      delete process.env.API_KEY;
    });

    it('returns empty object when no requested keys match', () => {
      mockFileContent = 'OTHER=value';
      const result = readEnvFile(['API_KEY']);
      expect(result).toEqual({});
    });

    it('returns empty object for empty requested keys array', () => {
      mockFileContent = 'API_KEY=value';
      const result = readEnvFile([]);
      expect(result).toEqual({});
    });
  });

  describe('when .env file does not exist', () => {
    it('falls back entirely to process.env', () => {
      mockFileContent = null; // triggers ENOENT
      process.env.API_KEY = 'env-value';
      process.env.SECRET = 'env-secret';
      const result = readEnvFile(['API_KEY', 'SECRET']);
      expect(result.API_KEY).toBe('env-value');
      expect(result.SECRET).toBe('env-secret');
      delete process.env.API_KEY;
      delete process.env.SECRET;
    });

    it('returns empty object when process.env has no matching keys', () => {
      mockFileContent = null;
      const result = readEnvFile(['NONEXISTENT_KEY']);
      expect(result).toEqual({});
    });
  });
});
