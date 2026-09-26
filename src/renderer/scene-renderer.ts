/**
 * @fileoverview Scene renderer — element vocabulary, layout resolver, frame rendering.
 * @module renderer/scene-renderer
 */

import * as fs from 'node:fs/promises';
import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  Canvas,
  downsampleSprite,
  drawText,
  FONT_3x5,
  FONT_5x7,
  lerpColor,
  loadImage,
  measureText,
  type PixooSize,
  type RGB,
  renderSprite,
  renderSvgPath,
  resolveColor,
} from '@cyanheads/pixoo-toolkit';
import { ICONS, type IconPaths } from './icons.js';
import {
  compileEffect,
  type EffectName,
  getKeyframeValue,
  interpolateColorKeyframe,
  type KeyframeMap,
} from './keyframes.js';
import { fetchRemoteImageToTempPng, isRemoteSource } from './remote-image.js';
import {
  drawStyledText,
  type FontVariant,
  type LayoutEntry,
  resolveX,
  resolveY,
  type SemanticX,
  type SemanticY,
  type TextStyle,
} from './text-engine.js';
import { type GradientStop, PALETTES, type PaletteName, THEMES, type ThemeName } from './themes.js';

/** Background specification. */
export type BackgroundSpec =
  | string // solid color
  | { gradient: { type: 'v' | 'h' | 'r'; from: string; to: string } }
  | { theme: ThemeName };

/** Effect specification for elements. */
export interface EffectSpec {
  amplitude?: number;
  name: EffectName;
  period?: number;
  phase?: number;
}

/** Base element properties. */
interface BaseElement {
  animate?: KeyframeMap;
  dx?: number;
  dy?: number;
  effect?: EffectSpec;
  opacity?: number;
  visible?: boolean;
}

/** Text element. */
export interface TextElement extends BaseElement {
  color?: string;
  font?: 'standard' | 'compact';
  style?: TextStyle;
  text: string;
  type: 'text';
  x?: SemanticX;
  y?: SemanticY;
}

/** Icon element. */
export interface IconElement extends BaseElement {
  color?: string;
  d?: string;
  h?: number;
  name?: string;
  palette?: PaletteName;
  type: 'icon';
  viewBox?: string;
  w?: number;
  x?: SemanticX;
  y?: SemanticY;
}

/** Rectangle element. */
export interface RectElement extends BaseElement {
  borderColor?: string;
  color?: string;
  gradient?: { type: 'v' | 'h'; from: string; to: string };
  h: number;
  type: 'rect';
  w: number;
  x: number;
  y: number;
}

/** Circle element. */
export interface CircleElement extends BaseElement {
  color?: string;
  cx: number;
  cy: number;
  fill?: boolean;
  radius: number;
  type: 'circle';
}

