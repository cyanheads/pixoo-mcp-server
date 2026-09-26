/**
 * @fileoverview Pixel probes over a rendered canvas — a content hash, the rows that hold
 * ink, and the colors a row holds. "Ink" is any drawn pixel: alpha above 0 and, when a
 * background color is given, a color other than that background.
 * @module tests/helpers/canvas-ink
 */

import { createHash } from 'node:crypto';
import type { Canvas, RGB } from '@cyanheads/pixoo-toolkit';

/** SHA-256 of a canvas's RGBA bytes. */
export function hashOf(canvas: Canvas): string {
  return createHash('sha256').update(Buffer.from(canvas.buffer)).digest('hex');
}

/** Whether the pixel at (`x`, `y`) holds ink. */
export function isInk(canvas: Canvas, x: number, y: number, background?: RGB): boolean {
  const [r, g, b, a] = canvas.getPixelRgba(x, y);
  if (a === 0) return false;
  return !background || r !== background[0] || g !== background[1] || b !== background[2];
}

/** Every row of `canvas` holding at least one ink pixel, top to bottom. */
export function inkRows(canvas: Canvas, background?: RGB): number[] {
  const rows: number[] = [];
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (isInk(canvas, x, y, background)) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

/** Every ink pixel of `canvas` as `x,y`, row by row — equal lists mean equal ink shapes. */
export function inkPixels(canvas: Canvas, background?: RGB): string[] {
  const pixels: string[] = [];
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (isInk(canvas, x, y, background)) pixels.push(`${x},${y}`);
    }
  }
  return pixels;
}

/**
 * The distinct colors of the ink pixels in row `y` — or across the whole canvas when
 * `y` is omitted — as `[r, g, b]` tuples in first-seen order.
 */
export function inkColors(canvas: Canvas, y?: number, background?: RGB): RGB[] {
  const seen = new Map<string, RGB>();
  const rows = y === undefined ? inkRows(canvas, background) : [y];
  for (const row of rows) {
    for (let x = 0; x < canvas.width; x++) {
      if (!isInk(canvas, x, row, background)) continue;
      const [r, g, b] = canvas.getPixelRgba(x, row);
      seen.set(`${r},${g},${b}`, [r, g, b]);
    }
  }
  return [...seen.values()];
}
