/**
 * @fileoverview pixoo_render_html tool — render an HTML page in a headless browser,
 * frame by frame on a virtual clock, and push it to the Pixoo display.
 * @module mcp-server/tools/definitions/pixoo-render-html.tool
 */

import * as path from 'node:path';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type Canvas, NAMED_COLORS, savePng, tryResolveColor } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { pushKeepingPreview, visibilityNotice } from '@/mcp-server/tools/device-push.js';
import { FinishSchema } from '@/mcp-server/tools/finish-schema.js';
import { finishFrames } from '@/renderer/finish.js';
import { pageRuntime, pageScripts } from '@/renderer/page-scripts.js';
import {
  autoSavePreview,
  buildContactSheet,
  encodePanelGif,
  type PreviewWriter,
  saveGifPreview,
  savePanelGif,
  savePngPreview,
} from '@/renderer/preview.js';
import { frameStepExpression, pageDocument } from '@/renderer/virtual-clock.js';
import {
  BROWSER_UNAVAILABLE_RECOVERY,
  getBrowserRenderer,
  RENDER_DEADLINE_MS,
} from '@/services/browser/browser-renderer.js';
import {
  type DeviceStateSnapshot,
  getPixooService,
  MAX_FRAME_PUSH,
} from '@/services/pixoo/pixoo-service.js';

/** Longest `html` accepted, in characters. */
const MAX_HTML_CHARS = 500_000;

/** Most frames a render captures; past MAX_FRAME_PUSH the device downloads them as one GIF. */
const MAX_FRAMES = 800;

/** Most entries `pageErrors` returns, and the most characters in each (and in a `page_error`). */
const MAX_PAGE_ERRORS = 20;
const MAX_PAGE_ERROR_CHARS = 500;

