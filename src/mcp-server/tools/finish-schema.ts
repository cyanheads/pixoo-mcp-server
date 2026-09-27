/**
 * @fileoverview The `finish` input shared by tools that render an image: reduce it to a
 * palette, with optional dithering, before it reaches the panel. Applied by
 * `renderer/finish`.
 * @module mcp-server/tools/finish-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

const DitherSchema = z
  .enum(['none', 'bayer4', 'floyd-steinberg'])
  .default('none')
  .describe(
    'How palette colors are placed: none maps each pixel to its nearest color; bayer4 mixes the two nearest in an ordered 4×4 pattern; floyd-steinberg diffuses the difference to neighboring pixels, smoothest on photos.',
  );

/**
 * Exactly one of `colors` or `palette`, plus `dither` — a union of two closed objects,
 * so each branch advertises its own required field and a call naming both, or neither,
 * fails validation.
 */
export const FinishSchema = z
  .union([
    z
      .strictObject({
        colors: z
          .number()
          .int()
          .min(2)
          .max(256)
          .describe('Build a palette of at most this many colors (2–256) from the image itself.'),
        dither: DitherSchema,
      })
      .describe('Reduce to a palette built from the image.'),
    z
      .strictObject({
        palette: z
          .array(z.string().describe('Hex color (#RRGGBB or #RGB) or a named color.'))
          .min(1)
          .max(256)
          .describe('Map every pixel to these colors (1–256 entries).'),
        dither: DitherSchema,
      })
      .describe('Reduce to a fixed palette.'),
  ])
  .describe(
    'Reduce the image to a palette before it reaches the panel: exactly one of colors (2–256, built from the image) or palette (1–256 hex or named colors), plus dither. Transparent pixels stay unlit and are not counted. The preview shows the finished frame.',
  );
