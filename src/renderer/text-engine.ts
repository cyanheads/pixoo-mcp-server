/**
 * @fileoverview Styled text engine: gradient ramps, shadow, outline, scale, overflow handling.
 * Browser-safe: it imports the toolkit's `/core` entry, never the main barrel (which loads
 * `sharp`), so a page bundle can carry it.
 * @module renderer/text-engine
 */

import {
  type BitmapFont,
  Canvas,
  type ColorLike,
  drawText,
  FONT_3x5,
  FONT_5x7,
  FONT_DIGITS_11x18,
  lerpColor,
  measureText,
  type RGB,
  resolveColor,
} from '@cyanheads/pixoo-toolkit/core';
import { type GradientStop, PALETTES, type PaletteName } from './themes.js';

/** Font variants a text surface accepts. */
export const FONT_VARIANTS = ['standard', 'compact', 'numerals'] as const;

/** Font variant. */
export type FontVariant = (typeof FONT_VARIANTS)[number];

/**
 * The toolkit face each variant draws with. `standard` (5×7) and `compact` (3×5) hold
 * printable ASCII plus `° ← ↑ → ↓ ▲ ▼ ♥ · …`; `numerals` holds 11×18 digits on one
 * 13-pixel advance plus space and `: . - + / % ° ?`.
 */
export const FONT_FACES: Record<FontVariant, BitmapFont> = {
  standard: FONT_5x7,
  compact: FONT_3x5,
  numerals: FONT_DIGITS_11x18,
};

/**
 * The characters of `text` that `face` has no glyph for, each once, in order of first
 * appearance. The face draws every one of them as its `?`.
 */
export function missingGlyphs(text: string, face: BitmapFont): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    if (!Object.hasOwn(face.glyphs, ch)) missing.add(ch);
  }
  return [...missing];
}

/** Names the `missing` characters and the characters the numerals face does draw. */
export function describeMissingNumerals(missing: string[]): string {
  const named = missing.map((ch) => JSON.stringify(ch)).join(', ');
  return `Characters not in the numerals font: ${named}. It draws 0–9, space, and : . - + / % ° ? only.`;
}

/** One character quoted, then its code point — `"€" (U+20AC)` — so an invisible one is identifiable. */
function nameCharacter(ch: string): string {
  const codePoint = (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
  return `${JSON.stringify(ch)} (U+${codePoint})`;
}

/**
 * The notice naming the characters in `texts` that the standard and compact faces draw
 * as `?`, grouped by element index, each once per element in order of first appearance;
 * undefined when every character has a glyph. The two faces share one glyph set, so one
 * check covers both. Numerals text never reaches here with a character outside its face,
 * and every numerals glyph is also in that set.
 */
export function fallbackGlyphNotice(
  texts: ReadonlyArray<{ element: number; text: string }>,
): string | undefined {
  const groups = texts.flatMap(({ element, text }) => {
    const missing = missingGlyphs(text, FONT_FACES.standard);
    return missing.length > 0
      ? [`element ${element} ${missing.map(nameCharacter).join(', ')}`]
      : [];
  });
  if (groups.length === 0) return;
  return `Not in the standard and compact fonts, so drawn as "?": ${groups.join('; ')}. Those fonts draw printable ASCII plus ° ← ↑ → ↓ ▲ ▼ ♥ · … only.`;
}

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

/** Layout report entry. */
export interface LayoutEntry {
  action: 'none' | 'shrunk-to-compact' | 'scrolling';
  box: { x: number; y: number; w: number; h: number };
  element: number;
  fits: boolean;
  font?: FontVariant;
  scale?: number;
  type: string;
}

/** Whether `box` lies wholly on a `width` × `height` canvas, clear of all four edges. */
export function boxFits(box: LayoutEntry['box'], width: number, height: number): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height;
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

/** Pixels a scrolling block advances per frame while the cycle fits the frame cap. */
const SCROLL_STEP_PX = 2;

/** Device-safe animation length. */
const MAX_SCROLL_FRAMES = 40;

/**
 * Frame count and per-frame step for one scroll cycle of a block `contentWidth` wide:
 * it starts just past the right edge and ends once it has left through the left edge.
 * A block too wide to cross in 40 frames at the base step moves faster instead, so the
 * cycle always completes, and the frame count follows from the step, so the loop never
 * cuts off mid-text or trails blank frames.
 */
export function scrollCycle(
  contentWidth: number,
  canvasWidth: number,
): { frames: number; step: number } {
  const distance = contentWidth + canvasWidth;
  const step = Math.max(SCROLL_STEP_PX, Math.ceil(distance / MAX_SCROLL_FRAMES));
  return { frames: Math.ceil(distance / step), step };
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
  const font = FONT_FACES[fontVariant];
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
    const scratch = new Canvas(canvas.width);
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
 * Draw text placed the way a scene `text` element places it: `x`/`y` (default 0) resolve
 * against the canvas for the text's measured size in `fontVariant` at `style.scale`, then
 * shift by `dx`/`dy`. The scene renderer, `pixoo_display_text`, and the `pixoo` page
 * runtime all place text here. Returns the drawn box.
 */
export function drawPlacedText(
  canvas: Canvas,
  text: string,
  x: SemanticX = 0,
  y: SemanticY = 0,
  style: TextStyle = {},
  fontVariant: FontVariant = 'standard',
  dx = 0,
  dy = 0,
): { x: number; y: number; w: number; h: number } {
  const font = FONT_FACES[fontVariant];
  const scale = style.scale ?? 1;
  const w = measureText(text, { font, scale });
  const h = font.height * scale;
  const px = resolveX(x, w, canvas.width, dx);
  const py = resolveY(y, h, canvas.height, dy);
  return drawStyledText(canvas, text, px, py, style, fontVariant);
}

/**
 * Render text with auto-fit logic: text too wide in the standard font falls back to
 * compact when compact fits. Auto-fit never picks `numerals`; only a `fixedFont` does.
 * A `fixedFont` pins the variant: the compact fallback is skipped, so text that
 * overflows in it overflows in that font. Scrolling is the caller's decision, so the
 * entry's `action` is `none` or `shrunk-to-compact`.
 * Returns the layout entry describing what was done: `fits` holds when the placed box
 * lies wholly on the canvas.
 */
export function renderAutoFitText(
  canvas: Canvas,
  text: string,
  px: SemanticX,
  py: SemanticY,
  dx: number,
  dy: number,
  style: TextStyle,
  elementIdx: number,
  fixedFont?: FontVariant,
): LayoutEntry {
  const size = canvas.width;
  const scale = style.scale ?? 1;
  let fontVariant: FontVariant = fixedFont ?? 'standard';
  let action: LayoutEntry['action'] = 'none';

  const fitsWidth = measureText(text, { font: FONT_FACES[fontVariant], scale }) <= size;
  if (!fitsWidth && !fixedFont && measureText(text, { font: FONT_FACES.compact, scale }) <= size) {
    fontVariant = 'compact';
    action = 'shrunk-to-compact';
  }

  const box = drawPlacedText(canvas, text, px, py, style, fontVariant, dx, dy);
  return {
    element: elementIdx,
    type: 'text',
    box,
    fits: boxFits(box, size, size),
    action,
    font: fontVariant,
    scale,
  };
}
