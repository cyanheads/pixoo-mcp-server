/**
 * @fileoverview Tool definition for 'pixoo_compose'.
 * Compose a scene from layered elements and push to the Pixoo device —
 * static or animated. Supports text, images, sprites, shapes, bitmaps,
 * and per-element animation keyframes.
 * @module src/mcp-server/tools/definitions/pixoo-compose.tool
 */
import { mkdir } from 'node:fs/promises';

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/index.js';
import { AppConfig, PixooClientToken } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/index.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { type RequestContext, logger } from '@/utils/index.js';
import {
  Canvas,
  Channel,
  type ColorLike,
  type PixooSize,
  type RGB,
  type SpriteCell,
  FONT_5x7,
  FONT_3x5,
  drawText,
  drawTextCentered,
  loadImage,
  downsampleSprite,
  renderSprite,
  resolveColor,
  lerpColor,
  savePng,
  saveAnimationGif,
} from '@cyanheads/pixoo-toolkit';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
const TOOL_NAME = 'pixoo_compose';
const TOOL_TITLE = 'Pixoo Compose';
const TOOL_DESCRIPTION =
  'Compose a scene from layered elements (text, images, sprites, shapes, bitmaps, pixels) and push to the Pixoo device. Supports multi-frame animation with per-element keyframes for smooth property tweening. Automatically switches to the custom channel before pushing.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------
// Keyframe schema — shared across all animated properties
// ---------------------------------------------------------------------------
const KeyframeSchema = z
  .array(
    z.tuple([
      z.number().int().min(0),
      z.union([z.number(), z.string(), z.boolean()]),
    ]),
  )
  .describe('Array of [frame, value] keyframe pairs.');

const AnimateSchema = z
  .record(z.string(), KeyframeSchema)
  .optional()
  .describe(
    'Animate element properties across frames. Keys are property names, values are keyframe arrays. Numbers interpolate linearly, colors lerp, booleans snap.',
  );

