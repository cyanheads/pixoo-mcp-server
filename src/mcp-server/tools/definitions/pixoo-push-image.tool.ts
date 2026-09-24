/**
 * @fileoverview pixoo_push_image tool — load an image and push it to the Pixoo display.
 * @module mcp-server/tools/definitions/pixoo-push-image.tool
 */

import * as fs from 'node:fs/promises';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { loadImage, type PixooSize } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { pushKeepingPreview, visibilityNotice } from '@/mcp-server/tools/device-push.js';
import {
  autoSavePreview,
  encodePreviewBlock,
  type PreviewWriter,
  savePngPreview,
} from '@/renderer/preview.js';
import { fetchRemoteImageToTempPng, isRemoteSource } from '@/renderer/remote-image.js';
import { type DeviceStateSnapshot, getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooPushImage = tool('pixoo_push_image', {
  title: 'pixoo_push_image',
  description:
    'Load an image (absolute local path or https URL), resize it to fit the LED grid, and optionally push it to the display. Returns the downsampled result as an image content block so you see exactly what the display received. Nearest-neighbor kernel preserves pixel art; use lanczos3 or mitchell for photos.',
  annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },

  input: z.object({
    source: z
      .string()
      .describe('Absolute local file path or https (not http) URL of the image to display.'),
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
      thrownBy: 'service',
    },
    {
      reason: 'device_http_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The device answered with a non-2xx HTTP status (retryable for 408, 429, 500, and 502–504).',
      recovery:
        'The device may be busy or rebooting; wait a few seconds and retry. If it persists, run pixoo_discover_devices to confirm PIXOO_IP points at the Pixoo.',
      thrownBy: 'service',
    },
    {
      reason: 'device_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device firmware returned a non-zero error code.',
      recovery: 'Note the device error code and check the Pixoo documentation.',
      thrownBy: 'service',
    },
    {
      reason: 'no_device_configured',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'PIXOO_IP is not set.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
      thrownBy: 'service',
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

    // The toolkit's loadImage reads from disk, so a remote source is staged to a
    // temp PNG first and unlinked once it has been read.
    let tmpPathToCleanup: string | undefined;
    if (isRemoteSource(input.source)) {
      ctx.log.info('Fetching image from URL', { url: input.source });
      tmpPathToCleanup = await fetchRemoteImageToTempPng(input.source, ctx);
    } else {
      try {
        await fs.access(input.source);
      } catch {
        throw ctx.fail(
          'asset_not_found',
          `Image file not found: "${input.source}". Verify the absolute path is correct.`,
          { path: input.source, ...ctx.recoveryFor('asset_not_found') },
        );
      }
    }
    const localPath = tmpPathToCleanup ?? input.source;

    ctx.log.info('Loading and resizing image', { fit: input.fit, kernel: input.kernel });

    // Load and resize (then clean up temp file if one was written)
    const canvas = await loadImage(localPath, {
      size,
      fit: input.fit,
      kernel: input.kernel,
    });
    if (tmpPathToCleanup) {
      fs.unlink(tmpPathToCleanup).catch(() => undefined);
    }

    // The downsampled result rides content[] as an image block. It is deliberately
    // absent from `output` — routing it through ctx.content carries the base64 once
    // instead of duplicating it into structuredContent.
    ctx.content.image(encodePreviewBlock(canvas).data, 'image/png');

    const baseName = `push-image-${Date.now()}`;
    const writePreview: PreviewWriter = (dir) => savePngPreview(canvas, dir, baseName);
    const outputFiles = await autoSavePreview(writePreview);

    let pushed = false;
    let deviceState: DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      deviceState = await pushKeepingPreview(
        () => svc.pushFrame(canvas, ctx),
        outputFiles,
        writePreview,
      );
      pushed = true;
      const notice = visibilityNotice(deviceState);
      if (notice) ctx.enrich.notice(notice);
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
