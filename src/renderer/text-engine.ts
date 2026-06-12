/**
 * @fileoverview Styled text engine: gradient ramps, shadow, outline, scale, overflow handling.
 * @module renderer/text-engine
 */

import {
  Canvas,
  type ColorLike,
  drawText,
  FONT_3x5,
  FONT_5x7,
  lerpColor,
  measureText,
  type RGB,
  resolveColor,
} from '@cyanheads/pixoo-toolkit';
import { type GradientStop, PALETTES, type PaletteName } from './themes.js';

/** Text style options for the styled text engine. */
export interface TextStyle {
  /** Explicit color when not using palette. */
  color?: ColorLike;
  /** 1px contrasting outline for legibility. */
  outline?: boolean;
  /** Named palette or custom gradient stop. */
  palette?: PaletteName | GradientStop;
  /** Integer pixel scale multiplier (default 1). */
  scale?: number;
  /** Drop shadow behind the text. */
  shadow?: boolean;
}

/** Font size variant. */
export type FontVariant = 'standard' | 'compact';

/** Overflow/fit mode for text rendering. */
export type OverflowMode = 'auto' | 'shrink' | 'scroll' | 'wrap' | 'truncate';

/** Layout report entry. */
export interface LayoutEntry {
  action: 'none' | 'shrunk-to-compact' | 'scrolling' | 'wrapped' | 'truncated' | 'clipped';
  box: { x: number; y: number; w: number; h: number };
  element: number | 'background';
  fits: boolean;
  font?: FontVariant;
  scale?: number;
  type: string;
}

/** Semantic alignment for x/y positioning. */
export type SemanticX = number | 'left' | 'center' | 'right';
export type SemanticY = number | 'top' | 'center' | 'bottom';

/** Resolve semantic x to a pixel coordinate. */
export function resolveX(x: SemanticX, contentWidth: number, canvasWidth: number, dx = 0): number {
  let px: number;
  if (x === 'left') px = 0;
  else if (x === 'right') px = canvasWidth - contentWidth;
  else if (x === 'center') px = Math.floor((canvasWidth - contentWidth) / 2);
  else px = x;
  return px + dx;
}

/** Resolve semantic y to a pixel coordinate. */
export function resolveY(
  y: SemanticY,
  contentHeight: number,
  canvasHeight: number,
  dy = 0,
): number {
  let py: number;
  if (y === 'top') py = 0;
  else if (y === 'bottom') py = canvasHeight - contentHeight;
  else if (y === 'center') py = Math.floor((canvasHeight - contentHeight) / 2);
  else py = y;
  return py + dy;
}

/** Get gradient ramp colors from a palette or explicit stop. */
function getPaletteColors(
  palette: PaletteName | GradientStop | undefined,
  color: ColorLike | undefined,
  rows: number,
): RGB[] {
  if (palette) {
    const stop: GradientStop =
      typeof palette === 'string'
        ? (PALETTES[palette] ?? { from: '#ffffff', to: '#ffffff' })
        : palette;
    const fromColor = resolveColor(stop.from);
    const toColor = resolveColor(stop.to);
    return Array.from({ length: rows }, (_, i) =>
      lerpColor(fromColor, toColor, rows <= 1 ? 0 : i / (rows - 1)),
    );
  }
  if (color) {
    const c = resolveColor(color);
    return Array.from({ length: rows }, () => c);
  }
  return Array.from({ length: rows }, () => [255, 255, 255] as RGB);
}

/**
 * Draw styled text onto a canvas using gradient ramp per-row.
 * Returns the bounding box of the rendered text.
 */
