/**
 * @fileoverview Tests for the icon registry.
 * @module tests/renderer/icons.test
 */

import { describe, expect, it } from 'vitest';
import { getIconsByCategory, ICON_CATEGORIES, ICON_NAMES, ICONS } from '@/renderer/icons.js';

describe('ICONS registry', () => {
  it('has entries with name, category, d, and viewBox', () => {
    for (const [key, entry] of Object.entries(ICONS)) {
      expect(entry.name).toBe(key);
      expect(typeof entry.category).toBe('string');
      expect(typeof entry.d).toBe('string');
      expect(entry.d.length).toBeGreaterThan(0);
      expect(typeof entry.viewBox).toBe('string');
    }
  });

  it('ICON_NAMES matches ICONS keys', () => {
    expect(ICON_NAMES).toEqual(Object.keys(ICONS));
  });

  it('covers expected categories', () => {
    expect(ICON_CATEGORIES).toContain('weather');
    expect(ICON_CATEGORIES).toContain('arrows');
    expect(ICON_CATEGORIES).toContain('status');
    expect(ICON_CATEGORIES).toContain('media');
  });

  it('known icons resolve correctly', () => {
    expect(ICONS['sun']).toBeDefined();
    expect(ICONS['check-circle']).toBeDefined();
    expect(ICONS['play']).toBeDefined();
    expect(ICONS['arrow-up']).toBeDefined();
  });

  it('unknown icon name returns undefined (no silent fallback)', () => {
    expect(ICONS['not-a-real-icon']).toBeUndefined();
  });
});

describe('getIconsByCategory', () => {
  it('groups all icons by category', () => {
    const byCategory = getIconsByCategory();
    const allNames = Object.values(byCategory).flat();
    expect(allNames.sort()).toEqual([...ICON_NAMES].sort());
  });

  it('each category entry is an array of strings', () => {
    const byCategory = getIconsByCategory();
    for (const [, names] of Object.entries(byCategory)) {
      expect(Array.isArray(names)).toBe(true);
      for (const n of names) {
        expect(typeof n).toBe('string');
      }
    }
  });

  it('weather category contains sun and cloud', () => {
    const byCategory = getIconsByCategory();
    expect(byCategory['weather']).toContain('sun');
    expect(byCategory['weather']).toContain('cloud');
  });

  it('icons in byCategory match actual ICONS entries', () => {
    const byCategory = getIconsByCategory();
    for (const [cat, names] of Object.entries(byCategory)) {
      for (const n of names) {
        expect(ICONS[n]?.category).toBe(cat);
      }
    }
  });
});
