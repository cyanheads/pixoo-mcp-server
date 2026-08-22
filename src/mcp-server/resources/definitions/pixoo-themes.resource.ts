/**
 * @fileoverview pixoo://reference/themes resource — theme and palette registry.
 * @module mcp-server/resources/definitions/pixoo-themes.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { PALETTE_NAMES, PALETTES, THEME_NAMES, THEMES } from '@/renderer/themes.js';

/** Mirrors the toolkit's `ColorLike` union: hex/named string, packed integer, or RGB triple. */
const ColorValueSchema = z
  .union([
    z.string().describe('CSS hex string (#RRGGBB) or a named color.'),
    z.number().describe('Packed 24-bit RGB integer.'),
    z
      .tuple([
        z.number().describe('Red channel 0–255.'),
        z.number().describe('Green channel 0–255.'),
        z.number().describe('Blue channel 0–255.'),
      ])
      .readonly()
      .describe('Explicit RGB channel triple.'),
  ])
  .describe('A resolvable color value.');

export const pixooThemesResource = resource('pixoo://reference/themes', {
  name: 'themes',
  title: 'Pixoo Themes & Palettes',
  description:
    'Theme and palette registry with background gradients, default text palettes, accent colors, and swatch values. Use theme names in pixoo_display_text and pixoo_compose_scene.',
  mimeType: 'application/json',
  params: z.object({}),
  // Compile-time constants — safe for a shared cache to hold for a day.
  cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },

  output: z.object({
    themes: z
      .array(
        z
          .object({
            name: z.string().describe('Theme name, usable as the `theme` argument.'),
            background: z
              .discriminatedUnion('type', [
                z
                  .object({
                    type: z.literal('gradient-v').describe('Vertical gradient background.'),
                    from: ColorValueSchema.describe('Gradient start color (top).'),
                    to: ColorValueSchema.describe('Gradient end color (bottom).'),
                  })
                  .describe('Vertical gradient background.'),
                z
                  .object({
                    type: z.literal('solid').describe('Solid fill background.'),
                    color: ColorValueSchema.describe('Fill color.'),
                  })
                  .describe('Solid background.'),
              ])
              .describe('Background fill applied by the theme.'),
            textPalette: z.string().describe('Default text palette name for this theme.'),
            accent: ColorValueSchema.describe('Accent color for icons and highlights.'),
            shadow: z.boolean().describe('True when the theme enables a text drop shadow.'),
          })
          .describe('A named scene theme.'),
      )
      .describe('All registered themes with background, palette, and accent settings.'),
    palettes: z
      .array(
        z
          .object({
            name: z.string().describe('Palette name, usable as the `palette` argument.'),
            from: ColorValueSchema.describe('Ramp start color (top).'),
            to: ColorValueSchema.describe('Ramp end color (bottom).'),
          })
          .describe('A named vertical color ramp.'),
      )
      .describe('All registered palettes as gradient stop pairs.'),
    themeNames: z.array(z.string()).describe('Theme names in registry order.'),
    paletteNames: z.array(z.string()).describe('Palette names in registry order.'),
  }),

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
