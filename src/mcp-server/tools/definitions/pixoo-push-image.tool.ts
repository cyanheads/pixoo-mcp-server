/**
 * @fileoverview pixoo_push_image tool — load an image and push it to the Pixoo display.
 * @module mcp-server/tools/definitions/pixoo-push-image.tool
 */

import * as fs from 'node:fs/promises';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type Canvas,
  type LoadedAnimation,
  loadAnimation,
  loadImage,
  NAMED_COLORS,
  type PixooSize,
  tryResolveColor,
} from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { getServerConfig } from '@/config/server-config.js';
import { ImageSourceSchema } from '@/mcp-server/tools/asset-source-schema.js';
import { pushKeepingPreview, visibilityNotice } from '@/mcp-server/tools/device-push.js';
import { FinishSchema } from '@/mcp-server/tools/finish-schema.js';
import { finishFrames } from '@/renderer/finish.js';
import {
  autoSavePreview,
  buildContactSheet,
  type PreviewWriter,
  saveGifPreview,
  savePngPreview,
} from '@/renderer/preview.js';
import { fetchRemoteImageBytes, isRemoteSource } from '@/renderer/remote-image.js';
import { decodeFailureMessage } from '@/renderer/scene-renderer.js';
import { type DeviceStateSnapshot, getPixooService } from '@/services/pixoo/pixoo-service.js';

/** Frames the device plays without turning unstable; a longer source is sampled down to this. */
const MAX_FRAMES = 40;

/** Formats the decoder reports that may hold several frames. */
const ANIMATED_FORMATS: ReadonlySet<string> = new Set(['gif', 'webp']);

/** Per-frame speed, in ms, for an animation whose source records no delays. */
const DEFAULT_SPEED_MS = 150;

/** The per-frame speed range, in ms, an animation pushes at — as on pixoo_compose_scene. */
const MIN_SPEED_MS = 10;
const MAX_SPEED_MS = 2000;

/**
 * Decode `image` into display-size frames. A source the decoder reports as GIF or WebP
 * loads every frame, sampled evenly down to {@link MAX_FRAMES}; any other format loads
 * as a still. The content decides, not the file extension.
 */
async function loadFrames(
  image: string | Uint8Array,
  placement: Parameters<typeof loadImage>[1],
): Promise<LoadedAnimation> {
  const { format } = await sharp(image).metadata();
  if (ANIMATED_FORMATS.has(format)) {
    return loadAnimation(image, { ...placement, maxFrames: MAX_FRAMES });
  }
  return { frames: [await loadImage(image, placement)], delays: [0], sourceFrames: 1 };
}

/**
 * The one per-frame speed that keeps the loop's length: the delays' total over the
 * frame count, rounded and clamped to the device's range. A source with no recorded
 * timing plays at {@link DEFAULT_SPEED_MS}.
 */
function loopSpeed(delays: readonly number[]): number {
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  if (total === 0) return DEFAULT_SPEED_MS;
  return Math.min(MAX_SPEED_MS, Math.max(MIN_SPEED_MS, Math.round(total / delays.length)));
}

