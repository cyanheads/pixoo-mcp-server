/**
 * @fileoverview Tests for the pixoo://reference/icons resource.
 * @module tests/resources/pixoo-icons.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { pixooIconsResource } from '@/mcp-server/resources/definitions/pixoo-icons.resource.js';
import { ICON_CATEGORIES, ICON_NAMES } from '@/renderer/icons.js';

describe('pixooIconsResource', () => {
  it('handler returns categories, byCategory, and icons', async () => {
    const ctx = createMockContext();
    const params = pixooIconsResource.params.parse({});
    const result = await pixooIconsResource.handler(params, ctx);

    expect(result).toHaveProperty('categories');
    expect(result).toHaveProperty('byCategory');
    expect(result).toHaveProperty('icons');
  });

  it('categories list matches ICON_CATEGORIES', async () => {
    const ctx = createMockContext();
    const params = pixooIconsResource.params.parse({});
    const result = await pixooIconsResource.handler(params, ctx);
    expect(result.categories).toEqual(ICON_CATEGORIES);
  });

  it('icons array has one entry per icon name', async () => {
    const ctx = createMockContext();
    const params = pixooIconsResource.params.parse({});
    const result = await pixooIconsResource.handler(params, ctx);
    expect(result.icons.length).toBe(ICON_NAMES.length);
  });

  it('each icon entry has name, category, and viewBox', async () => {
    const ctx = createMockContext();
    const params = pixooIconsResource.params.parse({});
    const result = await pixooIconsResource.handler(params, ctx);

    for (const icon of result.icons) {
      expect(typeof icon.name).toBe('string');
      expect(typeof icon.category).toBe('string');
      expect(typeof icon.viewBox).toBe('string');
    }
  });

  it('byCategory groups all icons without loss', async () => {
    const ctx = createMockContext();
    const params = pixooIconsResource.params.parse({});
    const result = await pixooIconsResource.handler(params, ctx);

    const allFromByCategory = Object.values(result.byCategory).flat();
    expect(allFromByCategory.sort()).toEqual([...ICON_NAMES].sort());
  });

  it('list() returns the expected URI and metadata', async () => {
    const listing = await pixooIconsResource.list!();
    expect(listing.resources.length).toBe(1);
    const r = listing.resources[0]!;
    expect(r.uri).toBe('pixoo://reference/icons');
    expect(r.name).toBe('icons');
    expect(r.mimeType).toBe('application/json');
  });
});
