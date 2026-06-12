/**
 * @fileoverview Scene renderer — element vocabulary, layout resolver, frame rendering.
 * @module renderer/scene-renderer
 */

import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import {
  Canvas,
  downsampleSprite,
  drawText,
  FONT_3x5,
  FONT_5x7,
  lerpColor,
  loadImage,
  measureText,
  type RGB,
  renderSprite,
  renderSvgPath,
  resolveColor,
} from '@cyanheads/pixoo-toolkit';
import { ICONS } from './icons.js';
import { compileEffect, type EffectName, getKeyframeValue, type KeyframeMap } from './keyframes.js';
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
import { PALETTES, type PaletteName, THEMES, type ThemeName } from './themes.js';

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

/** Pre-loaded asset cache for images and sprites. */
export interface AssetCache {
  images: Map<string, Canvas>;
  sprites: Map<string, Awaited<ReturnType<typeof downsampleSprite>>>;
}

/** Preload all async assets referenced in elements. */
export async function preloadAssets(elements: SceneElement[]): Promise<AssetCache> {
  const cache: AssetCache = { images: new Map(), sprites: new Map() };

  await Promise.all(
    elements.map(async (el) => {
      if (el.type === 'image') {
        const source = el.source;
        if (!cache.images.has(source)) {
          // Fetch URL to temp file if it's https
          let localPath = source;
          if (source.startsWith('https://') || source.startsWith('http://')) {
            const { default: sharp } = await import('sharp');
            const resp = await fetch(source);
            if (!resp.ok) {
              throw invalidParams(`Failed to fetch image from "${source}": HTTP ${resp.status}`, {
                reason: 'asset_not_found',
              });
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const tmpPath = `/tmp/pixoo-img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
            await sharp(buf).png().toFile(tmpPath);
            localPath = tmpPath;
          }
          const loadOpts: Parameters<typeof loadImage>[1] = {
            fit: el.fit ?? 'contain',
            kernel: el.kernel ?? 'nearest',
            x: typeof el.x === 'number' ? el.x : 0,
            y: typeof el.y === 'number' ? el.y : 0,
          };
          if (el.w !== undefined) loadOpts.width = el.w;
          if (el.h !== undefined) loadOpts.height = el.h;
          const canvas = await loadImage(localPath, loadOpts);
          cache.images.set(source, canvas);
        }
      } else if (el.type === 'sprite') {
        const key = `${el.path}:${el.cols}:${el.rows}`;
        if (!cache.sprites.has(key)) {
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

  const dxAnim = Number(getKeyframeValue(kf ?? {}, 'dx', frameIdx, 0));
  const dyAnim = Number(getKeyframeValue(kf ?? {}, 'dy', frameIdx, 0));
  const dx = (el.dx ?? 0) + dxAnim;
  const dy = (el.dy ?? 0) + dyAnim;

  // If opacity < 100, render to scratch canvas and blit with alpha
  const target = opacity < 100 ? new Canvas(canvas.width as 16 | 32 | 64) : canvas;

  switch (el.type) {
    case 'text': {
      const style: TextStyle = el.style ?? {};
      if (!style.color && el.color) style.color = el.color;
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
        element: elIdx,
        type: 'text',
        box: { x: resolvedX, y: resolvedY, w: textW, h: textH },
        fits: resolvedX + textW <= canvas.width && resolvedY + textH <= canvas.height,
        action: 'none',
        font: fontVariant,
        scale,
      });
      break;
    }

    case 'icon': {
      let svgD: string;
      let viewBox = '0 0 16 16';

      if (el.name) {
        const iconEntry = ICONS[el.name];
        if (!iconEntry) {
          throw invalidParams(
            `Unknown icon "${el.name}". Use pixoo://reference/icons to browse available icons.`,
            { reason: 'unknown_icon' },
          );
        }
        svgD = iconEntry.d;
        viewBox = iconEntry.viewBox;
      } else if (el.d) {
        svgD = el.d;
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

      const color = el.color ? resolveColor(el.color) : ([255, 255, 255] as RGB);
      // Parse viewBox string ("0 0 W H") to extract dimensions [W, H]
      const vbParts = viewBox.split(/\s+/).map(Number);
      const vbW = vbParts[2] ?? 16;
      const vbH = vbParts[3] ?? 16;
      renderSvgPath(target, svgD, color, [vbW, vbH], [resolvedX, resolvedY, w, h]);

      layoutEntries.push({
        element: elIdx,
        type: 'icon',
        box: { x: resolvedX, y: resolvedY, w, h },
        fits: resolvedX + w <= canvas.width && resolvedY + h <= canvas.height,
        action: 'none',
      });
      break;
    }

    case 'rect': {
      const x = el.x + dx;
      const y = el.y + dy;
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
      } else if (el.color) {
        target.fillRect(x, y, el.w, el.h, resolveColor(el.color));
      }
      if (el.borderColor) {
        target.drawRect(x, y, el.w, el.h, resolveColor(el.borderColor));
      }
      layoutEntries.push({
        element: elIdx,
        type: 'rect',
        box: { x, y, w: el.w, h: el.h },
        fits: x + el.w <= canvas.width && y + el.h <= canvas.height,
        action: 'none',
      });
      break;
    }

    case 'circle': {
      const cx = el.cx + dx;
      const cy = el.cy + dy;
      const color = el.color ? resolveColor(el.color) : ([255, 255, 255] as RGB);
      if (el.fill !== false) {
        target.fillCircle(cx, cy, el.radius, color);
      } else {
        target.drawCircle(cx, cy, el.radius, color);
      }
      layoutEntries.push({
        element: elIdx,
        type: 'circle',
        box: { x: cx - el.radius, y: cy - el.radius, w: el.radius * 2, h: el.radius * 2 },
        fits: true,
        action: 'none',
      });
      break;
    }

    case 'line': {
      const color = el.color ? resolveColor(el.color) : ([255, 255, 255] as RGB);
      target.drawLine(el.x0 + dx, el.y0 + dy, el.x1 + dx, el.y1 + dy, color);
      layoutEntries.push({
        element: elIdx,
        type: 'line',
        box: {
          x: Math.min(el.x0, el.x1),
          y: Math.min(el.y0, el.y1),
          w: Math.abs(el.x1 - el.x0),
          h: Math.abs(el.y1 - el.y0),
        },
        fits: true,
        action: 'none',
      });
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

      layoutEntries.push({
        element: elIdx,
        type: 'progress',
        box: { x, y, w: el.w, h: el.h },
        fits: true,
        action: 'none',
      });
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
      const color = el.color ? resolveColor(el.color) : ([100, 200, 255] as RGB);

      if (el.kind === 'bar') {
        const barW = Math.max(1, Math.floor(el.w / data.length));
        for (let i = 0; i < data.length; i++) {
          const v = data[i] ?? 0;
          const h = Math.max(1, Math.round(((v - min_) / range) * el.h));
          target.fillRect(x + i * barW, y + el.h - h, barW - 1, h, color);
        }
      } else {
        const stepX = el.w / (data.length - 1);
        for (let i = 0; i < data.length - 1; i++) {
          const v0 = data[i] ?? 0;
          const v1 = data[i + 1] ?? 0;
          const x0 = Math.round(x + i * stepX);
          const y0 = y + el.h - Math.round(((v0 - min_) / range) * el.h);
          const x1 = Math.round(x + (i + 1) * stepX);
          const y1 = y + el.h - Math.round(((v1 - min_) / range) * el.h);
          target.drawLine(x0, y0, x1, y1, color);
        }
      }

      layoutEntries.push({
        element: elIdx,
        type: 'sparkline',
        box: { x, y, w: el.w, h: el.h },
        fits: true,
        action: 'none',
      });
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
      layoutEntries.push({
        element: elIdx,
        type: 'bitmap',
        box: { x, y, w: el.rows[0]?.length ?? 0, h: el.rows.length },
        fits: true,
        action: 'none',
      });
      break;
    }

    case 'pixels': {
      for (const pt of el.data) {
        const colorAnim = String(getKeyframeValue(kf ?? {}, 'color', frameIdx, pt.color));
        const c = resolveColor(colorAnim);
        target.setPixel(pt.x + dx, pt.y + dy, c);
      }
      layoutEntries.push({
        element: elIdx,
        type: 'pixels',
        box: { x: 0, y: 0, w: 0, h: 0 },
        fits: true,
        action: 'none',
      });
      break;
    }

    case 'image': {
      const cachedCanvas = assets.images.get(el.source);
      if (cachedCanvas) {
        canvas.blit(cachedCanvas, dx, dy);
      }
      layoutEntries.push({
        element: elIdx,
        type: 'image',
        box: { x: el.x ?? 0, y: el.y ?? 0, w: el.w ?? canvas.width, h: el.h ?? canvas.height },
        fits: true,
        action: 'none',
      });
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

        layoutEntries.push({
          element: elIdx,
          type: 'sprite',
          box: { x: resolvedX, y: resolvedY, w: spriteW, h: spriteH },
          fits: resolvedX + spriteW <= canvas.width && resolvedY + spriteH <= canvas.height,
          action: 'none',
        });
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
  size: 16 | 32 | 64 = 64,
): Promise<{ frames: Canvas[]; layoutEntries: LayoutEntry[] }> {
  const assets = await preloadAssets(elements);
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
