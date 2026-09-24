/**
 * @fileoverview pixoo_control_device tool — read or change device state.
 * @module mcp-server/tools/definitions/pixoo-control-device.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { PixooResult } from '@cyanheads/pixoo-toolkit';
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

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Requested settings that failed, each with its failure kind and message (e.g. "brightness:80 failed (network): …"), joined by "; ". Absent when every requested setting applied.',
      ),
  },

  errors: [
    {
      reason: 'no_device_configured',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'PIXOO_IP is not set.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getPixooService();
    const applied: string[] = [];
    const failed: string[] = [];

    const record = (setting: string, res: PixooResult) => {
      if (res.ok) applied.push(setting);
      else failed.push(`${setting} failed (${res.kind}): ${res.message}`);
    };

    // Apply changes
    if (input.brightness !== undefined) {
      record(`brightness:${input.brightness}`, await svc.setBrightness(input.brightness, ctx));
    }
    if (input.screen !== undefined) {
      record(`screen:${input.screen}`, await svc.setScreen(input.screen === 'on', ctx));
    }
    if (input.channel) {
      record(`channel:${input.channel}`, await svc.setChannel(input.channel, ctx));
    }
    if (input.clockFaceId !== undefined) {
      record(`clockFace:${input.clockFaceId}`, await svc.setClock(input.clockFaceId, ctx));
    }

    // ctx.enrich.notice is last-wins, so every failure goes out in one call.
    if (failed.length > 0) ctx.enrich.notice(failed.join('; '));

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