export const pixooRenderHtml = tool('pixoo_render_html', {
  title: 'pixoo_render_html',
  description: `Render an HTML page — a full document or a body fragment, with inline CSS, Canvas, SVG, or WebGL — in a headless browser at the panel size, and optionally push it to the display. Animate it by capturing up to 800 frames on a virtual clock that advances speed ms per frame: window.render(t, frame), when the page defines it, runs before each capture with t = frame / frames, so periodic motion loops seamlessly; CSS animations, requestAnimationFrame, timers, Date, and performance.now follow the same clock, so every frame is deterministic. The page loads nothing from the network and starts no workers; a page with no background renders on black, which the panel shows as unlit. Every page gets a pixoo global before its own scripts run: pixoo.text, pixoo.icon, and pixoo.palettes draw crisp bitmap text, gradient palettes, and icons exactly as pixoo_compose_scene does. Returns the captured result as an image content block — for an animation, a grid of its frames — and the page's uncaught and console errors as pageErrors. Run pixoo_design_brief with topic "html" first for loop, clock, sampling, legibility, and pixoo runtime guidance.`,
  annotations: { idempotentHint: true, destructiveHint: false },

  input: z.object({
    html: z
      .string()
      .max(MAX_HTML_CHARS)
      .describe(
        'The page to render: a full HTML document or a body fragment, up to 500,000 characters, served with <!doctype html> prepended. It lays out in a square viewport one CSS pixel per LED (64×64 on a Pixoo-64). Inline scripts and styles run and data: and blob: URLs load; a network URL is blocked and listed in pageErrors.',
      ),
    frames: z
      .number()
      .int()
      .min(1)
      .max(MAX_FRAMES)
      .default(1)
      .describe(
        'Number of frames to capture (1–800, default: 1). At frame i, window.render gets t = i / frames and performance.now() reads i × speed. Up to 40 push frame by frame; more play as one GIF the device downloads from this host, so the device must reach it (behind NAT or a firewall, set PIXOO_SERVE_HOST and PIXOO_SERVE_PORT), and speed rounds to the nearest 10 ms.',
      ),
    speed: z
      .number()
      .int()
      .min(10)
      .max(2000)
      .default(150)
      .describe(
        'Milliseconds per frame (10–2000, default: 150): how far the virtual clock advances between captures, and how fast the animation plays.',
      ),
    sampling: z
      .enum(['native', 'supersample'])
      .default('native')
      .describe(
        'native (default) captures one CSS pixel per LED. supersample renders at 8× and averages each 8×8 block into one LED, so transforms, text, SVG, and canvas shade smoothly; a plain box still snaps to whole CSS pixels (left: 0.5px lands on one LED), so move it with transform for sub-pixel motion.',
      ),
    finish: FinishSchema.optional(),
    push: z.boolean().default(true).describe('Push to device (default: true).'),
    output: z
      .string()
      .optional()
      .describe(
        'Absolute, already-normalized path to save the first frame to as a PNG. Replaces the PIXOO_OUTPUT_DIR auto-save for this call, so outputFiles holds only this path.',
      ),
  }),

  output: z.object({
    pushed: z
      .boolean()
      .describe(
        'True when the device acknowledged the push; past 40 frames, once it accepted the GIF play, requested the file, and the whole file was handed to the OS to send (the device does not confirm receipt). False when push: false.',
      ),
    frames: z
      .number()
      .describe('Number of frames captured (1 for a still, 2–800 for an animation).'),
    pageErrors: z
      .array(z.string().describe('One uncaught error, console.error message, or blocked URL.'))
      .describe(
        "The page's uncaught errors, console.error output, and blocked request URLs, in the order they arrived: the first 20, each cut to 500 characters. Empty when the page reported none.",
      ),
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
        'Absolute paths to saved output files: the output path when set, otherwise the PIXOO_OUTPUT_DIR auto-save (PNG for a still; for an animation an 8× GIF, or past 40 frames the panel-size GIF the device downloads). Absent when neither applies.',
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
      reason: 'browser_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'No browser was found to render with, or the one found failed to start.',
      recovery: BROWSER_UNAVAILABLE_RECOVERY,
      thrownBy: 'service',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: `The render did not finish within ${RENDER_DEADLINE_MS / 1000} s, or the call was cancelled.`,
      recovery:
        'Capture fewer frames, use native sampling, or lighten the work the page does per frame: window.render and requestAnimationFrame run once for every frame captured.',
      thrownBy: 'service',
    },
    {
      reason: 'render_crashed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The browser or the page crashed during the render.',
      retryable: true,
      recovery:
        'Retry; the next render starts a fresh browser. If the same page crashes again, cut what it allocates, such as very large canvases or many WebGL contexts.',
      thrownBy: 'service',
    },
    {
      reason: 'page_error',
      code: JsonRpcErrorCode.InvalidParams,
      when: "The page's window.render threw or rejected; the message names the frame and the page's error.",
      recovery:
        'Fix window.render for the frame named in the message. It runs once per frame as render(t, frame), with t = frame / frames: from 0 up to (frames − 1) / frames.',
    },
    {
      reason: 'invalid_color',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A finish palette entry could not be resolved to a color.',
      recovery:
        'Use a hex color (#RRGGBB or #RGB, with or without the #) or a case-insensitive named color such as white, orange, or claude.',
    },
    {
      reason: 'invalid_output_path',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The output path is relative or contains traversal segments.',
      recovery:
        'Pass an absolute, already-normalized path (for example /tmp/page.png), or omit output to use PIXOO_OUTPUT_DIR.',
    },
    {
      reason: 'device_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Device is not reachable over the network.',
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
      reason: 'gif_serve_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An animation of more than 40 frames could not be served to the device: its listener failed to open, its URL ran past 255 bytes, or the device did not request the GIF within 10 s of the play, stalled its transfer for 10 s, or dropped it.',
      recovery:
        'Make sure the device can reach this host at the address and port in the message (behind NAT or a firewall, set PIXOO_SERVE_HOST and PIXOO_SERVE_PORT), that PIXOO_SERVE_PORT is free, and that PIXOO_SERVE_HOST is short; or use 40 frames or fewer, which the device needs no download for.',
      thrownBy: 'service',
    },
    {
      reason: 'no_device_configured',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'PIXOO_IP is not set and push was requested.',
      recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Both checked before the page loads: a bad path or a palette typo must not cost a
    // browser launch and a full render. The path is checked as given — path.resolve()
    // would absolutize a relative path against the cwd and collapse traversal segments.
    if (
      input.output &&
      (!path.isAbsolute(input.output) || path.normalize(input.output) !== input.output)
    ) {
      throw ctx.fail(
        'invalid_output_path',
        `Invalid output path: "${input.output}". Must be an absolute path with no traversal segments.`,
      );
    }
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

    // Read before the browser launches, so a missing runtime bundle fails without one.
    const inject = pageScripts(getServerConfig().pixooSize, await pageRuntime());

    ctx.log.info('Rendering HTML', {
      chars: input.html.length,
      frames: input.frames,
      sampling: input.sampling,
      push: input.push,
    });

    const { captured, reported } = await getBrowserRenderer().withPage(
      pageDocument(input.html),
      { inject, sampling: input.sampling },
      async (page) => {
        const frames: Canvas[] = [];
        for (let frame = 0; frame < input.frames; frame++) {
          const failure = await page.evaluate(
            frameStepExpression(frame, input.frames, input.speed),
          );
          if (failure !== undefined) {
            throw ctx.fail('page_error', String(failure).slice(0, MAX_PAGE_ERROR_CHARS));
          }
          frames.push(await page.capture());
        }
        return { captured: frames, reported: [...page.pageErrors] };
      },
      ctx.signal,
    );
    const pageErrors = reported
      .slice(0, MAX_PAGE_ERRORS)
      .map((text) => text.slice(0, MAX_PAGE_ERROR_CHARS));

    const frames = input.finish ? finishFrames(captured, input.finish) : captured;
    const [first] = frames as [Canvas, ...Canvas[]];
    const isAnimation = frames.length > 1;

    // The captured result (a grid of the frames for an animation) rides content[] as an
    // image block. It is deliberately absent from `output` — routing it through
    // ctx.content carries the base64 once instead of duplicating it into structuredContent.
    ctx.content.image((await buildContactSheet(frames)).data, 'image/png');

    const baseName = `html-${Date.now()}`;
    // Past MAX_FRAME_PUSH the device downloads the panel-size GIF, so that GIF is the
    // file kept: encoded at most once, on first use, for the save and the push alike.
    const viaGif = frames.length > MAX_FRAME_PUSH;
    let gif: Uint8Array | undefined;
    const panelGif = () => {
      gif ??= encodePanelGif(frames, input.speed);
      return gif;
    };
    const writePreview: PreviewWriter = (dir) => {
      if (!isAnimation) return savePngPreview(first, dir, baseName);
      if (viaGif) return savePanelGif(panelGif(), dir, baseName);
      return saveGifPreview(frames, input.speed, dir, baseName);
    };

    // An explicit output path (validated at handler entry) replaces the auto-save.
    let outputFiles: string[];
    if (input.output) {
      await savePng(first, input.output);
      outputFiles = [input.output];
    } else {
      outputFiles = await autoSavePreview(writePreview);
    }

    const notices: string[] = [];
    if (reported.length > MAX_PAGE_ERRORS) {
      notices.push(
        `The page reported more than ${MAX_PAGE_ERRORS} errors; pageErrors holds the first ${MAX_PAGE_ERRORS}.`,
      );
    }
    let pushed = false;
    let deviceState: DeviceStateSnapshot | undefined;
    if (input.push) {
      const svc = getPixooService();
      deviceState = await pushKeepingPreview(
        () =>
          isAnimation
            ? svc.pushAnimation(frames, input.speed, ctx, viaGif ? panelGif() : undefined)
            : svc.pushFrame(first, ctx),
        outputFiles,
        writePreview,
      );
      pushed = true;
      const visibility = visibilityNotice(deviceState);
      if (visibility) notices.push(visibility);
    }
    // ctx.enrich.notice is last-wins, so every notice for this call lands as one string.
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      pushed,
      frames: frames.length,
      pageErrors,
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

    if (result.pageErrors.length === 0) {
      lines.push('**Page errors:** none');
    } else {
      lines.push(`**Page errors (${result.pageErrors.length}):**`);
      for (const text of result.pageErrors) lines.push(`- ${text}`);
    }

    if (result.outputFiles?.length) {
      lines.push(`**Saved:** ${result.outputFiles.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