export const pixooPushImage = tool('pixoo_push_image', {
  title: 'pixoo_push_image',
  description:
    'Load an image (absolute local path or https URL), resize it to fit the LED grid, and optionally push it to the display. An animated GIF or WebP pushes as an animation of up to 40 frames, sampled evenly from a longer source and played at the speed that keeps its loop length. Returns the downsampled result as an image content block so you see exactly what the display received — a grid of every frame for an animation. Nearest-neighbor kernel preserves pixel art; use lanczos3 or mitchell for photos. finish reduces the result to a small or fixed palette, optionally dithered.',
  annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },

  input: z.object({
    source: ImageSourceSchema.describe(
      'Absolute local file path or https (not http) URL of the image to display; a relative path is rejected. An animated GIF or WebP, whatever its file name, pushes as an animation.',
    ),
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
    speed: z
      .number()
      .int()
      .min(MIN_SPEED_MS)
      .max(MAX_SPEED_MS)
      .optional()
      .describe(
        "Milliseconds per frame for an animated source (10–2000). Default: the source's total duration over the pushed frame count, or 150 when it records no delays. A still ignores it.",
      ),
    finish: FinishSchema.optional(),
    push: z
      .boolean()
      .default(true)
      .describe('Push the resized image to the device (default: true).'),
  }),

  output: z.object({
    pushed: z.boolean().describe('True when the device acknowledged the push.'),
    frames: z
      .number()
      .describe('Frames rendered and pushed: 1 for a still, 2–40 for an animation.'),
    sourceFrames: z
      .number()
      .describe('Frames in the source before sampling down to 40: 1 for a still.'),
    speed: z
      .number()
      .optional()
      .describe('Milliseconds per frame the animation plays at. Absent for a still.'),
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
        'Absolute paths to saved preview files: a PNG for a still, a GIF at the pushed speed for an animation. Present only when PIXOO_OUTPUT_DIR is configured.',
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
      recovery:
        'Pass an absolute path to an existing, readable image file, or a reachable https URL serving 10 MiB or less.',
    },
    {
      reason: 'invalid_image',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The source was read but did not decode as an image.',
      recovery:
        'The source must be a complete PNG, JPEG, GIF, WebP, AVIF, TIFF, or SVG image; a text file, an HTML page, or a truncated download will not decode.',
    },
    {
      reason: 'invalid_color',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A finish palette entry could not be resolved to a color.',
      recovery:
        'Use a hex color (#RRGGBB or #RGB, with or without the #) or a case-insensitive named color such as white, orange, or claude.',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const size = cfg.pixooSize as PixooSize;

    // Checked before the source is read: a typo in the palette must not cost a download.
    const unknownColor =
      input.finish && 'palette' in input.finish
        ? input.finish.palette.find((color) => !tryResolveColor(color))
        : undefined;
    if (unknownColor !== undefined) {
      throw ctx.fail(
        'invalid_color',
        `Unknown color in finish.palette: "${unknownColor}". Valid named colors: ${Object.keys(NAMED_COLORS).join(', ')}.`,
      );
    }

    let image: string | Uint8Array = input.source;
    if (isRemoteSource(input.source)) {
      ctx.log.info('Fetching image from URL', { url: input.source });
      image = await fetchRemoteImageBytes(input.source, ctx);
    } else {
      try {
        await fs.access(input.source, fs.constants.R_OK);
      } catch {
        throw ctx.fail(
          'asset_not_found',
          `Image file not found or unreadable: "${input.source}". Verify the absolute path is correct and readable.`,
          { path: input.source },
        );
      }
    }

    ctx.log.info('Loading and resizing image', { fit: input.fit, kernel: input.kernel });
    const loaded = await loadFrames(image, {
      size,
      fit: input.fit,
      kernel: input.kernel,
    }).catch((err: unknown) => {
      throw ctx.fail(
        'invalid_image',
        decodeFailureMessage('Image source', input.source, err),
        { source: input.source },
        { cause: err },
      );
    });
    const { delays, sourceFrames } = loaded;
    const frames = input.finish ? finishFrames(loaded.frames, input.finish) : loaded.frames;
    const [first] = frames as [Canvas, ...Canvas[]];
    const speed = frames.length > 1 ? (input.speed ?? loopSpeed(delays)) : undefined;

    // The downsampled result (a grid of every frame for an animation) rides content[] as
    // an image block. It is deliberately absent from `output` — routing it through
    // ctx.content carries the base64 once instead of duplicating it into structuredContent.
    ctx.content.image((await buildContactSheet(frames)).data, 'image/png');

    const baseName = `push-image-${Date.now()}`;
    const writePreview: PreviewWriter = (dir) =>
      speed === undefined
        ? savePngPreview(first, dir, baseName)
        : saveGifPreview(frames, speed, dir, baseName);
    const outputFiles = await autoSavePreview(writePreview);

    let pushed = false;
    let deviceState: DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      deviceState = await pushKeepingPreview(
        () =>
          speed === undefined ? svc.pushFrame(first, ctx) : svc.pushAnimation(frames, speed, ctx),
        outputFiles,
        writePreview,
      );
      pushed = true;
      const notice = visibilityNotice(deviceState);
      if (notice) ctx.enrich.notice(notice);
    }

    return {
      pushed,
      frames: frames.length,
      sourceFrames,
      ...(speed !== undefined && { speed }),
      deviceState,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const frames = `**Frames:** ${result.frames} of ${result.sourceFrames} source frame${result.sourceFrames === 1 ? '' : 's'}`;
    const speed = result.speed !== undefined ? ` | **Speed:** ${result.speed} ms per frame` : '';
    lines.push(`**Pushed:** ${result.pushed ? 'Yes' : 'No'} | ${frames}${speed}`);

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
