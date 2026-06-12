/**
 * @fileoverview pixoo_push_image tool — load an image and push it to the Pixoo display.
 * @module mcp-server/tools/definitions/pixoo-push-image.tool
 */

import * as fs from 'node:fs/promises';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { loadImage, type PixooSize } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { savePngPreview } from '@/renderer/preview.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooPushImage = tool('pixoo_push_image', {
  title: 'pixoo_push_image',
  description:
    'Load an image (absolute local path or https URL), resize it to fit the LED grid, and optionally push it to the display. Returns the downsampled result as an image content block so you see exactly what the display received. Nearest-neighbor kernel preserves pixel art; use lanczos3 or mitchell for photos.',
  annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },

  input: z.object({
    source: z.string().describe('Absolute local file path or https URL of the image to display.'),
    fit: z
      .enum(['contain', 'cover', 'fill'])
      .default('contain')
      .describe('Resize fit mode: contain (letterbox), cover (crop to fill), fill (stretch).'),
    kernel: z
      .enum(['nearest', 'lanczos3', 'mitchell'])
      .default('nearest')
      .describe(
        'Resize kernel: nearest for pixel art, lanczos3 for photos, mitchell for a balance.',
      ),
    push: z
      .boolean()
      .default(true)
      .describe('Push the resized image to the device (default: true).'),
  }),

  output: z.object({
    pushed: z.boolean().describe('True when the device acknowledged the push.'),
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
    notice: z.string().optional().describe('Warning or informational message.'),
  },

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
      reason: 'asset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Image path or URL could not be read.',
      recovery: 'Verify the file path exists and is readable, or check the URL is reachable.',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const size = cfg.pixooSize as PixooSize;

    let localPath = input.source;

    // Handle URL: fetch to temp file
    if (input.source.startsWith('https://') || input.source.startsWith('http://')) {
      ctx.log.info('Fetching image from URL', { url: input.source });
      const resp = await fetch(input.source);
      if (!resp.ok) {
        throw ctx.fail(
          'asset_not_found',
          `Failed to fetch image from "${input.source}": HTTP ${resp.status}.`,
          { url: input.source, status: resp.status },
        );
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const { default: sharp } = await import('sharp');
      const tmpPath = `/tmp/pixoo-img-${Date.now()}.png`;
      await sharp(buf).png().toFile(tmpPath);
      localPath = tmpPath;
    } else {
      // Verify local file exists
      try {
        await fs.access(localPath);
      } catch {
        throw ctx.fail(
          'asset_not_found',
          `Image file not found: "${localPath}". Verify the absolute path is correct.`,
          { path: localPath },
        );
      }
    }

    ctx.log.info('Loading and resizing image', {
      path: localPath,
      fit: input.fit,
      kernel: input.kernel,
    });

    // Load and resize
    const canvas = await loadImage(localPath, {
      size,
      fit: input.fit,
      kernel: input.kernel,
    });

    // Save preview
    const outputFiles: string[] = [];
    const savedPath = await savePngPreview(canvas, `push-image-${Date.now()}`);
    if (savedPath) outputFiles.push(savedPath);

    // Push
    let pushed = false;
    let deviceState: import('@/services/pixoo/pixoo-service.js').DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      deviceState = await svc.pushFrame(canvas, ctx);
      pushed = true;
    }

    return {
      pushed,
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

    if (result.outputFiles?.length) {
      lines.push(`**Saved:** ${result.outputFiles.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
