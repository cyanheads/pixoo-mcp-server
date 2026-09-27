/**
 * @fileoverview The `pixoo` page runtime: the browser entry injected into a
 * `pixoo_render_html` page ahead of the page's own scripts. It assigns `globalThis.pixoo`
 * (`context`, `text`, `icon`, `palettes`, `size`) so a page draws text and icons with the
 * bitmap fonts, palette ramps, and icon set of `pixoo_display_text` and
 * `pixoo_compose_scene`, placed by the same functions. Each lit panel pixel becomes one 1×1
 * `fillRect` in the context's units, so browser anti-aliasing never touches it.
 *
 * The panel size comes from `globalThis.__PIXOO_SIZE__`, which the injecting tool sets in a
 * script that runs before this one; the runtime refuses to load without it.
 *
 * `scripts/build-page-runtime.ts` typechecks this file against the DOM lib
 * (`tsconfig.page-runtime.json`) and bundles it into `dist/page-runtime.js` as one IIFE.
 * The server's own tsconfigs exclude it, so DOM globals stay out of the server's compile;
 * nothing in `src/` or `tests/` imports it (an import would pull it back into that
 * compile), and the tests run the built bundle instead.
 * @module renderer/page-runtime
 */

import { Canvas, resolveColor } from '@cyanheads/pixoo-toolkit/core';
import { drawPlacedIcon, type IconLook } from './icon-draw.js';
import { ICONS } from './icons.js';
import {
  describeMissingNumerals,
  drawPlacedText,
  FONT_FACES,
  FONT_VARIANTS,
  type FontVariant,
  missingGlyphs,
  type SemanticX,
  type SemanticY,
  type TextStyle,
} from './text-engine.js';
import { type GradientStop, PALETTE_NAMES, PALETTES } from './themes.js';

type Box = { x: number; y: number; w: number; h: number };

/** `pixoo.text` options: a scene `text` element's `font`, `color`, and `style` fields, flat. */
interface TextOptions extends Omit<TextStyle, 'palette'> {
  font?: FontVariant;
  /** A palette name, or a `{ from, to }` stop. */
  palette?: string | GradientStop;
}

/** `pixoo.icon` options: a scene `icon` element's `w`/`h`, `color`, and `palette`. */
interface IconOptions extends Omit<IconLook, 'palette'> {
  palette?: string;
}

interface PixooRuntime {
  context(): CanvasRenderingContext2D;
  icon(
    ctx: CanvasRenderingContext2D,
    name: string,
    x?: SemanticX,
    y?: SemanticY,
    opts?: IconOptions,
  ): Box;
  palettes: typeof PALETTES;
  size: 16 | 32 | 64;
  text(
    ctx: CanvasRenderingContext2D,
    text: string | number,
    x?: SemanticX,
    y?: SemanticY,
    opts?: TextOptions,
  ): Box;
}

declare global {
  /** Panel size, set by the injecting tool in a script that runs before the runtime. */
  var __PIXOO_SIZE__: unknown;
  var pixoo: PixooRuntime;
}

/** The panel size the injecting tool set. The runtime refuses to load without one. */
function panelSize(): 16 | 32 | 64 {
  const value = globalThis.__PIXOO_SIZE__;
  if (value === 16 || value === 32 || value === 64) return value;
  throw new Error(
    `pixoo runtime: __PIXOO_SIZE__ must be 16, 32, or 64 (got ${String(value)}); set it in a script that runs before the runtime.`,
  );
}

const size = panelSize();

/** `table[key]` when `key` is one of its own keys, never an `Object.prototype` member. */
function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: string,
  what: string,
  known: string,
): T {
  const value = Object.hasOwn(table, key) ? table[key] : undefined;
  if (value === undefined) throw new Error(`Unknown ${what} ${JSON.stringify(key)}. ${known}`);
  return value;
}

function paletteStop(name: string): GradientStop {
  return lookup(PALETTES, name, 'palette', `Palettes: ${PALETTE_NAMES.join(', ')}.`);
}

/** Paint each lit pixel of `canvas` onto `ctx` as one 1×1 `fillRect`, leaving the page's fill style as it was. */
function paint(ctx: CanvasRenderingContext2D, canvas: Canvas): void {
  ctx.save();
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const [r, g, b, a] = canvas.getPixelRgba(x, y);
      if (a === 0) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

let pageContext: CanvasRenderingContext2D | undefined;

/**
 * The 2D context of one transparent panel-size canvas fixed over the page, created on the
 * first call. Its backing store is scaled by `devicePixelRatio` and so is the context, so
 * one unit stays one panel pixel under supersampling; smoothing is off.
 */
function context(): CanvasRenderingContext2D {
  if (pageContext) return pageContext;
  const ratio = devicePixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;pointer-events:none;z-index:2147483647`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pixoo.context(): the page could not create a 2D canvas context.');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.imageSmoothingEnabled = false;
  document.documentElement.append(canvas);
  pageContext = ctx;
  return ctx;
}

globalThis.pixoo = {
  context,

  text(ctx, text, x, y, { font = 'standard', palette, ...rest } = {}) {
    const value = String(text);
    const face = lookup(FONT_FACES, font, 'font', `Fonts: ${FONT_VARIANTS.join(', ')}.`);
    if (font === 'numerals') {
      const missing = missingGlyphs(value, face);
      if (missing.length > 0) throw new Error(describeMissingNumerals(missing));
    }
    // Resolved even under a palette, as an icon's is, so a bad color throws either way.
    if (rest.color !== undefined) resolveColor(rest.color);
    const style: TextStyle = { ...rest };
    if (palette !== undefined) {
      style.palette = typeof palette === 'string' ? paletteStop(palette) : palette;
    }
    const canvas = new Canvas(size);
    const box = drawPlacedText(canvas, value, x, y, style, font);
    paint(ctx, canvas);
    return box;
  },

  icon(ctx, name, x, y, { palette, ...look } = {}) {
    const paths = lookup(
      ICONS,
      name,
      'icon',
      'Use pixoo://reference/icons to browse available icons.',
    );
    const canvas = new Canvas(size);
    const box = drawPlacedIcon(canvas, paths, paths.viewBox, x, y, {
      ...look,
      palette: palette === undefined ? undefined : paletteStop(palette),
    });
    paint(ctx, canvas);
    return box;
  },

  palettes: PALETTES,
  size,
};
