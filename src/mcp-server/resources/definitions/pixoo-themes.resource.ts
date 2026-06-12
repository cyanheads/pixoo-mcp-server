/**
 * @fileoverview pixoo://reference/themes resource — theme and palette registry.
 * @module mcp-server/resources/definitions/pixoo-themes.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { PALETTE_NAMES, PALETTES, THEME_NAMES, THEMES } from '@/renderer/themes.js';

export const pixooThemesResource = resource('pixoo://reference/themes', {
  name: 'themes',
  title: 'Pixoo Themes & Palettes',
  description:
    'Theme and palette registry with background gradients, default text palettes, accent colors, and swatch values. Use theme names in pixoo_display_text and pixoo_compose_scene.',
  mimeType: 'application/json',
  params: z.object({}),

  handler(_params, _ctx) {
    const themes = Object.entries(THEMES).map(([name, def]) => ({
      name,
      background: def.background,
      textPalette: def.textPalette,
      accent: def.accent,
      shadow: def.shadow,
    }));

    const palettes = Object.entries(PALETTES).map(([name, stop]) => ({
      name,
      from: stop.from,
      to: stop.to,
    }));

    return {
      themes,
      palettes,
      themeNames: THEME_NAMES,
      paletteNames: PALETTE_NAMES,
    };
  },

  list: async () => ({
    resources: [
      {
        uri: 'pixoo://reference/themes',
        name: 'themes',
        mimeType: 'application/json',
        description:
          'Theme and palette registry: background gradients, text palettes, accent colors.',
      },
    ],
  }),
});