/** Line element. */
export interface LineElement extends BaseElement {
  color?: string;
  type: 'line';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Progress bar widget. */
export interface ProgressElement extends BaseElement {
  h: number;
  label?: string;
  max: number;
  palette?: PaletteName;
  trackColor?: string;
  type: 'progress';
  value: number;
  w: number;
  x: number;
  y: number;
}

/** Sparkline widget. */
export interface SparklineElement extends BaseElement {
  color?: string;
  data: number[];
  h: number;
  kind?: 'line' | 'bar';
  type: 'sparkline';
  w: number;
  x: number;
  y: number;
}

/** Bitmap element (palette indices). */
export interface BitmapElement extends BaseElement {
  palette: string[];
  rows: string[];
  type: 'bitmap';
  x: number;
  y: number;
}

/** Sparse pixels element. */
export interface PixelsElement extends BaseElement {
  data: Array<{ x: number; y: number; color: string }>;
  type: 'pixels';
}

/** Image element. */
export interface ImageElement extends BaseElement {
  fit?: 'contain' | 'cover' | 'fill';
  h?: number;
  kernel?: 'nearest' | 'lanczos3' | 'mitchell';
  source: string;
  type: 'image';
  w?: number;
  x?: number;
  y?: number;
}

/** Sprite element. */
export interface SpriteElement extends BaseElement {
  bodyColor?: string;
  cols: number;
  darkColor?: string;
  path: string;
  rows: number;
  scale?: number;
  type: 'sprite';
  x?: SemanticX;
  y?: number;
}

export type SceneElement =
  | TextElement
  | IconElement
  | RectElement
  | CircleElement
  | LineElement
  | ProgressElement
  | SparklineElement
  | BitmapElement
  | PixelsElement
  | ImageElement
  | SpriteElement;

/**
 * Pre-loaded asset cache for images and sprites. Images are keyed by element: the
 * loader bakes each element's fit, size, and position into its canvas, so two
 * elements sharing a source still need a canvas each.
 */
export interface AssetCache {
  images: Map<ImageElement, Canvas>;
  sprites: Map<string, Awaited<ReturnType<typeof downsampleSprite>>>;
}

/**
 * Confirm a local image or sprite-sheet path is readable before the toolkit's
 * loader reaches it — the loader fails a missing file with an unclassified error.
 *
 * @throws {McpError} NotFound with `reason: 'asset_not_found'` when the path is
 *   missing or unreadable.
 */
async function assertReadableAsset(assetPath: string, label: string): Promise<void> {
  try {
    await fs.access(assetPath, fs.constants.R_OK);
  } catch (err) {
    throw notFound(
      `${label} not found or unreadable: "${assetPath}".`,
      {
        reason: 'asset_not_found',
        path: assetPath,
        recovery: { hint: 'Pass an absolute path to an existing, readable image file.' },
      },
      { cause: err },
    );
  }
}

/**
 * Preload all async assets referenced in elements. Images load onto a `size` canvas,
 * the scene's own, so an image with no `w`/`h` fits the display.
 *
 * `ctx` is threaded through so a remote image fetch correlates to the originating
 * request in logs and traces, and stops when that request is cancelled.
 */
export async function preloadAssets(
  elements: SceneElement[],
  ctx: Context,
  size: PixooSize,
): Promise<AssetCache> {
  const cache: AssetCache = { images: new Map(), sprites: new Map() };

  await Promise.all(
    elements.map(async (el) => {
      if (el.type === 'image') {
        const source = el.source;
        // The toolkit's loadImage reads from disk, so a remote source is
        // staged to a temp PNG first and unlinked once it has been read.
        const remote = isRemoteSource(source);
        if (!remote) await assertReadableAsset(source, 'Image file');
        const tmpPathToCleanup = remote ? await fetchRemoteImageToTempPng(source, ctx) : undefined;
        const localPath = tmpPathToCleanup ?? source;
        const loadOpts: Parameters<typeof loadImage>[1] = {
          size,
          fit: el.fit ?? 'contain',
          kernel: el.kernel ?? 'nearest',
          x: typeof el.x === 'number' ? el.x : 0,
          y: typeof el.y === 'number' ? el.y : 0,
        };
        if (el.w !== undefined) loadOpts.width = el.w;
        if (el.h !== undefined) loadOpts.height = el.h;
        const canvas = await loadImage(localPath, loadOpts);
        if (tmpPathToCleanup) {
          fs.unlink(tmpPathToCleanup).catch(() => undefined);
        }
        cache.images.set(el, canvas);
      } else if (el.type === 'sprite') {
        const key = `${el.path}:${el.cols}:${el.rows}`;
        if (!cache.sprites.has(key)) {
          await assertReadableAsset(el.path, 'Sprite sheet');
          const sprite = await downsampleSprite(el.path, el.cols, el.rows);
          cache.sprites.set(key, sprite);
        }
      }
    }),
  );

  return cache;
}

/** Apply a background spec to a canvas. */
export function applyBackground(canvas: Canvas, bg: BackgroundSpec): void {
  if (typeof bg === 'string') {
    if (bg === 'transparent' || bg === '') {
      canvas.clear();
    } else {
      canvas.clear(resolveColor(bg));
    }
    return;
  }

  if ('theme' in bg) {
    const theme = THEMES[bg.theme];
    if (!theme) {
      throw invalidParams(
        `Unknown theme "${bg.theme}". Valid themes: ${Object.keys(THEMES).join(', ')}.`,
      );
    }
    const bk = theme.background;
    if (bk.type === 'gradient-v') {
      canvas.gradientV(resolveColor(bk.from), resolveColor(bk.to));
    } else {
      canvas.clear(resolveColor(bk.color));
    }
    return;
  }

  if ('gradient' in bg) {
    const grad = bg.gradient;
    const from_ = resolveColor(grad.from);
    const to_ = resolveColor(grad.to);
    if (grad.type === 'v') {
      canvas.gradientV(from_, to_);
    } else if (grad.type === 'h') {
      canvas.gradientH(from_, to_);
    } else if (grad.type === 'r') {
      canvas.gradientRadial(canvas.width / 2, canvas.height / 2, canvas.width / 2, from_, to_);
    }
    return;
  }

  canvas.clear();
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
  const mask = new Canvas(canvas.width as PixooSize);
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

/**
 * The layout entry for an element drawn over `box` — its placed pixels, `dx`/`dy` included.
 * The element fits when the box lies wholly on the canvas.
 */
function placedEntry(
  element: number,
  type: SceneElement['type'],
  box: LayoutEntry['box'],
  canvas: Canvas,
): LayoutEntry {
  const fits =
    box.x >= 0 && box.y >= 0 && box.x + box.w <= canvas.width && box.y + box.h <= canvas.height;
  return { element, type, box, fits, action: 'none' };
}

/** Render a single element onto a canvas at a specific frame. */
export function renderElement(
  canvas: Canvas,
  el: SceneElement,
  elIdx: number,
  frameIdx: number,
  totalFrames: number,
  assets: AssetCache,
  layoutEntries: LayoutEntry[],
): void {
  // Compute keyframes / effects
  const kf: KeyframeMap | undefined = el.animate
    ? el.animate
    : el.effect
      ? compileEffect(el.effect.name, el.effect, totalFrames)
      : undefined;

  const visible = kf
    ? Boolean(getKeyframeValue(kf, 'visible', frameIdx, el.visible ?? true))
    : (el.visible ?? true);
  if (!visible) return;

  const opacity = Math.max(
    0,
    Math.min(
      100,
      Number(
        kf ? getKeyframeValue(kf, 'opacity', frameIdx, el.opacity ?? 100) : (el.opacity ?? 100),
      ),
    ),
  );

  const dxAnim = Number(getKeyframeValue(kf, 'dx', frameIdx, 0));
  const dyAnim = Number(getKeyframeValue(kf, 'dy', frameIdx, 0));
  const dx = (el.dx ?? 0) + dxAnim;
  const dy = (el.dy ?? 0) + dyAnim;

  // A keyframed `color` stands in for the element's own `color` on this frame.
  const colorFrames = kf?.['color'];
  const keyframedColor = colorFrames ? interpolateColorKeyframe(colorFrames, frameIdx) : undefined;

  // If opacity < 100, render to scratch canvas and blit with alpha
  const target = opacity < 100 ? new Canvas(canvas.width as 16 | 32 | 64) : canvas;

  switch (el.type) {
    case 'text': {
      // A copy: the per-frame color must not stick to the caller's style object.
      const style: TextStyle = { ...el.style };
      const color = keyframedColor ?? el.color;
      if (!style.color && color) style.color = color;
      const fontVariant: FontVariant = el.font === 'compact' ? 'compact' : 'standard';
      const px = el.x ?? 0;
      const py = el.y ?? 0;
      const font = fontVariant === 'compact' ? FONT_3x5 : FONT_5x7;
      const scale = style.scale ?? 1;
      const textW = measureText(el.text, { font, scale });
      const textH = font.height * scale;
      const resolvedX = resolveX(px, textW, canvas.width, dx);
      const resolvedY = resolveY(py, textH, canvas.height, dy);
      drawStyledText(target, el.text, resolvedX, resolvedY, style, fontVariant);
      layoutEntries.push({
        ...placedEntry(elIdx, 'text', { x: resolvedX, y: resolvedY, w: textW, h: textH }, canvas),
        font: fontVariant,
        scale,
      });
      break;
    }

    case 'icon': {
      let paths: IconPaths;
      let viewBox = '0 0 16 16';

      if (el.name) {
        // Own keys only: an Object.prototype name such as "constructor" is not an icon.
        const iconEntry = Object.hasOwn(ICONS, el.name) ? ICONS[el.name] : undefined;
        if (!iconEntry) {
          throw invalidParams(
            `Unknown icon "${el.name}". Use pixoo://reference/icons to browse available icons.`,
            { reason: 'unknown_icon' },
          );
        }
        paths = iconEntry;
        viewBox = iconEntry.viewBox;
      } else if (el.d) {
        paths = { fill: el.d };
        viewBox = el.viewBox ?? '0 0 16 16';
      } else {
        throw invalidParams('Icon element requires either "name" or "d" property.');
      }

      const w = el.w ?? 12;
      const h = el.h ?? 12;
      const px = el.x ?? 0;
      const py = el.y ?? 0;
      const resolvedX = resolveX(px, w, canvas.width, dx);
      const resolvedY = resolveY(py, h, canvas.height, dy);

      // Resolved even under a palette, so a bad color still fails as invalid_color.
      const colorSpec = keyframedColor ?? el.color;
      const color = colorSpec ? resolveColor(colorSpec) : ([255, 255, 255] as RGB);
      // Parse viewBox string ("0 0 W H") to extract dimensions [W, H]
      const vbParts = viewBox.split(/\s+/).map(Number);
      const svgViewBox: [number, number] = [vbParts[2] ?? 16, vbParts[3] ?? 16];
      const targetRect: [number, number, number, number] = [resolvedX, resolvedY, w, h];
      if (el.palette) {
        renderIconRamp(target, paths, svgViewBox, targetRect, PALETTES[el.palette]);
      } else {
        drawIconPaths(target, paths, color, svgViewBox, targetRect);
      }

      layoutEntries.push(placedEntry(elIdx, 'icon', { x: resolvedX, y: resolvedY, w, h }, canvas));
      break;
    }

    case 'rect': {
      const x = el.x + dx;
      const y = el.y + dy;
      const fill = keyframedColor ?? el.color;
      if (el.gradient) {
        const from_ = resolveColor(el.gradient.from);
        const to_ = resolveColor(el.gradient.to);
        // Fill row by row for gradient
        if (el.gradient.type === 'v') {
          for (let row = 0; row < el.h; row++) {
            const t = el.h <= 1 ? 0 : row / (el.h - 1);
            const c = lerpColor(from_, to_, t);
            target.drawLineH(x, y + row, el.w, c);
          }
        } else {
          for (let col = 0; col < el.w; col++) {
            const t = el.w <= 1 ? 0 : col / (el.w - 1);
            const c = lerpColor(from_, to_, t);
            target.drawLineV(x + col, y, el.h, c);
          }
        }
      } else if (fill) {
        target.fillRect(x, y, el.w, el.h, resolveColor(fill));
      }
      if (el.borderColor) {
        target.drawRect(x, y, el.w, el.h, resolveColor(el.borderColor));
      }
      layoutEntries.push(placedEntry(elIdx, 'rect', { x, y, w: el.w, h: el.h }, canvas));
      break;
    }

    case 'circle': {
      const cx = el.cx + dx;
      const cy = el.cy + dy;
      const colorSpec = keyframedColor ?? el.color;
      const color = colorSpec ? resolveColor(colorSpec) : ([255, 255, 255] as RGB);
      if (el.fill !== false) {
        target.fillCircle(cx, cy, el.radius, color);
      } else {
        target.drawCircle(cx, cy, el.radius, color);
      }
      // The circle covers its center pixel plus `radius` on each side.
      const diameter = el.radius * 2 + 1;
      const box = { x: cx - el.radius, y: cy - el.radius, w: diameter, h: diameter };
      layoutEntries.push(placedEntry(elIdx, 'circle', box, canvas));
      break;
    }

    case 'line': {
      const colorSpec = keyframedColor ?? el.color;
      const color = colorSpec ? resolveColor(colorSpec) : ([255, 255, 255] as RGB);
      const x0 = el.x0 + dx;
      const y0 = el.y0 + dy;
      const x1 = el.x1 + dx;
      const y1 = el.y1 + dy;
      target.drawLine(x0, y0, x1, y1, color);
      // Both endpoints are drawn, so the line spans one pixel more than their distance.
      const box = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0) + 1,
        h: Math.abs(y1 - y0) + 1,
      };
      layoutEntries.push(placedEntry(elIdx, 'line', box, canvas));
      break;
    }

    case 'progress': {
      const x = el.x + dx;
      const y = el.y + dy;
      const fillW = Math.round((Math.min(el.value, el.max) / el.max) * el.w);
      const trackColor = el.trackColor ? resolveColor(el.trackColor) : ([30, 30, 30] as RGB);
      target.fillRect(x, y, el.w, el.h, trackColor);

      if (fillW > 0) {
        if (el.palette) {
          const pal = PALETTES[el.palette];
          const from_ = resolveColor(pal.from);
          const to_ = resolveColor(pal.to);
          for (let col = 0; col < fillW; col++) {
            const t = fillW <= 1 ? 0 : col / (fillW - 1);
            const c = lerpColor(from_, to_, t);
            target.drawLineV(x + col, y, el.h, c);
          }
        } else {
          target.fillRect(x, y, fillW, el.h, [0, 200, 100]);
        }
      }

      if (el.label) {
        const labelX =
          x + Math.floor(el.w / 2) - Math.floor(measureText(el.label, { font: FONT_3x5 }) / 2);
        const labelY = y + Math.floor((el.h - FONT_3x5.height) / 2);
        drawText(target, el.label, labelX, labelY, [200, 200, 200], { font: FONT_3x5 });
      }

      layoutEntries.push(placedEntry(elIdx, 'progress', { x, y, w: el.w, h: el.h }, canvas));
      break;
    }

    case 'sparkline': {
      const x = el.x + dx;
      const y = el.y + dy;
      const data = el.data;
      if (data.length < 2) break;

      const min_ = Math.min(...data);
      const max_ = Math.max(...data);
      const range = max_ - min_ || 1;
      const colorSpec = keyframedColor ?? el.color;
      const color = colorSpec ? resolveColor(colorSpec) : ([100, 200, 255] as RGB);

      if (el.kind === 'bar') {
        const barW = Math.max(1, Math.floor(el.w / data.length));
        for (let i = 0; i < data.length; i++) {
          const v = data[i] ?? 0;
          const h = Math.max(1, Math.round(((v - min_) / range) * el.h));
          target.fillRect(x + i * barW, y + el.h - h, barW - 1, h, color);
        }
      } else {
        // Scaled over w − 1 and h − 1, so the line fills exactly its w × h box.
        const stepX = (el.w - 1) / (data.length - 1);
        const bottom = y + el.h - 1;
        const rowOf = (v: number) => bottom - Math.round(((v - min_) / range) * (el.h - 1));
        for (let i = 0; i < data.length - 1; i++) {
          const x0 = Math.round(x + i * stepX);
          const y0 = rowOf(data[i] ?? 0);
          const x1 = Math.round(x + (i + 1) * stepX);
          const y1 = rowOf(data[i + 1] ?? 0);
          target.drawLine(x0, y0, x1, y1, color);
        }
      }

      layoutEntries.push(placedEntry(elIdx, 'sparkline', { x, y, w: el.w, h: el.h }, canvas));
      break;
    }

    case 'bitmap': {
      const x = el.x + dx;
      const y = el.y + dy;
      for (let row = 0; row < el.rows.length; row++) {
        const rowStr = el.rows[row];
        if (!rowStr) continue;
        for (let col = 0; col < rowStr.length; col++) {
          const ch = rowStr[col];
          if (!ch || ch === ' ' || ch === '.') continue;
          const palIdx = Number.parseInt(ch, 16);
          const colorStr = el.palette[palIdx] ?? '#ffffff';
          target.setPixel(x + col, y + row, resolveColor(colorStr));
        }
      }
      const widest = el.rows.reduce((max, row) => Math.max(max, row.length), 0);
      layoutEntries.push(
        placedEntry(elIdx, 'bitmap', { x, y, w: widest, h: el.rows.length }, canvas),
      );
      break;
    }

    case 'pixels': {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const pt of el.data) {
        const x = pt.x + dx;
        const y = pt.y + dy;
        target.setPixel(x, y, resolveColor(keyframedColor ?? pt.color));
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      const box =
        el.data.length === 0
          ? { x: 0, y: 0, w: 0, h: 0 }
          : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      layoutEntries.push(placedEntry(elIdx, 'pixels', box, canvas));
      break;
    }

    case 'image': {
      const cachedCanvas = assets.images.get(el);
      if (cachedCanvas) {
        target.blit(cachedCanvas, dx, dy);
      }
      const box = {
        x: (el.x ?? 0) + dx,
        y: (el.y ?? 0) + dy,
        w: el.w ?? canvas.width,
        h: el.h ?? canvas.height,
      };
      layoutEntries.push(placedEntry(elIdx, 'image', box, canvas));
      break;
    }

    case 'sprite': {
      const key = `${el.path}:${el.cols}:${el.rows}`;
      const sprite = assets.sprites.get(key);
      if (sprite) {
        const scale = el.scale ?? 1;
        const spriteW = sprite.cols * scale;
        const spriteH = sprite.rows * scale;
        const px = el.x ?? 'center';
        const py = el.y ?? 0;
        const resolvedX = resolveX(px, spriteW, canvas.width, dx);
        const resolvedY = resolveY(py, spriteH, canvas.height, dy);

        const bodyColor = el.bodyColor ? (resolveColor(el.bodyColor) as RGB) : sprite.bodyColor;
        const darkColor = el.darkColor ? (resolveColor(el.darkColor) as RGB) : sprite.darkColor;

        renderSprite(target, sprite.grid, {
          scale,
          x: resolvedX,
          y: resolvedY,
          bodyColor,
          darkColor,
          originalBodyColor: sprite.bodyColor,
          originalDarkColor: sprite.darkColor,
        });

        const box = { x: resolvedX, y: resolvedY, w: spriteW, h: spriteH };
        layoutEntries.push(placedEntry(elIdx, 'sprite', box, canvas));
      }
      break;
    }
  }

