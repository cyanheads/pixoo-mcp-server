/**
 * @fileoverview Icon drawing: an icon's SVG paths in one color, or as a top-to-bottom
 * palette ramp, placed the way a scene `icon` element places them. Browser-safe: it imports
 * the toolkit's `/core` entry, never the main barrel (which loads `sharp`), so a page bundle
 * can carry it.
 * @module renderer/icon-draw
 */

import {
  Canvas,
  lerpColor,
  type RGB,
  renderSvgPath,
  resolveColor,
} from '@cyanheads/pixoo-toolkit/core';
import type { IconPaths } from './icons.js';
import { resolveX, resolveY, type SemanticX, type SemanticY } from './text-engine.js';
import type { GradientStop } from './themes.js';

/** Size and ink of a placed icon — a scene `icon` element's, or `pixoo.icon`'s options. */
export interface IconLook {
  /** Ink color (default white). Resolved even under a palette, so a bad one still throws. */
  color?: string | undefined;
  /** Render height in pixels (default 12). */
  h?: number | undefined;
  /** Gradient stop that ramps the icon top to bottom in place of `color`. */
  palette?: GradientStop | undefined;
  /** Render width in pixels (default 12). */
  w?: number | undefined;
}

/**
 * Draw an icon placed the way a scene `icon` element places it: `w`/`h` default to 12,
 * `x`/`y` (default 0) resolve against the canvas for that size, then shift by `dx`/`dy`,
 * and `viewBox` (`"minX minY W H"`, W and H defaulting to 16) scales the paths into the
 * box. A palette ramps the icon top to bottom; otherwise it draws in `color`. The scene
 * renderer and the `pixoo` page runtime both place icons here. Returns the drawn box.
 */
export function drawPlacedIcon(
  canvas: Canvas,
  paths: IconPaths,
  viewBox: string,
  x: SemanticX = 0,
  y: SemanticY = 0,
  { w = 12, h = 12, color, palette }: IconLook = {},
  dx = 0,
  dy = 0,
): { x: number; y: number; w: number; h: number } {
  const px = resolveX(x, w, canvas.width, dx);
  const py = resolveY(y, h, canvas.height, dy);
  const rgb: RGB = color ? resolveColor(color) : [255, 255, 255];
  const vbParts = viewBox.split(/\s+/).map(Number);
  const svgViewBox: [number, number] = [vbParts[2] ?? 16, vbParts[3] ?? 16];
  const targetRect: [number, number, number, number] = [px, py, w, h];
  if (palette) {
    renderIconRamp(canvas, paths, svgViewBox, targetRect, palette);
  } else {
    drawIconPaths(canvas, paths, rgb, svgViewBox, targetRect);
  }
  return { x: px, y: py, w, h };
}

/** Draw an icon's filled parts, then its stroked parts, in one color. */
function drawIconPaths(
  canvas: Canvas,
  paths: IconPaths,
  color: RGB,
  svgViewBox: [number, number],
  targetRect: [number, number, number, number],
): void {
  if (paths.fill) renderSvgPath(canvas, paths.fill, color, svgViewBox, targetRect);
  if (paths.stroke) {
    renderSvgPath(canvas, paths.stroke, color, svgViewBox, targetRect, { mode: 'stroke' });
  }
}

/**
 * Render an icon as a top-to-bottom ramp, the way a text palette paints glyphs: the icon's
 * top ink row takes `stop.from`, its bottom ink row `stop.to`, and each row between takes
 * its even step. Only ink that lands on the canvas counts, so an icon clipped by an edge
 * ramps across the rows still visible.
 */
function renderIconRamp(
  canvas: Canvas,
  paths: IconPaths,
  svgViewBox: [number, number],
  targetRect: [number, number, number, number],
  stop: GradientStop,
): void {
  const mask = new Canvas(canvas.width);
  drawIconPaths(mask, paths, [255, 255, 255], svgViewBox, targetRect);
  const inkAt = (x: number, y: number) => mask.getPixelRgba(x, y)[3] > 0;

  const rows: number[] = [];
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (inkAt(x, y)) {
        rows.push(y);
        break;
      }
    }
  }
  const top = rows[0];
  const bottom = rows.at(-1);
  if (top === undefined || bottom === undefined) return;

  const from = resolveColor(stop.from);
  const to = resolveColor(stop.to);
  for (const y of rows) {
    const color = lerpColor(from, to, bottom === top ? 0 : (y - top) / (bottom - top));
    for (let x = 0; x < mask.width; x++) {
      if (inkAt(x, y)) canvas.setPixel(x, y, color);
    }
  }
}
