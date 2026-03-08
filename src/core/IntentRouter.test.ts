import { describe, expect, it } from 'vitest';

import { IntentRouter } from './IntentRouter.js';

describe('IntentRouter', () => {
  const router = new IntentRouter();

  it('accepts natural design selections', async () => {
    await expect(
      router.classify('I like the second one', 'design_selection'),
    ).resolves.toBe('select_design');
    await expect(
      router.classify('Go with option 3', 'design_selection'),
    ).resolves.toBe('select_design');
  });

  it('detects design change requests', async () => {
    await expect(
      router.classify(
        'Option 2 but make it warmer and softer',
        'design_selection',
      ),
    ).resolves.toBe('request_change');
  });

  it('detects build approval in domain phase', async () => {
    await expect(
      router.classify('Yes, build it', 'domain_check'),
    ).resolves.toBe('approve_build');
  });
});
