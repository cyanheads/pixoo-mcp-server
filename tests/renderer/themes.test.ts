/**
 * @fileoverview Tests for theme and palette registry.
 * @module tests/renderer/themes.test
 */

import { describe, expect, it } from 'vitest';
import {
  PALETTE_NAMES,
  PALETTES,
  type PaletteName,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from '@/renderer/themes.js';

describe('PALETTES', () => {
  it('contains all named palettes', () => {
    for (const name of PALETTE_NAMES) {
      expect(PALETTES).toHaveProperty(name);
    }
  });

  it('each palette has from and to color strings', () => {
    for (const name of PALETTE_NAMES) {
      const p = PALETTES[name as PaletteName];
      expect(typeof p.from).toBe('string');
      expect(typeof p.to).toBe('string');
    }
  });

  it('mono palette has identical from/to (single color)', () => {
    expect(PALETTES.mono.from).toBe(PALETTES.mono.to);
  });

  it('PALETTE_NAMES length matches PALETTES keys', () => {
    expect(PALETTE_NAMES.length).toBe(Object.keys(PALETTES).length);
  });
});

describe('THEMES', () => {
  it('contains all named themes', () => {
    for (const name of THEME_NAMES) {
      expect(THEMES).toHaveProperty(name);
    }
  });

  it('each theme has required fields', () => {
    for (const name of THEME_NAMES) {
      const t = THEMES[name as ThemeName];
      expect(t).toHaveProperty('accent');
      expect(t).toHaveProperty('background');
      expect(t).toHaveProperty('textPalette');
      expect(typeof t.shadow).toBe('boolean');
    }
  });

  it('theme textPalette names are valid palettes', () => {
    for (const name of THEME_NAMES) {
      const t = THEMES[name as ThemeName];
      expect(PALETTE_NAMES).toContain(t.textPalette);
    }
  });

  it('midnight theme uses gradient background', () => {
    expect(THEMES.midnight.background.type).toBe('gradient-v');
  });

  it('mono theme uses solid background', () => {
    expect(THEMES.mono.background.type).toBe('solid');
  });

  it('unknown theme name is not in registry (no silent fallback)', () => {
    expect((THEMES as Record<string, unknown>)['notreal']).toBeUndefined();
  });
});
