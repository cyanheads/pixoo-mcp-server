/**
 * @fileoverview pixoo://reference/icons resource — built-in icon names by category.
 * @module mcp-server/resources/definitions/pixoo-icons.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getIconsByCategory, ICON_CATEGORIES, ICON_NAMES, ICONS } from '@/renderer/icons.js';

export const pixooIconsResource = resource('pixoo://reference/icons', {
  name: 'icons',
  title: 'Pixoo Icon Registry',
  description:
    'Built-in icon names organized by category (weather, arrows, status, media). Use icon names in pixoo_compose_scene elements with type "icon". Pass name to the icon element, or browse this resource to discover available names.',
  mimeType: 'application/json',
  params: z.object({}),

  handler(_params, _ctx) {
    const byCategory = getIconsByCategory();
    const iconList = ICON_NAMES.map((name) => {
      const entry = ICONS[name];
      return {
        name,
        category: entry?.category ?? 'unknown',
        viewBox: entry?.viewBox ?? '0 0 16 16',
      };
    });

    return {
      categories: ICON_CATEGORIES,
      byCategory,
      icons: iconList,
    };
  },

  list: async () => ({
    resources: [
      {
        uri: 'pixoo://reference/icons',
        name: 'icons',
        mimeType: 'application/json',
        description: 'Built-in icon names by category: weather, arrows, status, media.',
      },
    ],
  }),
});
