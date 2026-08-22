/**
 * @fileoverview pixoo://device/status resource — live device snapshot.
 * @module mcp-server/resources/definitions/pixoo-device-status.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooDeviceStatusResource = resource('pixoo://device/status', {
  name: 'device-status',
  title: 'Pixoo Device Status',
  description:
    'Live snapshot of the connected Pixoo display: reachable, channel, brightness, screen state, and display size. Degrades gracefully when the device is unreachable — returns reachable: false instead of an error.',
  mimeType: 'application/json',
  params: z.object({}),
  // No cacheHint: this is live device state, so every read must reach the device.

  output: z.object({
    reachable: z.boolean().describe('True when the device answered the status read.'),
    channel: z
      .string()
      .optional()
      .describe('Current channel name. Absent when the device is unreachable.'),
    brightness: z
      .number()
      .optional()
      .describe('Current brightness level (0–100). Absent when the device is unreachable.'),
    screenOn: z
      .boolean()
      .optional()
      .describe('True when the screen is on. Absent when the device is unreachable.'),
    clockId: z
      .number()
      .optional()
      .describe('Current clock face ID (faces channel only). Absent on other channels.'),
    displaySize: z.number().describe('Configured display size in pixels (16, 32, or 64).'),
    configuredIp: z
      .string()
      .nullable()
      .describe('Configured PIXOO_IP value, or null when the server has no device configured.'),
  }),

  async handler(_params, ctx) {
    const cfg = getServerConfig();
    const svc = getPixooService();
    const status = await svc.getStatus(ctx);
    return {
      reachable: status.reachable,
      channel: status.channel,
      brightness: status.brightness,
      screenOn: status.screenOn,
      clockId: status.clockId,
      displaySize: cfg.pixooSize,
      configuredIp: cfg.pixooIp ?? null,
    };
  },

  list: async () => ({
    resources: [
      {
        uri: 'pixoo://device/status',
        name: 'device-status',
        mimeType: 'application/json',
        description: 'Live device snapshot: reachable, channel, brightness, screen, size.',
      },
    ],
  }),
});
