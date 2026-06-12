/**
 * @fileoverview pixoo_display_text tool — the 80% case: render styled text and push it.
 * @module mcp-server/tools/definitions/pixoo-display-text.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { Canvas, FONT_3x5, FONT_5x7, measureText, type PixooSize } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { encodePreviewBlock, savePngPreview } from '@/renderer/preview.js';
import { applyBackground, type BackgroundSpec } from '@/renderer/scene-renderer.js';
import {
  drawStyledText,
  type LayoutEntry,
  renderAutoFitText,
  resolveX,
  type TextStyle,
} from '@/renderer/text-engine.js';
import { THEMES, type ThemeName } from '@/renderer/themes.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

const StyleSchema = z
  .object({
    palette: z
      .union([
        z
          .enum(['ember', 'ice', 'neon', 'fire', 'lavender', 'claude', 'mono'])
          .describe('Named built-in color palette for the vertical ramp.'),
        z
          .object({
            from: z.string().describe('Gradient start color (top).'),
            to: z.string().describe('Gradient end color (bottom).'),
          })
          .describe('Custom gradient stop: specify top and bottom colors directly.'),
      ])
      .optional()
      .describe('Named palette or custom gradient stop for vertical color ramp.'),
    shadow: z.boolean().optional().describe('Drop shadow behind the text.'),
    outline: z.boolean().optional().describe('1px contrasting outline for legibility.'),
    scale: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe('Integer pixel scale multiplier (1 = normal, 2 = chunky block letters).'),
    color: z.string().optional().describe('Flat color when not using a palette.'),
  })
  .describe('Text style options.');

export const pixooDisplayText = tool('pixoo_display_text', {
  title: 'pixoo_display_text',
  description:
    'Render styled text (theme, gradient, shadow, outline, auto-fit) onto the Pixoo display and push it. Returns the rendered frame as an image content block for immediate inspection. The primary tool for text-only display — for layers, icons, widgets, or animations use pixoo_compose_scene. Run pixoo_design_brief with topic "text" first for palette and legibility guidance.',
  annotations: { idempotentHint: true, destructiveHint: false },

  input: z.object({
    text: z
      .union([
        z.string().describe('Single string of text to display.'),
        z.array(z.string()).describe('Lines of text.'),
      ])
      .describe('Text to display. String or array of lines.'),
    theme: z
      .enum(['midnight', 'ember', 'claude', 'ice', 'neon', 'forest', 'mono'])
      .optional()
      .describe('Named scene theme — sets background gradient and default text palette.'),
    background: z
      .union([
        z.string().describe('Solid CSS hex color.'),
        z
          .object({
            gradient: z
              .object({
                type: z.enum(['v', 'h']).describe('v = vertical, h = horizontal.'),
                from: z.string().describe('Gradient start color.'),
                to: z.string().describe('Gradient end color.'),
              })
              .describe('Gradient background specification.'),
          })
          .describe('Gradient background object.'),
      ])
      .optional()
      .describe('Background color or gradient. Overrides theme background when set.'),
    style: StyleSchema.optional().describe('Text style: palette, shadow, outline, scale.'),
    font: z
      .enum(['standard', 'compact'])
      .optional()
      .describe('Font variant: standard (5×7) or compact (3×5). Auto-fit will choose if omitted.'),
    position: z
      .object({
        x: z
          .union([
            z.number().describe('Absolute pixel X coordinate (0 = left edge).'),
            z.enum(['left', 'center', 'right']).describe('Semantic horizontal alignment.'),
          ])
          .optional()
          .describe('X position or alignment (default: center).'),
        y: z
          .union([
            z.number().describe('Absolute pixel Y coordinate (0 = top edge).'),
            z.enum(['top', 'center', 'bottom']).describe('Semantic vertical alignment.'),
          ])
          .optional()
          .describe('Y position or alignment (default: center).'),
      })
      .optional()
      .describe('Text position on the display.'),
    align: z
      .enum(['left', 'center', 'right'])
      .optional()
      .describe('Multi-line text alignment (default: center).'),
    effect: z
      .enum(['none', 'auto', 'scroll', 'float', 'pulse'])
      .optional()
      .describe(
        'Animation effect. auto = scroll only when text overflows. Produces a multi-frame result.',
      ),
    push: z
      .boolean()
      .default(true)
      .describe('Push the rendered frame to the device (default: true).'),
    brightness: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Set device brightness before push (0–100). Failure is a warning, not an error.'),
  }),

  output: z.object({
    pushed: z.boolean().describe('True when the device acknowledged the push.'),
    layout: z
      .array(
        z
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
              .describe('Resolved bounding box.'),
            fits: z.boolean().describe('Whether the element fits in the canvas.'),
            action: z
              .enum(['none', 'shrunk-to-compact', 'scrolling', 'wrapped', 'truncated', 'clipped'])
              .describe('Overflow action taken by the renderer.'),
            font: z.enum(['standard', 'compact']).optional().describe('Font variant used.'),
            scale: z.number().optional().describe('Scale factor applied.'),
          })
          .describe('Layout report entry for one element.'),
      )
      .describe('Layout report: every fit decision the renderer made.'),
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
        'Absolute paths to saved PNG preview files. Present only when PIXOO_OUTPUT_DIR is configured.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Warning or informational message about the render or push.'),
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
      when: 'PIXOO_IP is not set.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
    },
    {
      reason: 'invalid_color',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A color value could not be resolved.',
      recovery:
        'Use #RRGGBB hex or a named color. See pixoo://reference/themes for palette colors.',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const size = cfg.pixooSize as PixooSize;

    // Resolve text lines
    const lines = Array.isArray(input.text) ? input.text : [input.text];
    const combinedText = lines.join(' ');

    // Resolve background
    let bg: BackgroundSpec;
    if (input.background) {
      if (typeof input.background === 'string') {
        bg = input.background;
      } else {
        bg = { gradient: input.background.gradient };
      }
    } else if (input.theme) {
      bg = { theme: input.theme as ThemeName };
    } else {
      bg = '#000000';
    }

    // Resolve style
    const defaultPalette = input.theme
      ? (THEMES[input.theme as ThemeName]?.textPalette ?? undefined)
      : undefined;
    const defaultShadow = input.theme ? (THEMES[input.theme as ThemeName]?.shadow ?? false) : false;

    const style: TextStyle = {
      shadow: input.style?.shadow ?? defaultShadow,
    };
    if (input.style?.outline !== undefined) style.outline = input.style.outline;
    if (input.style?.scale !== undefined) style.scale = input.style.scale;
    if (input.style?.color !== undefined) style.color = input.style.color;
    const resolvedPalette = input.style?.palette ?? defaultPalette;
    if (resolvedPalette !== undefined) style.palette = resolvedPalette;

    // Build canvas
    const canvas = new Canvas(size);
    applyBackground(canvas, bg);

    const layoutEntries: LayoutEntry[] = [];

    // Render text — support multi-line by stacking
    if (lines.length === 1) {
      const entry = renderAutoFitText(
        canvas,
        combinedText,
        input.position?.x ?? 'center',
        input.position?.y ?? 'center',
        0,
        0,
        style,
        'auto',
        0,
        0,
        1,
      );
      layoutEntries.push(entry);
    } else {
      // Multi-line: stack lines vertically
      const fontVariant = input.font === 'compact' ? 'compact' : 'standard';
      const font = fontVariant === 'compact' ? FONT_3x5 : FONT_5x7;
      const scale = style.scale ?? 1;
      const lineH = font.height * scale + 1;
      const totalH = lines.length * lineH;
      const startY =
        input.position?.y === 'top'
          ? 0
          : input.position?.y === 'bottom'
            ? size - totalH
            : typeof input.position?.y === 'number'
              ? input.position.y
              : Math.floor((size - totalH) / 2);

      for (let li = 0; li < lines.length; li++) {
        const lineText = lines[li] ?? '';
        const lineW = measureText(lineText, { font, scale });
        const lineX = resolveX(input.position?.x ?? 'center', lineW, size, 0);
        const lineY = startY + li * lineH;
        drawStyledText(canvas, lineText, lineX, lineY, style, fontVariant);
        layoutEntries.push({
          element: li,
          type: 'text',
          box: { x: lineX, y: lineY, w: lineW, h: font.height * scale },
          fits: lineX + lineW <= size && lineY + font.height * scale <= size,
          action: 'none',
          font: fontVariant,
          scale,
        });
      }
    }

    // Encode preview (returned in content[] as image block by framework via format)
    encodePreviewBlock(canvas);

    // Optional: save preview file
    const outputFiles: string[] = [];
    const savedPath = await savePngPreview(canvas, `display-text-${Date.now()}`);
    if (savedPath) outputFiles.push(savedPath);

    // Handle brightness
    if (input.push && input.brightness !== undefined && input.brightness !== null) {
      const svc = getPixooService();
      const brightnessResult = await svc.setBrightness(input.brightness, ctx);
      if (!brightnessResult.ok) {
        ctx.enrich.notice(
          `Brightness set to ${input.brightness} failed (${brightnessResult.kind}): ${brightnessResult.message}. Render and push will continue.`,
        );
      }
    }

    // Push
    let pushed = false;
    let deviceState: import('@/services/pixoo/pixoo-service.js').DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      ctx.log.info('Pushing display_text to device', { textLength: combinedText.length });
      deviceState = await svc.pushFrame(canvas, ctx);
      pushed = true;
    }

    return {
      pushed,
      layout: layoutEntries,
      deviceState,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Pushed:** ${result.pushed ? 'Yes' : 'No'}`);

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
        `  [${entry.element}] ${entry.type} @ (${entry.box.x},${entry.box.y}) ${entry.box.w}×${entry.box.h}` +
          ` fits:${entry.fits} action:${entry.action}${fontInfo}${scaleInfo}`,
      );
    }

    if (result.outputFiles?.length) {
      lines.push(`\n**Saved:** ${result.outputFiles.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
