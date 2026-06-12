/**
 * @fileoverview pixoo_compose_scene tool — full scene composition with layered elements.
 * @module mcp-server/tools/definitions/pixoo-compose-scene.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { Canvas, NAMED_COLORS, type PixooSize } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { ICONS } from '@/renderer/icons.js';
import {
  buildContactSheet,
  encodePreviewBlock,
  saveGifPreview,
  savePngPreview,
} from '@/renderer/preview.js';
import { type BackgroundSpec, renderScene } from '@/renderer/scene-renderer.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

// --- Shared sub-schemas ---

const EffectSchema = z
  .object({
    name: z
      .enum([
        'float',
        'scroll-left',
        'scroll-right',
        'pulse',
        'blink',
        'twinkle',
        'drift',
        'fade-in',
        'fade-out',
      ])
      .describe('Named animation preset.'),
    amplitude: z
      .number()
      .optional()
      .describe(
        'Effect intensity: pixels of movement for float/scroll/drift, 0–1 scale for fade/pulse. Default varies by effect (float: 2px).',
      ),
    period: z
      .number()
      .optional()
      .describe('Effect period in frames. Defaults to total scene frame count.'),
    phase: z
      .number()
      .optional()
      .describe(
        'Phase offset 0–1 to stagger this element relative to others (0.5 = half-cycle offset).',
      ),
  })
  .describe('Named animation effect preset.');

const AnimateSchema = z
  .record(
    z.string(),
    z
      .array(
        z.tuple([
          z.number().describe('Frame index.'),
          z.union([z.number(), z.string(), z.boolean()]).describe('Value at this frame.'),
        ]),
      )
      .describe('Keyframe entries: [[frame, value], ...].'),
  )
  .describe('Raw keyframe map: { property: [[frame, value], ...] }.');

const BaseElementProps = {
  visible: z.boolean().optional().describe('Whether the element is visible (default: true).'),
  opacity: z.number().int().min(0).max(100).optional().describe('Opacity 0–100 (default: 100).'),
  dx: z.number().int().optional().describe('X offset nudge in pixels.'),
  dy: z.number().int().optional().describe('Y offset nudge in pixels.'),
  effect: EffectSchema.optional().describe('Named animation preset for this element.'),
  animate: AnimateSchema.optional().describe('Raw keyframe animation map for this element.'),
};

const XPosSchema = z
  .union([
    z.number().describe('Absolute pixel X coordinate (0 = left edge).'),
    z.enum(['left', 'center', 'right']).describe('Semantic horizontal alignment.'),
  ])
  .describe('X position: integer pixel or semantic alignment.');

const YPosSchema = z
  .union([
    z.number().describe('Absolute pixel Y coordinate (0 = top edge).'),
    z.enum(['top', 'center', 'bottom']).describe('Semantic vertical alignment.'),
  ])
  .describe('Y position: integer pixel or semantic alignment.');

const StyleSchema = z
  .object({
    palette: z
      .union([
        z
          .enum(['ember', 'ice', 'neon', 'fire', 'lavender', 'claude', 'mono'])
          .describe('Named built-in color palette for the vertical ramp.'),
        z
          .object({
            from: z.string().describe('Top color.'),
            to: z.string().describe('Bottom color.'),
          })
          .describe('Custom gradient stop: specify top and bottom colors directly.'),
      ])
      .optional()
      .describe('Palette name or custom gradient stop for vertical color ramp.'),
    shadow: z.boolean().optional().describe('Drop shadow.'),
    outline: z.boolean().optional().describe('1px outline.'),
    scale: z.number().int().min(1).max(8).optional().describe('Integer pixel scale multiplier.'),
    color: z.string().optional().describe('Flat color override.'),
  })
  .describe('Text style options.');

// --- Element schemas ---

const TextElementSchema = z.object({
  type: z.literal('text').describe('Text element type.'),
  text: z.string().describe('Text content to render.'),
  x: XPosSchema.optional().describe('X position (default: 0).'),
  y: YPosSchema.optional().describe('Y position (default: 0).'),
  color: z.string().optional().describe('Flat text color.'),
  font: z.enum(['standard', 'compact']).optional().describe('Font variant.'),
  style: StyleSchema.optional().describe('Text style options.'),
  ...BaseElementProps,
});

const IconElementSchema = z.object({
  type: z.literal('icon').describe('Icon element type.'),
  name: z.string().optional().describe('Built-in icon name (see pixoo://reference/icons).'),
  d: z.string().optional().describe('Custom SVG path d attribute.'),
  viewBox: z.string().optional().describe('SVG viewBox string (default: "0 0 16 16").'),
  x: XPosSchema.optional().describe('X position.'),
  y: YPosSchema.optional().describe('Y position.'),
  w: z.number().int().optional().describe('Render width in pixels (default: 12).'),
  h: z.number().int().optional().describe('Render height in pixels (default: 12).'),
  color: z.string().optional().describe('Icon fill color.'),
  palette: z
    .enum(['ember', 'ice', 'neon', 'fire', 'lavender', 'claude', 'mono'])
    .optional()
    .describe('Named palette for colored icon.'),
  ...BaseElementProps,
});

const RectElementSchema = z.object({
  type: z.literal('rect').describe('Rectangle element type.'),
  x: z.number().int().describe('X coordinate.'),
  y: z.number().int().describe('Y coordinate.'),
  w: z.number().int().min(1).describe('Width in pixels.'),
  h: z.number().int().min(1).describe('Height in pixels.'),
  color: z.string().optional().describe('Fill color.'),
  gradient: z
    .object({
      type: z.enum(['v', 'h']).describe('v = vertical, h = horizontal.'),
      from: z.string().describe('Start color.'),
      to: z.string().describe('End color.'),
    })
    .optional()
    .describe('Gradient fill.'),
  borderColor: z.string().optional().describe('1px border color.'),
  ...BaseElementProps,
});

const CircleElementSchema = z.object({
  type: z.literal('circle').describe('Circle element type.'),
  cx: z.number().int().describe('Center X coordinate.'),
  cy: z.number().int().describe('Center Y coordinate.'),
  radius: z.number().int().min(1).describe('Radius in pixels.'),
  color: z.string().optional().describe('Circle color.'),
  fill: z.boolean().optional().describe('Filled or outline only (default: true).'),
  ...BaseElementProps,
});

const LineElementSchema = z.object({
  type: z.literal('line').describe('Line element type.'),
  x0: z.number().int().describe('Start X coordinate.'),
  y0: z.number().int().describe('Start Y coordinate.'),
  x1: z.number().int().describe('End X coordinate.'),
  y1: z.number().int().describe('End Y coordinate.'),
  color: z.string().optional().describe('Line color.'),
  ...BaseElementProps,
});

const ProgressElementSchema = z.object({
  type: z.literal('progress').describe('Progress bar widget type.'),
  x: z.number().int().describe('X coordinate.'),
  y: z.number().int().describe('Y coordinate.'),
  w: z.number().int().min(1).describe('Width in pixels.'),
  h: z.number().int().min(1).describe('Height in pixels.'),
  value: z.number().describe('Current value.'),
  max: z.number().describe('Maximum value.'),
  palette: z
    .enum(['ember', 'ice', 'neon', 'fire', 'lavender', 'claude', 'mono'])
    .optional()
    .describe('Named palette for gradient fill.'),
  trackColor: z.string().optional().describe('Background track color.'),
  label: z.string().optional().describe('Optional label rendered on the bar.'),
  ...BaseElementProps,
});

const SparklineElementSchema = z.object({
  type: z.literal('sparkline').describe('Sparkline chart widget type.'),
  x: z.number().int().describe('X coordinate.'),
  y: z.number().int().describe('Y coordinate.'),
  w: z.number().int().min(2).describe('Width in pixels.'),
  h: z.number().int().min(2).describe('Height in pixels.'),
  data: z.array(z.number()).min(2).describe('Data points for the chart.'),
  color: z.string().optional().describe('Line or bar color.'),
  kind: z.enum(['line', 'bar']).optional().describe('Chart style (default: line).'),
  ...BaseElementProps,
});

const BitmapElementSchema = z.object({
  type: z.literal('bitmap').describe('Bitmap element using palette indices.'),
  x: z.number().int().describe('X coordinate.'),
  y: z.number().int().describe('Y coordinate.'),
  rows: z
    .array(z.string())
    .describe('Row strings of hex palette indices (0-F, space = transparent).'),
  palette: z.array(z.string()).describe('Color palette: array of hex colors indexed 0-F.'),
  ...BaseElementProps,
});

const PixelsElementSchema = z.object({
  type: z.literal('pixels').describe('Sparse pixel dots element.'),
  data: z
    .array(
      z
        .object({
          x: z.number().int().describe('Pixel X coordinate.'),
          y: z.number().int().describe('Pixel Y coordinate.'),
          color: z.string().describe('Pixel color.'),
        })
        .describe('A single pixel: position and color.'),
    )
    .describe('Array of pixel positions and colors.'),
  ...BaseElementProps,
});

const ImageElementSchema = z.object({
  type: z.literal('image').describe('Image element (local path or https URL).'),
  source: z.string().describe('Absolute local file path or https URL.'),
  x: z.number().int().optional().describe('X offset on canvas (default: 0).'),
  y: z.number().int().optional().describe('Y offset on canvas (default: 0).'),
  w: z.number().int().optional().describe('Target width (default: canvas width).'),
  h: z.number().int().optional().describe('Target height (default: canvas height).'),
  fit: z
    .enum(['contain', 'cover', 'fill'])
    .optional()
    .describe('Resize fit mode (default: contain).'),
  kernel: z
    .enum(['nearest', 'lanczos3', 'mitchell'])
    .optional()
    .describe('Resize kernel: nearest for pixel art, lanczos3 for photos (default: nearest).'),
  ...BaseElementProps,
});

const SpriteElementSchema = z.object({
  type: z.literal('sprite').describe('Sprite sheet element.'),
  path: z.string().describe('Absolute local path to the sprite sheet image.'),
  cols: z.number().int().min(1).describe('Number of columns in the sprite grid.'),
  rows: z.number().int().min(1).describe('Number of rows in the sprite grid.'),
  x: XPosSchema.optional().describe('X position (default: center).'),
  y: z.number().int().optional().describe('Y position (default: 0).'),
  scale: z.number().int().min(1).optional().describe('Pixel scale factor.'),
  bodyColor: z.string().optional().describe('Override body color.'),
  darkColor: z.string().optional().describe('Override dark/eye color.'),
  ...BaseElementProps,
});

const ElementSchema = z
  .discriminatedUnion('type', [
    TextElementSchema.describe('Styled text element rendered at a position.'),
    IconElementSchema.describe('Built-in or custom SVG icon element.'),
    RectElementSchema.describe('Filled or gradient rectangle element.'),
    CircleElementSchema.describe('Filled or outline circle element.'),
    LineElementSchema.describe('Single-pixel line element.'),
    ProgressElementSchema.describe('Horizontal progress bar widget.'),
    SparklineElementSchema.describe('Sparkline chart widget (line or bar).'),
    BitmapElementSchema.describe('Bitmap element using explicit palette indices.'),
    PixelsElementSchema.describe('Sparse scatter of individually colored pixels.'),
    ImageElementSchema.describe('External image element (local path or https URL).'),
    SpriteElementSchema.describe('Sprite sheet element for character or tile art.'),
  ])
  .describe('A scene element.');

const LayoutEntrySchema = z
  .object({
    element: z
      .union([
        z.number().describe('Zero-based index of the element in the input array.'),
        z.literal('background'),
      ])
      .describe('Element index or "background" for the background layer.'),
    type: z.string().describe('Element type.'),
    box: z
      .object({
        x: z.number().describe('X coordinate of bounding box.'),
        y: z.number().describe('Y coordinate of bounding box.'),
        w: z.number().describe('Width of bounding box.'),
        h: z.number().describe('Height of bounding box.'),
      })
      .describe('Resolved bounding box after layout.'),
    fits: z.boolean().describe('Whether the element fits in the canvas.'),
    action: z
      .enum(['none', 'shrunk-to-compact', 'scrolling', 'wrapped', 'truncated', 'clipped'])
      .describe('Overflow action taken by the renderer.'),
    font: z.enum(['standard', 'compact']).optional().describe('Font variant used (text only).'),
    scale: z.number().optional().describe('Scale factor applied (text only).'),
  })
  .describe('Layout report entry.');

export const pixooComposeScene = tool('pixoo_compose_scene', {
  title: 'pixoo_compose_scene',
  description:
    'Compose a full scene: layered elements (text, icons, widgets, shapes, bitmaps, images, sprites) with per-element effects and keyframes, static or animated. Returns the rendered scene as an image content block for immediate inspection. Elements render back-to-front in array order. For text-only display use pixoo_display_text; run pixoo_design_brief with topic "scene" or "dashboard" for layout and palette guidance.',
  annotations: { idempotentHint: true, destructiveHint: false },

  input: z.object({
    background: z
      .union([
        z.string().describe('Solid CSS hex color.'),
        z
          .object({
            gradient: z
              .object({
                type: z.enum(['v', 'h', 'r']).describe('v = vertical, h = horizontal, r = radial.'),
                from: z.string().describe('Gradient start color.'),
                to: z.string().describe('Gradient end color.'),
              })
              .describe('Gradient background.'),
          })
          .describe('Gradient background: specify type and two colors.'),
        z
          .object({
            theme: z
              .enum(['midnight', 'ember', 'claude', 'ice', 'neon', 'forest', 'mono'])
              .describe('Named theme.'),
          })
          .describe("Named theme background: uses the theme's preset gradient."),
      ])
      .describe('Scene background: solid color, gradient, or named theme.'),
    elements: z
      .array(ElementSchema)
      .max(50)
      .describe('Scene elements rendered back-to-front. Up to 50 elements.'),
    frames: z
      .number()
      .int()
      .min(1)
      .max(40)
      .default(1)
      .describe('Number of animation frames (1–40, default: 1). 20 frames at 150ms ≈ 3s loop.'),
    speed: z
      .number()
      .int()
      .min(10)
      .max(2000)
      .default(150)
      .describe('Milliseconds per frame for animations (default: 150ms).'),
    push: z.boolean().default(true).describe('Push to device (default: true).'),
    output: z
      .string()
      .optional()
      .describe('Explicit output file path for saving (overrides PIXOO_OUTPUT_DIR).'),
  }),

  output: z.object({
    pushed: z
      .boolean()
      .describe(
        'True when the device acknowledged the push. False when push: false or push failed.',
      ),
    previewData: z
      .string()
      .optional()
      .describe(
        'Base64-encoded PNG preview of the rendered scene (8× upscaled, 512px). For animations: the middle frame.',
      ),
    previewMimeType: z.enum(['image/png']).optional().describe('MIME type of the preview image.'),
    frames: z
      .number()
      .describe('Number of frames in the rendered output (1 for static, 2–40 for animations).'),
    layout: z.array(LayoutEntrySchema).describe('Layout report for each element.'),
    deviceState: z
      .object({
        reachable: z.boolean().describe('True if device responded.'),
        channel: z.string().optional().describe('Current channel name.'),
        brightness: z
          .number()
          .optional()
          .describe('Current brightness level (0–100). Absent when device is unreachable.'),
        screenOn: z
          .boolean()
          .optional()
          .describe('True if screen is on. Absent when device is unreachable.'),
        clockId: z
          .number()
          .optional()
          .describe('Current clock face ID (faces channel only). Absent on other channels.'),
      })
      .optional()
      .describe('Device state after the push. Absent when push: false.'),
    outputFiles: z
      .array(z.string())
      .optional()
      .describe(
        'Absolute paths to saved output files (PNG for static, GIF for animations). Present only when PIXOO_OUTPUT_DIR is configured or output is set.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Warning or informational notice about the render or push.'),
  },

  errors: [
    {
      reason: 'device_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device is not reachable over the network.',
      retryable: true,
      recovery: 'Check the device is powered on and on the same network. Retry in a few seconds.',
    },
    {
      reason: 'device_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device firmware returned a non-zero error code.',
      recovery: 'Note the device error code and check the Pixoo documentation.',
    },
    {
      reason: 'no_device_configured',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'PIXOO_IP is not set and push was requested.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
    },
    {
      reason: 'asset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An image or sprite path could not be read.',
      recovery: 'Verify the file path exists and is readable, or check the URL is reachable.',
    },
    {
      reason: 'invalid_color',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A color value could not be resolved.',
      recovery: 'Use #RRGGBB hex or a named color. See pixoo://reference/themes for palettes.',
    },
    {
      reason: 'unknown_icon',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Icon name not found in the registry.',
      recovery: 'Check pixoo://reference/icons for available icon names and categories.',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const size = cfg.pixooSize as PixooSize;

    // Resolve background
    let bg: BackgroundSpec;
    if (typeof input.background === 'string') {
      bg = input.background;
    } else if ('gradient' in input.background) {
      bg = { gradient: input.background.gradient };
    } else {
      bg = { theme: input.background.theme };
    }

    ctx.log.info('Rendering scene', {
      elements: input.elements.length,
      frames: input.frames,
      push: input.push,
    });

    // Render — catch color/icon resolution errors and route through the error contract
    const validColorNames = Object.keys(NAMED_COLORS).join(', ');
    const validIconNames = Object.keys(ICONS).join(', ');
    let renderedFrames: Awaited<ReturnType<typeof renderScene>>['frames'];
    let layoutEntries: Awaited<ReturnType<typeof renderScene>>['layoutEntries'];
    try {
      ({ frames: renderedFrames, layoutEntries } = await renderScene(
        bg,
        // biome-ignore lint: elements are validated by zod discriminated union
        input.elements as any,
        input.frames,
        size,
      ));
    } catch (err) {
      if (err instanceof Error && err.message.includes('Unknown color')) {
        throw ctx.fail(
          'invalid_color',
          `${err.message}. Valid named colors: ${validColorNames}. See pixoo://reference/themes for palette colors.`,
        );
      }
      if (err instanceof McpError && err.data?.['reason'] === 'unknown_icon') {
        throw ctx.fail(
          'unknown_icon',
          `${err.message} Valid icons: ${validIconNames}. See pixoo://reference/icons.`,
        );
      }
      throw err;
    }

    // Preview (returned in content[] as image block via format)
    const isAnimation = renderedFrames.length > 1;
    const previewBlock = isAnimation
      ? buildContactSheet(renderedFrames)
      : encodePreviewBlock(renderedFrames[0] ?? new Canvas(size));

    // Save files
    const outputFiles: string[] = [];
    const baseName = `scene-${Date.now()}`;

    if (isAnimation) {
      const gifPath = await saveGifPreview(renderedFrames, input.speed, baseName);
      if (gifPath) outputFiles.push(gifPath);
    } else {
      const firstFrame = renderedFrames[0];
      if (firstFrame) {
        const pngPath = await savePngPreview(firstFrame, baseName);
        if (pngPath) outputFiles.push(pngPath);
      }
    }

    // Handle explicit output path
    if (input.output) {
      const firstFrame = renderedFrames[0];
      if (firstFrame) {
        const { savePng } = await import('@cyanheads/pixoo-toolkit');
        await savePng(firstFrame, input.output);
        outputFiles.push(input.output);
      }
    }

    // Push
    let pushed = false;
    let deviceState: import('@/services/pixoo/pixoo-service.js').DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      if (isAnimation) {
        deviceState = await svc.pushAnimation(renderedFrames, input.speed, ctx);
      } else {
        const firstFrame = renderedFrames[0];
        if (firstFrame) {
          deviceState = await svc.pushFrame(firstFrame, ctx);
        }
      }
      pushed = true;
    }

    return {
      pushed,
      previewData: previewBlock.data,
      previewMimeType: 'image/png' as const,
      frames: renderedFrames.length,
      layout: layoutEntries,
      deviceState,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Pushed:** ${result.pushed ? 'Yes' : 'No'} | **Frames:** ${result.frames}`);

    if (result.deviceState) {
      const ds = result.deviceState;
      lines.push(
        `**Device:** ${ds.reachable ? 'Reachable' : 'Unreachable'}` +
          (ds.channel ? ` | Channel: ${ds.channel}` : '') +
          (ds.brightness !== undefined ? ` | Brightness: ${ds.brightness}` : '') +
          (ds.screenOn !== undefined ? ` | Screen: ${ds.screenOn ? 'On' : 'Off'}` : '') +
          (ds.clockId !== undefined ? ` | Clock: ${ds.clockId}` : ''),
      );
    }

    lines.push('\n**Layout:**');
    for (const entry of result.layout) {
      const fontInfo = entry.font ? ` font:${entry.font}` : '';
      const scaleInfo = entry.scale !== undefined ? ` scale:${entry.scale}` : '';
      lines.push(
        `  [${entry.element}] ${entry.type} @ (${entry.box.x},${entry.box.y}) ${entry.box.w}×${entry.box.h} fits:${entry.fits} action:${entry.action}${fontInfo}${scaleInfo}`,
      );
    }

    if (result.outputFiles?.length) {
      lines.push(`\n**Saved:** ${result.outputFiles.join(', ')}`);
    }

    const items: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    > = [{ type: 'text', text: lines.join('\n') }];
    if (result.previewData && result.previewMimeType) {
      items.push({ type: 'image', data: result.previewData, mimeType: result.previewMimeType });
    }
    return items;
  },
});