// ---------------------------------------------------------------------------
// Element schemas
// ---------------------------------------------------------------------------
const TextElementSchema = z.object({
  type: z.literal('text'),
  text: z.string().describe('Text to render.'),
  x: z.number().int().default(0).describe('X position.'),
  y: z.number().int().default(0).describe('Y position.'),
  color: z.string().default('white').describe('Text color (hex or named).'),
  font: z
    .enum(['standard', 'compact'])
    .default('standard')
    .describe("Bitmap font: 'standard' (5x7) or 'compact' (3x5)."),
  scale: z.number().int().min(1).default(1).describe('Pixel scale factor.'),
  centered: z
    .boolean()
    .default(false)
    .describe('Center text horizontally on canvas (ignores x).'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const ImageElementSchema = z.object({
  type: z.literal('image'),
  path: z.string().min(1).describe('Absolute path to image file.'),
  x: z.number().int().default(0).describe('X offset on canvas.'),
  y: z.number().int().default(0).describe('Y offset on canvas.'),
  width: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Target width. Defaults to canvas size.'),
  height: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Target height. Defaults to canvas size.'),
  fit: z
    .enum(['contain', 'cover', 'fill'])
    .default('contain')
    .describe('Resize mode.'),
  kernel: z
    .enum(['nearest', 'lanczos3', 'mitchell'])
    .default('nearest')
    .describe('Interpolation kernel.'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const SpriteElementSchema = z.object({
  type: z.literal('sprite'),
  path: z.string().min(1).describe('Absolute path to sprite sheet PNG.'),
  cols: z
    .number()
    .int()
    .min(1)
    .describe('Number of columns in the sprite grid.'),
  rows: z.number().int().min(1).describe('Number of rows in the sprite grid.'),
  x: z.number().int().optional().describe('X offset (default: centered).'),
  y: z.number().int().default(0).describe('Y offset.'),
  scale: z.number().int().min(1).optional().describe('Pixel scale factor.'),
  bodyColor: z
    .string()
    .optional()
    .describe('Override body color (hex or named).'),
  darkColor: z
    .string()
    .optional()
    .describe('Override dark/eye color (hex or named).'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const RectElementSchema = z.object({
  type: z.literal('rect'),
  x: z.number().int().describe('X position.'),
  y: z.number().int().describe('Y position.'),
  w: z.number().int().min(1).describe('Width.'),
  h: z.number().int().min(1).describe('Height.'),
  color: z.string().default('white').describe('Color.'),
  fill: z.boolean().default(true).describe('Filled (true) or stroked (false).'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const CircleElementSchema = z.object({
  type: z.literal('circle'),
  cx: z.number().int().describe('Center X.'),
  cy: z.number().int().describe('Center Y.'),
  radius: z.number().int().min(1).describe('Radius.'),
  color: z.string().default('white').describe('Color.'),
  fill: z.boolean().default(true).describe('Filled (true) or stroked (false).'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const LineElementSchema = z.object({
  type: z.literal('line'),
  x0: z.number().int().describe('Start X.'),
  y0: z.number().int().describe('Start Y.'),
  x1: z.number().int().describe('End X.'),
  y1: z.number().int().describe('End Y.'),
  color: z.string().default('white').describe('Color.'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const BitmapElementSchema = z.object({
  type: z.literal('bitmap'),
  x: z.number().int().default(0).describe('X offset.'),
  y: z.number().int().default(0).describe('Y offset.'),
  palette: z
    .array(z.string())
    .min(1)
    .describe(
      'Color palette. Index 0 = first char in row strings. Empty string = transparent.',
    ),
  data: z
    .array(z.string())
    .min(1)
    .describe('Row strings. Each character is a palette index (0–9, a–z).'),
  scale: z.number().int().min(1).default(1).describe('Pixel scale multiplier.'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const PixelsElementSchema = z.object({
  type: z.literal('pixels'),
  data: z
    .array(
      z.object({
        x: z.number().int().describe('Pixel X.'),
        y: z.number().int().describe('Pixel Y.'),
        color: z.string().describe('Pixel color.'),
      }),
    )
    .min(1)
    .describe('Array of individual pixels to set.'),
  visible: z
    .boolean()
    .default(true)
    .describe('Whether to render this element.'),
  animate: AnimateSchema,
});

const ElementSchema = z
  .discriminatedUnion('type', [
    TextElementSchema,
    ImageElementSchema,
    SpriteElementSchema,
    RectElementSchema,
    CircleElementSchema,
    LineElementSchema,
    BitmapElementSchema,
    PixelsElementSchema,
  ])
  .describe('A visual element to compose onto the canvas.');

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------
const InputSchema = z
  .object({
    background: z
      .string()
      .default('black')
      .describe("Canvas fill color before drawing elements. Default: 'black'."),
    elements: z
      .array(ElementSchema)
      .min(1)
      .describe('Ordered list of elements to draw (back-to-front).'),
    frames: z
      .number()
      .int()
      .min(1)
      .max(40)
      .default(1)
      .describe('Frame count for animation (1 = static). Max 40.'),
    speed: z
      .number()
      .int()
      .min(10)
      .default(150)
      .describe('Animation frame duration in ms.'),
    push: z
      .boolean()
      .default(true)
      .describe('Push to device. Set false to only save a preview PNG.'),
    output: z
      .string()
      .optional()
      .describe(
        'Absolute path to save a preview PNG. If omitted, no preview is saved.',
      ),
  })
  .describe(
    'Compose a scene from layered elements and push to the Pixoo device.',
  );

const OutputSchema = z
  .object({
    frames: z.number().describe('Number of frames rendered.'),
    pushed: z
      .boolean()
      .describe('Whether the result was pushed to the device.'),
    outputFiles: z
      .array(z.string())
      .optional()
      .describe('Paths of saved preview PNGs.'),
  })
  .describe('Result of the compose operation.');

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type Element = z.infer<typeof ElementSchema>;

// ---------------------------------------------------------------------------
// Keyframe interpolation
// ---------------------------------------------------------------------------
type KeyframeValue = number | string | boolean;
type Keyframe = [number, KeyframeValue];

function interpolateKeyframes(
  keyframes: Keyframe[],
  frame: number,
): KeyframeValue {
  if (keyframes.length === 0) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Keyframe array cannot be empty.',
    );
  }

  // Sort by frame index
  const sorted = [...keyframes].sort((a, b) => a[0] - b[0]);
  const first = sorted[0] as Keyframe;
  const last = sorted[sorted.length - 1] as Keyframe;

  // Before first keyframe — hold first value
  if (frame <= first[0]) return first[1];
  // After last keyframe — hold last value
  if (frame >= last[0]) return last[1];

  // Find surrounding keyframes
  let lo: Keyframe = first;
  let hi: Keyframe = last;
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i] as Keyframe;
    const next = sorted[i + 1] as Keyframe;
    if (frame >= cur[0] && frame <= next[0]) {
      lo = cur;
      hi = next;
      break;
    }
  }

  const loVal = lo[1];
  const hiVal = hi[1];
  const span = hi[0] - lo[0];
  const t = span === 0 ? 0 : (frame - lo[0]) / span;

  // Numeric — linear interpolation
  if (typeof loVal === 'number' && typeof hiVal === 'number') {
    return loVal + (hiVal - loVal) * t;
  }

  // Color strings — lerp RGB
  if (typeof loVal === 'string' && typeof hiVal === 'string') {
    const a = resolveColor(loVal);
    const b = resolveColor(hiVal);
    const result = lerpColor(a, b, t);
    return `#${result.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }

  // Boolean / mixed — snap at keyframe
  return frame >= hi[0] ? hiVal : loVal;
}

/**
 * Resolve animated properties for an element at a given frame index.
 * Returns a shallow copy with animated values applied.
 */
function resolveAnimatedProps<T extends Element>(element: T, frame: number): T {
  if (!element.animate) return element;

  const resolved = { ...element };
  for (const [prop, keyframes] of Object.entries(element.animate)) {
    const value = interpolateKeyframes(keyframes as Keyframe[], frame);
    (resolved as Record<string, unknown>)[prop] = value;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Pre-loaded asset cache types
// ---------------------------------------------------------------------------
interface PreloadedImage {
  canvas: Canvas;
}
interface PreloadedSprite {
  grid: SpriteCell[][];
  bodyColor: RGB;
  darkColor: RGB;
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------
function renderText(
  canvas: Canvas,
  el: z.infer<typeof TextElementSchema>,
): void {
  const font = el.font === 'compact' ? FONT_3x5 : FONT_5x7;
  if (el.centered) {
    drawTextCentered(canvas, el.text, el.y, el.color, {
      font,
      scale: el.scale,
    });
  } else {
    drawText(canvas, el.text, el.x, el.y, el.color, { font, scale: el.scale });
  }
}

function renderImage(
  canvas: Canvas,
  el: z.infer<typeof ImageElementSchema>,
  preloaded: PreloadedImage,
): void {
  canvas.blit(preloaded.canvas, el.x, el.y);
}

function renderSpriteElement(
  canvas: Canvas,
  el: z.infer<typeof SpriteElementSchema>,
  preloaded: PreloadedSprite,
): void {
  renderSprite(canvas, preloaded.grid, {
    ...(el.scale !== undefined && { scale: el.scale }),
    ...(el.x !== undefined && { x: el.x }),
    y: el.y,
    ...(el.bodyColor && {
      bodyColor: resolveColor(el.bodyColor),
      originalBodyColor: preloaded.bodyColor,
    }),
    ...(el.darkColor && {
      darkColor: resolveColor(el.darkColor),
      originalDarkColor: preloaded.darkColor,
    }),
  });
}

function renderRect(
  canvas: Canvas,
  el: z.infer<typeof RectElementSchema>,
): void {
  if (el.fill) {
    canvas.fillRect(el.x, el.y, el.w, el.h, el.color);
  } else {
    canvas.drawRect(el.x, el.y, el.w, el.h, el.color);
  }
}

function renderCircle(
  canvas: Canvas,
  el: z.infer<typeof CircleElementSchema>,
): void {
  if (el.fill) {
    canvas.fillCircle(el.cx, el.cy, el.radius, el.color);
  } else {
    canvas.drawCircle(el.cx, el.cy, el.radius, el.color);
  }
}

function renderLine(
  canvas: Canvas,
  el: z.infer<typeof LineElementSchema>,
): void {
  canvas.drawLine(el.x0, el.y0, el.x1, el.y1, el.color);
}

function renderBitmap(
  canvas: Canvas,
  el: z.infer<typeof BitmapElementSchema>,
): void {
  for (let row = 0; row < el.data.length; row++) {
    const rowStr = el.data[row] ?? '';
    for (let col = 0; col < rowStr.length; col++) {
      const code = rowStr.charCodeAt(col);
      // 0–9 → indices 0–9, a–z → indices 10–35
      const idx = code >= 48 && code <= 57 ? code - 48 : code - 87;
      if (idx < 0 || idx >= el.palette.length) continue;
      const color = el.palette[idx];
      if (!color) continue; // transparent
      for (let sy = 0; sy < el.scale; sy++) {
        for (let sx = 0; sx < el.scale; sx++) {
          canvas.setPixel(
            el.x + col * el.scale + sx,
            el.y + row * el.scale + sy,
            color,
          );
        }
      }
    }
  }
}

function renderPixels(
  canvas: Canvas,
  el: z.infer<typeof PixelsElementSchema>,
): void {
  for (const px of el.data) {
    canvas.setPixel(px.x, px.y, px.color);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------
async function composeLogic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const client = container.resolve(PixooClientToken);
  const config = container.resolve(AppConfig);
  const size = config.pixoo.size as PixooSize;

  logger.debug('pixoo_compose invoked', {
    ...appContext,
    elementCount: input.elements.length,
    frames: input.frames,
  });

  // --- Pre-load async assets (images, sprites) ---
  const imageCache = new Map<number, PreloadedImage>();
  const spriteCache = new Map<number, PreloadedSprite>();

  const preloadPromises: Promise<void>[] = [];
  for (const [i, el] of input.elements.entries()) {
    if (el.type === 'image') {
      preloadPromises.push(
        loadImage(el.path, {
          size,
          width: el.width ?? size,
          height: el.height ?? size,
          fit: el.fit,
          kernel: el.kernel,
        }).then((canvas) => {
          imageCache.set(i, { canvas });
        }),
      );
    } else if (el.type === 'sprite') {
      preloadPromises.push(
        downsampleSprite(el.path, el.cols, el.rows).then((result) => {
          spriteCache.set(i, result);
        }),
      );
    }
  }
  await Promise.all(preloadPromises);

  // --- Render frames ---
  const canvasFrames: Canvas[] = [];

  for (let frame = 0; frame < input.frames; frame++) {
    const canvas = new Canvas(size);
    canvas.clear(input.background as ColorLike);

    for (const [i, rawEl] of input.elements.entries()) {
      const el = resolveAnimatedProps(rawEl, frame);

      if (el.visible === false) continue;

      switch (el.type) {
        case 'text':
          renderText(canvas, el);
          break;
        case 'image': {
          const cached = imageCache.get(i);
          if (cached) renderImage(canvas, el, cached);
          break;
        }
        case 'sprite': {
          const cached = spriteCache.get(i);
          if (cached) renderSpriteElement(canvas, el, cached);
          break;
        }
        case 'rect':
          renderRect(canvas, el);
          break;
        case 'circle':
          renderCircle(canvas, el);
          break;
        case 'line':
          renderLine(canvas, el);
          break;
        case 'bitmap':
          renderBitmap(canvas, el);
          break;
        case 'pixels':
          renderPixels(canvas, el);
          break;
      }
    }

    canvasFrames.push(canvas);
  }

  // --- Save preview ---
  let outputFiles: string[] | undefined;
  const isAnimated = canvasFrames.length > 1;

  if (input.output) {
    // Explicit output path — use as-is
    const firstFrame = canvasFrames[0];
    if (!isAnimated && firstFrame) {
      await savePng(firstFrame, input.output);
      outputFiles = [input.output];
    } else {
      const gifPath = input.output.replace(/\.png$/i, '.gif');
      await saveAnimationGif(canvasFrames, gifPath, input.speed);
      outputFiles = [gifPath];
    }
  } else if (config.pixoo.outputDir) {
    // Auto-save to configured output directory
    const dir = config.pixoo.outputDir;
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const firstFrame = canvasFrames[0];
    if (!isAnimated && firstFrame) {
      const path = `${dir}/compose-${ts}.png`;
      await savePng(firstFrame, path);
      outputFiles = [path];
    } else {
      const path = `${dir}/compose-${ts}.gif`;
      await saveAnimationGif(canvasFrames, path, input.speed);
      outputFiles = [path];
    }
  }

  // --- Push to device ---
  if (input.push) {
    await client.setChannel(Channel.Custom);

    const firstFrame = canvasFrames[0];
    if (canvasFrames.length === 1 && firstFrame) {
      await client.push(firstFrame);
    } else {
      await client.pushAnimation(canvasFrames, input.speed);
    }
  }

  return {
    frames: canvasFrames.length,
    pushed: input.push,
    outputFiles,
  };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------
function responseFormatter(result: Output): ContentBlock[] {
  const parts: string[] = [];

  if (result.frames === 1) {
    parts.push(
      result.pushed ? 'Pushed static frame to device' : 'Rendered static frame',
    );
  } else {
    parts.push(
      result.pushed
        ? `Pushed ${result.frames}-frame animation to device`
        : `Rendered ${result.frames}-frame animation`,
    );
  }

  if (result.outputFiles?.length) {
    parts.push(`Saved: ${result.outputFiles.join(', ')}`);
  }

  return [{ type: 'text', text: parts.join('\n') }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const pixooComposeTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:pixoo:write'], composeLogic),
  responseFormatter,
};
