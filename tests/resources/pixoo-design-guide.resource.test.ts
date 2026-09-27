/**
 * @fileoverview Tests for the pixoo://reference/design-guide resource.
 * @module tests/resources/pixoo-design-guide.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { pixooDesignGuideResource } from '@/mcp-server/resources/definitions/pixoo-design-guide.resource.js';
import { listExtra } from '../helpers/list-extra.js';

describe('pixooDesignGuideResource', () => {
  const guide = () =>
    pixooDesignGuideResource.handler(
      pixooDesignGuideResource.params!.parse({}),
      createMockContext(),
    ) as string;

  it('returns the guide as markdown', () => {
    expect(pixooDesignGuideResource.mimeType).toBe('text/markdown');
    expect(guide()).toMatch(/^# Pixoo Display Design Guide/);
  });

  it('Known Device Behaviors carries the measured panel response', () => {
    const known = guide().split('## Known Device Behaviors')[1] ?? '';
    expect(known).toContain('brightness 100, channel levels 0–4 stay dark');
    expect(known).toContain('mid-levels render darker than on an sRGB monitor');
    expect(known).toContain('`#D97757` reads red');
    expect(guide()).not.toContain('#202020');
  });

  it('Font choices name the numerals face and the symbols beyond ASCII', () => {
    const legibility = guide().split('## Legibility Floors')[1]?.split('## ')[0] ?? '';
    expect(legibility).toContain('Numerals (11×18)');
    expect(legibility).toContain('0–9, space, and `: . - + / % ° ?`');
    expect(legibility).toContain('`° ← ↑ → ↓ ▲ ▼ ♥ · …`');
  });

  it('lists itself', async () => {
    const listing = await pixooDesignGuideResource.list!(listExtra());
    expect(listing.resources).toEqual([
      expect.objectContaining({ uri: 'pixoo://reference/design-guide', mimeType: 'text/markdown' }),
    ]);
  });
});