  // Blit scratch canvas onto main if we used opacity
  if (opacity < 100 && target !== canvas) {
    const alpha = opacity / 100;
    for (let py_ = 0; py_ < canvas.height; py_++) {
      for (let px_ = 0; px_ < canvas.width; px_++) {
        const [r, g, b, a] = target.getPixelRgba(px_, py_);
        if (a > 0) {
          canvas.blendPixel(px_, py_, [r, g, b], alpha);
        }
      }
    }
  }
}

/** Render a complete frame. */
export function renderFrame(
  frameIdx: number,
  totalFrames: number,
  background: BackgroundSpec,
  elements: SceneElement[],
  assets: AssetCache,
  size: 16 | 32 | 64 = 64,
): { canvas: Canvas; layoutEntries: LayoutEntry[] } {
  const canvas = new Canvas(size);
  const layoutEntries: LayoutEntry[] = [];

  applyBackground(canvas, background);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el) renderElement(canvas, el, i, frameIdx, totalFrames, assets, layoutEntries);
  }

  return { canvas, layoutEntries };
}

/** Render all frames of a scene. */
export async function renderScene(
  background: BackgroundSpec,
  elements: SceneElement[],
  frameCount: number,
  ctx: Context,
  size: PixooSize = 64,
): Promise<{ frames: Canvas[]; layoutEntries: LayoutEntry[] }> {
  const assets = await preloadAssets(elements, ctx, size);
  const allLayoutEntries: LayoutEntry[] = [];
  const frames: Canvas[] = [];

  for (let i = 0; i < frameCount; i++) {
    const { canvas, layoutEntries } = renderFrame(
      i,
      frameCount,
      background,
      elements,
      assets,
      size,
    );
    frames.push(canvas);
    // Only collect layout entries from frame 0 to avoid duplicates
    if (i === 0) {
      allLayoutEntries.push(...layoutEntries);
    }
  }

  return { frames, layoutEntries: allLayoutEntries };
}
