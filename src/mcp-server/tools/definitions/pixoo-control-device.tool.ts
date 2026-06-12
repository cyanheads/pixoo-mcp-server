/**
 * @fileoverview pixoo_control_device tool — read or change device state.
 * @module mcp-server/tools/definitions/pixoo-control-device.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooControlDevice = tool('pixoo_control_device', {
  title: 'pixoo_control_device',
  description:
    'Read or change device state: brightness (0–100), screen on/off, channel, or clock face. Call with no params to read current state only. Supply any params to apply changes before reading back state. Use pixoo_discover_devices first if PIXOO_IP is not yet configured.',
  annotations: { idempotentHint: true, destructiveHint: false },

  input: z.object({
    brightness: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Set display brightness (0–100).'),
    screen: z.enum(['on', 'off']).optional().describe('Turn the display screen on or off.'),
    channel: z
      .enum(['faces', 'cloud', 'visualizer', 'custom'])
      .optional()
      .describe('Switch to a channel: faces, cloud, visualizer, or custom.'),
    clockFaceId: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Select a clock face by ID (channel must be faces).'),
  }),

  output: z.object({
    reachable: z.boolean().describe('True if device responded to the status read.'),
    channel: z
      .string()
      .optional()
      .describe(
        'Current channel name (faces, cloud, visualizer, or custom). Absent when device is unreachable.',
      ),
    brightness: z
      .number()
      .optional()
      .describe('Current brightness level (0–100). Absent when device is unreachable.'),
    screenOn: z
      .boolean()
      .optional()
      .describe('True if the screen is on. Absent when device is unreachable.'),
    clockId: z
      .number()
      .optional()
      .describe(
        'Current clock face ID (faces channel only). Absent on other channels or when device is unreachable.',
      ),
    applied: z
      .array(z.string())
      .describe(
        'Settings successfully applied in this call (e.g. "brightness:80", "screen:on"). Empty when called with no params or all changes failed. A requested setting that failed is absent here and reported in a notice instead.',
      ),
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
      when: 'Device rejected the command.',
      recovery: 'Check the parameter values are valid and the device is ready.',
    },
    {
      reason: 'no_device_configured',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'PIXOO_IP is not set.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
    },
  ],

  async handler(input, ctx) {
    const svc = getPixooService();
    const applied: string[] = [];

    // Apply changes
    if (input.brightness !== undefined) {
      const res = await svc.setBrightness(input.brightness, ctx);
      if (res.ok) applied.push(`brightness:${input.brightness}`);
      else ctx.enrich.notice(`brightness:${input.brightness} failed (${res.kind}): ${res.message}`);
    }

    if (input.screen !== undefined) {
      const res = await svc.setScreen(input.screen === 'on', ctx);
      if (res.ok) applied.push(`screen:${input.screen}`);
      else ctx.enrich.notice(`screen:${input.screen} failed (${res.kind}): ${res.message}`);
    }

    if (input.channel) {
      const res = await svc.setChannel(input.channel, ctx);
      if (res.ok) applied.push(`channel:${input.channel}`);
      else ctx.enrich.notice(`channel:${input.channel} failed (${res.kind}): ${res.message}`);
    }

    if (input.clockFaceId !== undefined) {
      const res = await svc.setClock(input.clockFaceId, ctx);
      if (res.ok) applied.push(`clockFace:${input.clockFaceId}`);
      else ctx.enrich.notice(`clockFace:${input.clockFaceId} failed (${res.kind}): ${res.message}`);
    }

    // Read current state
    const state = await svc.getStatus(ctx);

    return {
      reachable: state.reachable,
      channel: state.channel,
      brightness: state.brightness,
      screenOn: state.screenOn,
      clockId: state.clockId,
      applied,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Device Status**`);
    lines.push(`Reachable: ${result.reachable}`);
    if (result.channel) lines.push(`Channel: ${result.channel}`);
    if (result.brightness !== undefined) lines.push(`Brightness: ${result.brightness}`);
    if (result.screenOn !== undefined) lines.push(`Screen: ${result.screenOn ? 'On' : 'Off'}`);
    if (result.clockId !== undefined) lines.push(`Clock Face: ${result.clockId}`);
    if (result.applied.length > 0) {
      lines.push(`\nApplied: ${result.applied.join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
