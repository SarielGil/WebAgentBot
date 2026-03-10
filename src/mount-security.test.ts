import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

// Mock config
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/.config/nanoclaw/mount-allowlist.json',
}));

// Mock logger
vi.mock('./logger.js');
vi.mock('pino', () => ({
  default: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Use vi.hoisted so variables are available inside vi.mock factories
const { mockFsExistsSync, mockFsReadFileSync, mockFsRealpathSync } = vi.hoisted(
  () => ({
    mockFsExistsSync: vi.fn(() => false) as ReturnType<typeof vi.fn>,
    mockFsReadFileSync: vi.fn(() => '{}') as ReturnType<typeof vi.fn>,
    mockFsRealpathSync: vi.fn((p: string) => p) as ReturnType<typeof vi.fn>,
  }),
);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockFsExistsSync,
      readFileSync: mockFsReadFileSync,
      realpathSync: mockFsRealpathSync,
    },
  };
});

// Must import AFTER mocks so vi.mock hoisting takes effect
import {
  loadMountAllowlist,
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
} from './mount-security.js';

// Helper to reset the cached allowlist between tests
// The module caches the allowlist, so we need to re-import for each test.
// Since vitest caches modules, we'll need to use resetModules().
describe('mount-security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('generateAllowlistTemplate', () => {
    it('returns valid JSON string', () => {
      const template = generateAllowlistTemplate();
      const parsed = JSON.parse(template);
      expect(parsed).toHaveProperty('allowedRoots');
      expect(parsed).toHaveProperty('blockedPatterns');
      expect(parsed).toHaveProperty('nonMainReadOnly');
    });

    it('contains example allowed roots', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(parsed.allowedRoots).toBeInstanceOf(Array);
      expect(parsed.allowedRoots.length).toBeGreaterThan(0);
      expect(parsed.allowedRoots[0]).toHaveProperty('path');
      expect(parsed.allowedRoots[0]).toHaveProperty('allowReadWrite');
    });

    it('nonMainReadOnly defaults to true', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(parsed.nonMainReadOnly).toBe(true);
    });

    it('includes additional blocked patterns', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(parsed.blockedPatterns).toContain('password');
      expect(parsed.blockedPatterns).toContain('secret');
      expect(parsed.blockedPatterns).toContain('token');
    });
  });

  describe('validateMount — container path validation', () => {
    // These tests exercise isValidContainerPath indirectly via validateMount.
    // We need the allowlist to be loaded for these tests, so we set up a
    // valid allowlist that the mount can match against.

    function setupValidAllowlist() {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('mount-allowlist')) return true;
        return true; // host paths exist
      });
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);
    }

    it('rejects container path with .. traversal', async () => {
      // Re-import to clear allowlist cache
      const mod = await import('./mount-security.js');
      setupValidAllowlist();

      const result = mod.validateMount(
        { hostPath: '/home/user/projects/repo', containerPath: '../escape' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects absolute container path', async () => {
      const mod = await import('./mount-security.js');
      setupValidAllowlist();

      const result = mod.validateMount(
        {
          hostPath: '/home/user/projects/repo',
          containerPath: '/absolute/path',
        },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('relative');
    });

    it('rejects empty container path', async () => {
      const mod = await import('./mount-security.js');
      setupValidAllowlist();

      const result = mod.validateMount(
        { hostPath: '/home/user/projects/repo', containerPath: '  ' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('non-empty');
    });
  });

  describe('validateMount — blocked patterns', () => {
    it('blocks .ssh paths', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        { hostPath: '/home/user/.ssh/id_rsa' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked pattern');
    });

    it('blocks .env paths', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        { hostPath: '/home/user/project/.env' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked pattern');
    });

    it('blocks paths containing credentials', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        { hostPath: '/home/user/.aws/credentials' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked pattern');
    });
  });

  describe('validateMount — no allowlist', () => {
    it('blocks all mounts when allowlist file missing', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(false);

      const result = mod.validateMount(
        { hostPath: '/home/user/projects/repo' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No mount allowlist');
    });
  });

  describe('validateMount — host path validation', () => {
    it('rejects nonexistent host path', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('mount-allowlist')) return true;
        return false;
      });
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => {
        if (!p.includes('mount-allowlist')) {
          throw new Error('ENOENT');
        }
        return p;
      });

      const result = mod.validateMount(
        { hostPath: '/home/user/nonexistent' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not exist');
    });
  });

  describe('validateMount — allowed roots', () => {
    it('allows path under allowed root', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        { hostPath: '/home/user/projects/my-repo', containerPath: 'my-repo' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true); // default is readonly
    });

    it('rejects path outside all allowed roots', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        { hostPath: '/etc/passwd', containerPath: 'passwd' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not under any allowed root');
    });
  });

  describe('validateMount — readonly enforcement', () => {
    it('forces readonly for non-main when nonMainReadOnly is true', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: true,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        {
          hostPath: '/home/user/projects/repo',
          containerPath: 'repo',
          readonly: false,
        },
        false, // not main
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('allows read-write for main group when root allows it', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: true,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        {
          hostPath: '/home/user/projects/repo',
          containerPath: 'repo',
          readonly: false,
        },
        true, // main
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces readonly when root does not allow read-write', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [
            { path: '/home/user/projects', allowReadWrite: false },
          ],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateMount(
        {
          hostPath: '/home/user/projects/repo',
          containerPath: 'repo',
          readonly: false,
        },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });
  });

  describe('validateAdditionalMounts', () => {
    it('returns validated mounts with /workspace/extra/ prefix', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateAdditionalMounts(
        [
          {
            hostPath: '/home/user/projects/repo',
            containerPath: 'repo',
          },
        ],
        'test-group',
        true,
      );

      expect(result).toHaveLength(1);
      expect(result[0].containerPath).toBe('/workspace/extra/repo');
      expect(result[0].hostPath).toBe('/home/user/projects/repo');
    });

    it('filters out rejected mounts', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      mockFsRealpathSync.mockImplementation((p: string) => p);

      const result = mod.validateAdditionalMounts(
        [
          {
            hostPath: '/home/user/projects/valid-repo',
            containerPath: 'valid',
          },
          {
            hostPath: '/etc/shadow',
            containerPath: 'shadow',
          },
        ],
        'test-group',
        true,
      );

      expect(result).toHaveLength(1);
      expect(result[0].containerPath).toBe('/workspace/extra/valid');
    });

    it('returns empty array when all mounts rejected', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(false); // no allowlist

      const result = mod.validateAdditionalMounts(
        [{ hostPath: '/some/path', containerPath: 'path' }],
        'test-group',
        true,
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('loadMountAllowlist — validation', () => {
    it('rejects allowlist with invalid allowedRoots', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: 'not-an-array',
          blockedPatterns: [],
          nonMainReadOnly: true,
        }),
      );

      const result = mod.loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('rejects allowlist with invalid blockedPatterns', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: 'not-an-array',
          nonMainReadOnly: true,
        }),
      );

      const result = mod.loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('rejects allowlist with non-boolean nonMainReadOnly', async () => {
      const mod = await import('./mount-security.js');

      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: [],
          nonMainReadOnly: 'yes',
        }),
      );

      const result = mod.loadMountAllowlist();
      expect(result).toBeNull();
    });
  });
});
