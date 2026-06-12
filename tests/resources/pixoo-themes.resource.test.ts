/**
 * @fileoverview Tests for the pixoo://reference/themes resource.
 * @module tests/resources/pixoo-themes.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { pixooThemesResource } from '@/mcp-server/resources/definitions/pixoo-themes.resource.js';
import { PALETTE_NAMES, THEME_NAMES } from '@/renderer/themes.js';

describe('pixooThemesResource', () => {
  it('handler returns themes, palettes, themeNames, paletteNames', async () => {
    const ctx = createMockContext();
    const params = pixooThemesResource.params.parse({});
    const result = await pixooThemesResource.handler(params, ctx);

    expect(result).toHaveProperty('themes');
    expect(result).toHaveProperty('palettes');
    expect(result).toHaveProperty('themeNames');
    expect(result).toHaveProperty('paletteNames');
  });

  it('themeNames matches the canonical THEME_NAMES list', async () => {
    const ctx = createMockContext();
    const params = pixooThemesResource.params.parse({});
    const result = await pixooThemesResource.handler(params, ctx);
    expect(result.themeNames).toEqual(THEME_NAMES);
  });

  it('paletteNames matches the canonical PALETTE_NAMES list', async () => {
    const ctx = createMockContext();
    const params = pixooThemesResource.params.parse({});
    const result = await pixooThemesResource.handler(params, ctx);
    expect(result.paletteNames).toEqual(PALETTE_NAMES);
  });

  it('themes array has one entry per theme with required fields', async () => {
    const ctx = createMockContext();
    const params = pixooThemesResource.params.parse({});
    const result = await pixooThemesResource.handler(params, ctx);

    expect(result.themes.length).toBe(THEME_NAMES.length);
    for (const t of result.themes) {
      expect(typeof t.name).toBe('string');
      expect(t).toHaveProperty('background');
      expect(typeof t.textPalette).toBe('string');
      expect(typeof t.accent).toBe('string');
      expect(typeof t.shadow).toBe('boolean');
    }
  });

  it('palettes array has one entry per palette with from/to', async () => {
    const ctx = createMockContext();
    const params = pixooThemesResource.params.parse({});
    const result = await pixooThemesResource.handler(params, ctx);

    expect(result.palettes.length).toBe(PALETTE_NAMES.length);
    for (const p of result.palettes) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.from).toBe('string');
      expect(typeof p.to).toBe('string');
    }
  });

  it('list() returns the expected URI and metadata', async () => {
    const listing = await pixooThemesResource.list!();
    expect(listing.resources.length).toBe(1);
    const r = listing.resources[0]!;
    expect(r.uri).toBe('pixoo://reference/themes');
    expect(r.name).toBe('themes');
    expect(r.mimeType).toBe('application/json');
  });
});