export function drawStyledText(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
  fontVariant: FontVariant = 'standard',
): { x: number; y: number; w: number; h: number } {
  const font = fontVariant === 'compact' ? FONT_3x5 : FONT_5x7;
  const scale = style.scale ?? 1;
  const textOpts = { font, scale };

  const w = measureText(text, textOpts);
  const h = font.height * scale;

  // Shadow pass
  if (style.shadow) {
    const shadowColor: RGB = [20, 15, 10]; // dark tinted
    drawText(canvas, text, x + 1, y + 1, shadowColor, textOpts);
  }

  // Outline pass (draw 8 neighbors)
  if (style.outline) {
    const bgColor: RGB = [0, 0, 0];
    // Simple outline: draw text shifted in each cardinal + diagonal direction
    for (const [ox, oy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ] as [number, number][]) {
      drawText(canvas, text, x + ox, y + oy, bgColor, textOpts);
    }
  }

  // Main text: draw row-by-row with gradient colors
  const colors = getPaletteColors(style.palette, style.color, h);

  // For gradient ramp, draw the text per-row by using a scratch canvas and blitting
  if (style.palette && h > 1) {
    const scratch = new Canvas(canvas.width as 16 | 32 | 64);
    drawText(scratch, text, x, y, [255, 255, 255], textOpts);

    // Apply gradient by coloring each row's pixels
    for (let row = 0; row < h; row++) {
      const rowColor = (colors[row] ?? colors[colors.length - 1]) as RGB;
      for (let col = x; col < x + w; col++) {
        const pixel = scratch.getPixelRgba(col, y + row);
        if (pixel[3] > 0) {
          // tint white pixels with the row color
          const tinted: RGB = [
            Math.round((pixel[0] / 255) * rowColor[0]),
            Math.round((pixel[1] / 255) * rowColor[1]),
            Math.round((pixel[2] / 255) * rowColor[2]),
          ];
          canvas.setPixel(col, y + row, tinted);
        }
      }
    }
  } else {
    // Flat color or single row
    const flatColor = colors[0] ?? ([255, 255, 255] as RGB);
    drawText(canvas, text, x, y, flatColor, textOpts);
  }

  return { x, y, w, h };
}

/**
 * Render text with auto-fit logic: tries standard → compact → scroll.
 * Returns the layout entry describing what was done.
 */
export function renderAutoFitText(
  canvas: Canvas,
  text: string,
  px: SemanticX,
  py: SemanticY,
  dx: number,
  dy: number,
  style: TextStyle,
  overflow: OverflowMode,
  elementIdx: number | 'background',
  frameIdx: number,
  _totalFrames: number,
): LayoutEntry {
  const size = canvas.width;
  const scale = style.scale ?? 1;
  let fontVariant: FontVariant = 'standard';
  let action: LayoutEntry['action'] = 'none';

  const font = FONT_5x7;
  const compactFont = FONT_3x5;
  const textOpts = { font, scale };
  const textWidth = measureText(text, textOpts);

  let fits = textWidth <= size;

  if (!fits && (overflow === 'auto' || overflow === 'shrink')) {
    // Try compact font
    const compactOpts = { font: compactFont, scale };
    const compactWidth = measureText(text, compactOpts);
    if (compactWidth <= size) {
      fontVariant = 'compact';
      action = 'shrunk-to-compact';
      fits = true;
    }
  }

  if (!fits && (overflow === 'auto' || overflow === 'scroll')) {
    action = 'scrolling';
    fits = false; // will scroll
  }

  if (!fits && overflow === 'truncate') {
    action = 'truncated';
    fits = false;
  }

  const usedFont = fontVariant === 'compact' ? compactFont : font;
  const usedOpts = { font: usedFont, scale };
  const finalWidth = measureText(text, usedOpts);
  const finalHeight = usedFont.height * scale;

  const resolvedX = resolveX(px, finalWidth, size, dx);
  const resolvedY = resolveY(py, finalHeight, size, dy);

  // For scrolling, apply frame-based dx
  let renderX = resolvedX;
  if (action === 'scrolling') {
    const scrollSpeed = 2;
    renderX = size - ((frameIdx * scrollSpeed) % (finalWidth + size));
  }

  drawStyledText(canvas, text, renderX, resolvedY, style, fontVariant);

  return {
    element: elementIdx,
    type: 'text',
    box: { x: resolvedX, y: resolvedY, w: finalWidth, h: finalHeight },
    fits: fits,
    action,
    font: fontVariant,
    scale,
  };
}
