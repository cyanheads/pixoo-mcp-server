/**
 * @fileoverview pixoo_overlay_text tool — device-native scrolling text overlay.
 * @module mcp-server/tools/definitions/pixoo-overlay-text.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { resolveColor } from '@cyanheads/pixoo-toolkit';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooOverlayText = tool('pixoo_overlay_text', {
  title: 'pixoo_overlay_text',
  description:
    'Set or clear a device-native scrolling text overlay. Use mode "set" to add or update an overlay on a slot (0–19); use mode "clear" to remove it. Overlays use device-rendered fonts (115 font IDs, 0–114) and persist across channel switches until explicitly cleared with mode "clear". Not previewable — rendering happens on-device. Best for persistent tickers over pushed scenes; for styled, previewable text use pixoo_display_text instead.',
  annotations: { idempotentHint: true, destructiveHint: false },

  input: z.object({
    mode: z.enum(['set', 'clear']).describe('set = add/update overlay; clear = remove it.'),
    id: z
      .number()
      .int()
      .min(0)
      .max(19)
      .describe('Overlay slot ID (0–19). Each ID is an independent overlay layer.'),
    text: z.string().optional().describe('Text to display (required for mode=set).'),
    x: z
      .number()
      .int()
      .min(0)
      .max(64)
      .default(0)
      .describe('X start position on display (default: 0).'),
    y: z
      .number()
      .int()
      .min(0)
      .max(64)
      .default(0)
      .describe('Y start position on display (default: 0).'),
    font: z
      .number()
      .int()
      .min(0)
      .max(114)
      .default(0)
      .describe(
        'Device font ID (0–114). 0 = default, 18 = arrows, 20 = °C/°F. Device-rendered; no preview.',
      ),
    color: z.string().default('#ffffff').describe('Text color as CSS hex color (default: white).'),
    speed: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(50)
      .describe('Scroll speed (0–100, device units; default: 50).'),
    direction: z
      .enum(['left', 'right'])
      .default('left')
      .describe('Scroll direction (default: left).'),
    align: z
      .enum(['left', 'center', 'right'])
      .default('left')
      .describe('Text alignment (default: left).'),
    width: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Text region width in pixels (optional; defaults to display width).'),
  }),

  output: z.object({
    acknowledged: z
      .boolean()
      .describe('True when the device confirmed the overlay command (error_code: 0).'),
    mode: z
      .string()
      .describe('Operation performed: "set" (overlay added/updated) or "clear" (overlay removed).'),
    id: z.number().describe('The overlay slot ID (0–19) that was operated on.'),
  }),

  errors: [
    {
      reason: 'device_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device is not reachable.',
      retryable: true,
      recovery: 'Check the device is powered on and on the same network. Retry in a few seconds.',
    },
    {
      reason: 'device_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device firmware rejected the command.',
      recovery: 'Check the overlay ID is valid (0–19) and the device is in a ready state.',
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
      when: 'The color value could not be resolved.',
      recovery:
        'Use #RRGGBB hex format (e.g. "#ff0000"). Named color strings are not supported for overlays.',
    },
  ],

  async handler(input, ctx) {
    const svc = getPixooService();

    // Direction and align map to device integers
    const dirMap = { left: 0, right: 1 };
    const alignMap = { left: 1, center: 2, right: 3 };

    if (input.mode === 'clear') {
      ctx.log.info('Clearing text overlay', { id: input.id });
      const result = await svc.clearText(input.id, ctx);
      if (!result.ok) {
        throw ctx.fail(
          result.kind === 'network' || result.kind === 'timeout'
            ? 'device_unreachable'
            : 'device_rejected',
          `Clear overlay failed (${result.kind}): ${result.message}`,
        );
      }
      return { acknowledged: true, mode: 'clear', id: input.id };
    }

    // mode === 'set'
    if (!input.text) {
      throw validationError('text is required when mode is "set".');
    }

    ctx.log.info('Setting text overlay', { id: input.id, textLength: input.text.length });

    let color: ReturnType<typeof resolveColor>;
    try {
      color = resolveColor(input.color ?? '#ffffff');
    } catch (err) {
      throw ctx.fail(
        'invalid_color',
        `Invalid color "${input.color ?? '#ffffff'}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sendOpts: Parameters<typeof svc.sendText>[0] = {
      id: input.id,
      x: input.x,
      y: input.y,
      text: input.text,
      dir: dirMap[input.direction ?? 'left'],
      font: input.font,
      speed: input.speed,
      color,
      align: alignMap[input.align ?? 'left'],
    };
    if (input.width !== undefined) sendOpts.width = input.width;

    const result = await svc.sendText(sendOpts, ctx);

    if (!result.ok) {
      throw ctx.fail(
        result.kind === 'network' || result.kind === 'timeout'
          ? 'device_unreachable'
          : 'device_rejected',
        `Set overlay failed (${result.kind}): ${result.message}`,
      );
    }

    return { acknowledged: true, mode: 'set', id: input.id };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Overlay ${result.id} (mode: ${result.mode})** ${result.mode === 'clear' ? 'cleared' : 'set'} | Acknowledged: ${result.acknowledged}`,
    },
  ],
});
