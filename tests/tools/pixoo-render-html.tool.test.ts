/**
 * @fileoverview Tests for the pixoo_render_html tool handler, against a fake browser
 * renderer that runs the real virtual clock and the page's inline scripts in `node:vm`,
 * so `bun run test` launches no browser. Pixel capture on a real browser lives in the
 * gated suite under `tests/browser/`.
 * @module tests/tools/pixoo-render-html.tool.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { Canvas } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooRenderHtml } from '@/mcp-server/tools/definitions/pixoo-render-html.tool.js';
import { pageRuntime, pageRuntimeReader } from '@/renderer/page-scripts.js';
import { buildContactSheet, encodePreviewBlock } from '@/renderer/preview.js';
import {
  frameStepExpression,
  pageDocument,
  VIRTUAL_CLOCK_SOURCE,
} from '@/renderer/virtual-clock.js';
import { BROWSER_UNAVAILABLE_RECOVERY } from '@/services/browser/browser-renderer.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import { hashOf, inkColors } from '../helpers/canvas-ink.js';
import {
  expectDeviceFailure,
  imageKind,
  listFiles,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';
import {
  browserUnavailableError,
  type FakeRenderCall,
  installFakeBrowserRenderer,
  PAGE_RUNTIME_STUB,
} from '../helpers/fake-browser-renderer.js';
import { expectInvalidColor, PROTOTYPE_NAME_CASES } from '../helpers/prototype-color-names.js';
import { openObjectPaths } from '../helpers/zod-object-nodes.js';

vi.mock('@/services/browser/browser-renderer.js', async (importOriginal) => {
  const { getFakeBrowserRenderer } = await import('../helpers/fake-browser-renderer.js');
  return {
    ...(await importOriginal<typeof import('@/services/browser/browser-renderer.js')>()),
    getBrowserRenderer: getFakeBrowserRenderer,
  };
});

// The runtime bundle lives in dist/, which a unit run need not have built.
vi.mock('@/renderer/page-scripts.js', async (importOriginal) => {
  const { PAGE_RUNTIME_STUB } = await import('../helpers/fake-browser-renderer.js');
  return {
    ...(await importOriginal<typeof import('@/renderer/page-scripts.js')>()),
    pageRuntime: vi.fn(async () => PAGE_RUNTIME_STUB),
  };
});

type Input = z.input<typeof pixooRenderHtml.input>;
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
type Output = {
  pushed: boolean;
  frames: number;
  pageErrors: string[];
  notice?: string;
  outputFiles?: string[];
};

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const script = (body: string) => `<script>${body}</script>`;

/** A page that paints every frame solid `[r, g, b]`, as computed by `body` from `t` and `frame`. */
const fillPage = (body: string) =>
  script(`window.render = (t, frame) => { globalThis.fill = ${body}; };`);

/** The Visibility notice a push to a device with its screen off adds. */
const SCREEN_OFF_NOTICE =
  'Pushed, but the render may not be visible: the screen is off (pixoo_control_device with screen: "on").';

const TOO_MANY_ERRORS_NOTICE =
  'The page reported more than 20 errors; pageErrors holds the first 20.';

let calls: FakeRenderCall[];

beforeEach(() => {
  resetServerConfig();
  process.env['PIXOO_SIZE'] = '64';
  process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
  // TEST-NET-1 address: never routable. The device client is a fake regardless.
  process.env['PIXOO_IP'] = '192.0.2.1';
  initPixooService(fakeConfig, fakeStorage);
  calls = installFakeBrowserRenderer();
});

afterEach(() => {
  delete process.env['PIXOO_IP'];
  delete process.env['PIXOO_SIZE'];
  delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
  delete process.env['PIXOO_OUTPUT_DIR'];
  resetServerConfig();
  vi.restoreAllMocks();
});

const run = (input: Input) => runToolContract(pixooRenderHtml, input);

/** Render `input` with push on, against a fake device that accepts every push. */
async function pushHtml(input: Input) {
  const client = stubDeviceState();
  const result = await run({ push: true, ...input });
  return { result, client, sc: result.structuredContent as Output };
}

/** The base64 image block of a result: the preview. */
const previewOf = (result: ToolResult) =>
  (result.content.find((block) => block.type === 'image') as { data: string } | undefined)?.data;

/** Distinct RGB of every pixel across `frames`, as `r,g,b`. */
const colorsOf = (...frames: Canvas[]) =>
  new Set(frames.flatMap((frame) => inkColors(frame).map((rgb) => rgb.join(','))));

/** The single color `frame` is painted in, as `[r, g, b]`; fails when it holds several. */
function solidColor(frame: Canvas): number[] {
  const colors = [...colorsOf(frame)];
  expect(colors).toHaveLength(1);
  return colors[0]!.split(',').map(Number);
}

/** The frames the fake device received in its one pushAnimation call. */
function animationFrames(client: ReturnType<typeof stubDeviceState>): Canvas[] {
  expect(client.pushAnimation).toHaveBeenCalledOnce();
  return client.pushAnimation.mock.calls[0]![0] as Canvas[];
}

/** Assert `result` failed input validation (-32602) with every `named` string in its text. */
function expectInvalidArguments(result: ToolResult, ...named: string[]) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
  });
  for (const text of named) expect(resultText(result)).toContain(text);
}

describe('pixooRenderHtml — schema', () => {
  it('closes every nested input object', () => {
    expect(openObjectPaths(pixooRenderHtml.input)).toEqual([]);
  });

  it('html of exactly 500,000 characters renders', async () => {
    const result = await run({ html: 'a'.repeat(500_000), push: false });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it('html of 500,001 characters fails -32602 naming html; no page loads', async () => {
    const result = await run({ html: 'a'.repeat(500_001), push: false });
    expectInvalidArguments(result, 'html', '500000');
    expect(calls).toHaveLength(0);
  });

  it.each<[string, Partial<Input>, string]>([
    ['frames 0', { frames: 0 }, 'frames'],
    ['frames 801', { frames: 801 }, 'frames'],
    ['frames 1.5', { frames: 1.5 }, 'frames'],
    ['speed 9', { speed: 9 }, 'speed'],
    ['speed 2001', { speed: 2001 }, 'speed'],
    ['speed 12.5', { speed: 12.5 }, 'speed'],
    ['sampling "bilinear"', { sampling: 'bilinear' as 'native' }, 'sampling'],
  ])('%s fails -32602 naming the field; no page loads', async (_label, extra, field) => {
    const result = await run({ html: '<p>hi</p>', push: false, ...extra });
    expectInvalidArguments(result, field);
    expect(calls).toHaveLength(0);
  });

  it.each<[string, Partial<Input>]>([
    ['frames 1 and speed 10', { frames: 1, speed: 10 }],
    ['frames 40 and speed 2000', { frames: 40, speed: 2000 }],
  ])('%s are accepted', async (_label, extra) => {
    const result = await run({ html: '<p>hi</p>', push: false, ...extra });
    expect(result.isError).toBeFalsy();
  });
});

describe('pixooRenderHtml — one frame', () => {
  it('serves the page behind the doctype and scrollbar style, with the virtual clock, the panel size, and the pixoo runtime, and steps one frame', async () => {
    const html = '<p style="color:#fff">hi</p>';
    await run({ html, push: false });

    expect(calls).toHaveLength(1);
    const [call] = calls as [FakeRenderCall];
    expect(call.html).toBe(pageDocument(html));
    expect(call.html.startsWith('<!doctype html>')).toBe(true);
    expect(call.opts).toEqual({
      inject: [VIRTUAL_CLOCK_SOURCE, 'globalThis.__PIXOO_SIZE__ = 64;', PAGE_RUNTIME_STUB],
      sampling: 'native',
    });
    expect(call.evaluated).toEqual([frameStepExpression(0, 1, 150)]);
    expect(call.captures).toBe(1);
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it('sampling: supersample reaches the renderer', async () => {
    await run({ html: '<p>hi</p>', sampling: 'supersample', push: false });
    expect(calls[0]?.opts.sampling).toBe('supersample');
  });

  it.each([64, 32, 16])(
    'at PIXOO_SIZE=%i pushes one panel-size frame through pushFrame, and the preview is that frame',
    async (size) => {
      process.env['PIXOO_SIZE'] = String(size);
      resetServerConfig();

      const { result, client, sc } = await pushHtml({ html: fillPage('[10, 20, 30]') });

      expect(result.isError).toBeFalsy();
      expect(client.push).toHaveBeenCalledOnce();
      expect(client.pushAnimation).not.toHaveBeenCalled();
      const frame = client.push.mock.calls[0]![0] as Canvas;
      expect([frame.width, frame.height]).toEqual([size, size]);
      expect(solidColor(frame)).toEqual([10, 20, 30]);
      expect(previewOf(result)).toBe(encodePreviewBlock(frame).data);

      expect(sc).toMatchObject({ pushed: true, frames: 1, pageErrors: [] });
      expect(sc.outputFiles).toBeUndefined();
      expect(sc).not.toHaveProperty('notice');
      const text = resultText(result);
      expect(text).toContain('**Pushed:** Yes | **Frames:** 1');
      expect(text).toContain(
        '**Device:** Reachable | Channel: custom | Brightness: 80 | Screen: On',
      );
      expect(text).toContain('**Page errors:** none');
    },
  );

  it('push: false touches no device and returns no deviceState', async () => {
    const client = stubDeviceState();
    const result = await run({ html: '<p>hi</p>', push: false });

    expect(result.structuredContent).toEqual({ pushed: false, frames: 1, pageErrors: [] });
    expect(resultText(result)).toContain('**Pushed:** No | **Frames:** 1');
    expect(resultText(result)).not.toContain('**Device:**');
    expect(client.push).not.toHaveBeenCalled();
    expect(client.getChannel).not.toHaveBeenCalled();
  });

  it('with PIXOO_OUTPUT_DIR, a still auto-saves one 8× PNG', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-html-out-'));
    process.env['PIXOO_OUTPUT_DIR'] = outDir;
    resetServerConfig();
    try {
      const result = await run({ html: '<p>hi</p>', push: false });
      const { outputFiles } = result.structuredContent as Output;
      expect(outputFiles).toHaveLength(1);
      expect(await listFiles(outDir)).toEqual(outputFiles);
      expect(await imageKind(outputFiles![0]!)).toBe('png');
      const { width, height } = await sharp(outputFiles![0]!).metadata();
      expect([width, height]).toEqual([512, 512]);
      expect(resultText(result)).toContain(`**Saved:** ${outputFiles![0]}`);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('pixooRenderHtml — pixoo runtime', () => {
  it('the description points pages at the pixoo global for bitmap text, palettes, and icons', () => {
    for (const term of [
      'Every page gets a pixoo global before its own scripts run',
      'pixoo.text',
      'pixoo.icon',
      'pixoo.palettes',
      'crisp bitmap text',
    ]) {
      expect(pixooRenderHtml.description).toContain(term);
    }
  });

  it.each([64, 32, 16])(
    'at PIXOO_SIZE=%i the size is injected ahead of the runtime, so the page reads it as pixoo.size',
    async (size) => {
      process.env['PIXOO_SIZE'] = String(size);
      resetServerConfig();

      const { result, client } = await pushHtml({
        html: script('globalThis.fill = [pixoo.size, 0, 0];'),
      });

      expect(result.isError).toBeFalsy();
      expect(calls[0]?.opts.inject).toEqual([
        VIRTUAL_CLOCK_SOURCE,
        `globalThis.__PIXOO_SIZE__ = ${size};`,
        PAGE_RUNTIME_STUB,
      ]);
      expect(solidColor(client.push.mock.calls[0]![0] as Canvas)).toEqual([size, 0, 0]);
    },
  );

  it('a missing runtime bundle fails ConfigurationError naming the file, before any page loads; nothing is pushed', async () => {
    const missing = path.join(os.tmpdir(), 'no-such-dist', 'page-runtime.js');
    vi.mocked(pageRuntime).mockImplementationOnce(pageRuntimeReader(pathToFileURL(missing)));

    const { result, client } = await pushHtml({ html: '<p>hi</p>' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ConfigurationError,
        message: `The pixoo page runtime bundle ${missing} does not exist. \`bun run build\` writes it: build the server, or reinstall the package.`,
      },
    });
    expect(calls).toHaveLength(0);
    expect(client.push).not.toHaveBeenCalled();
    expect(client.getChannel).not.toHaveBeenCalled();
  });
});

describe('pixooRenderHtml — animation', () => {
  it('20 frames: one pushAnimation of all 20, a 5×4 contact-sheet preview, and an 8× GIF in PIXOO_OUTPUT_DIR', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-html-out-'));
    process.env['PIXOO_OUTPUT_DIR'] = outDir;
    resetServerConfig();
    try {
      const { result, client, sc } = await pushHtml({ html: '<p>hi</p>', frames: 20 });

      expect(result.isError).toBeFalsy();
      expect(client.push).not.toHaveBeenCalled();
      expect(client.playGifUrl).not.toHaveBeenCalled();
      const frames = animationFrames(client);
      expect(frames).toHaveLength(20);
      expect(client.pushAnimation.mock.calls[0]![1]).toBe(150);
      expect(new Set(frames.map(hashOf)).size).toBe(20);

      const [call] = calls as [FakeRenderCall];
      expect(call.evaluated).toEqual(
        Array.from({ length: 20 }, (_, i) => frameStepExpression(i, 20, 150)),
      );
      expect(call.captures).toBe(20);

      const preview = previewOf(result)!;
      expect(preview).toBe((await buildContactSheet(frames)).data);
      const sheet = await sharp(Buffer.from(preview, 'base64')).metadata();
      expect([sheet.width, sheet.height]).toEqual([5 * 66 - 2, 4 * 66 - 2]);

      expect(sc).toMatchObject({ pushed: true, frames: 20 });
      expect(sc.outputFiles).toHaveLength(1);
      expect(await listFiles(outDir)).toEqual(sc.outputFiles);
      const gif = await sharp(sc.outputFiles![0]!, { animated: true }).metadata();
      expect(await imageKind(sc.outputFiles![0]!)).toBe('gif');
      expect({ pages: gif.pages, width: gif.width, height: gif.pageHeight }).toEqual({
        pages: 20,
        width: 512,
        height: 512,
      });
      expect(resultText(result)).toContain('**Pushed:** Yes | **Frames:** 20');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('at frame i, window.render gets t = i / frames and performance.now() has advanced i × speed ms since frame 0', async () => {
    const html = script(`
      let start;
      window.render = (t, frame) => {
        const now = performance.now();
        start ??= now;
        console.error(JSON.stringify([t, frame, now - start]));
        globalThis.fill = [Math.round(t * 200), frame, (now - start) / 10];
      };
    `);
    const { client, sc } = await pushHtml({ html, frames: 8, speed: 70 });

    expect(sc.pageErrors).toEqual(
      Array.from({ length: 8 }, (_, i) => JSON.stringify([i / 8, i, i * 70])),
    );
    expect(animationFrames(client).map(solidColor)).toEqual(
      Array.from({ length: 8 }, (_, i) => [25 * i, i, 7 * i]),
    );
    expect(client.pushAnimation.mock.calls[0]![1]).toBe(70);
  });

  it('a page animated through requestAnimationFrame, setInterval, and render gives byte-identical frames on two calls', async () => {
    const html = script(`
      let ticks = 0;
      let rafs = 0;
      setInterval(() => { ticks++; }, 50);
      const loop = () => { rafs++; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      window.render = (t, frame) => { globalThis.fill = [ticks, rafs, frame * 10]; };
    `);
    const render = async () =>
      animationFrames((await pushHtml({ html, frames: 6, speed: 100 })).client);

    const first = await render();
    // An interval of 50 ms fires twice per 100 ms frame; one rAF round runs per frame.
    expect(first.map(solidColor)).toEqual(
      Array.from({ length: 6 }, (_, i) => [2 * i, i + 1, 10 * i]),
    );
    const second = await render();
    expect(second.map(hashOf)).toEqual(first.map(hashOf));
  });
});

describe('pixooRenderHtml — output', () => {
  it('output saves frame 0 as an 8× PNG, replacing the PIXOO_OUTPUT_DIR auto-save', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-html-output-'));
    process.env['PIXOO_OUTPUT_DIR'] = path.join(dir, 'auto');
    resetServerConfig();
    try {
      const output = path.join(dir, 'frame0.png');
      const { result, client, sc } = await pushHtml({
        html: fillPage('[10 + frame * 30, 20, 30]'),
        frames: 4,
        output,
      });

      expect(result.isError).toBeFalsy();
      expect(sc.outputFiles).toEqual([output]);
      expect(await listFiles(path.join(dir, 'auto'))).toEqual([]);
      const { width, height } = await sharp(output).metadata();
      expect([width, height]).toEqual([512, 512]);
      // Every 8×8 block of the saved PNG is one LED, so a nearest-neighbour 64×64 read is exact.
      const data = await sharp(output)
        .resize(64, 64, { kernel: 'nearest' })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const [frame0] = animationFrames(client);
      expect(solidColor(frame0!)).toEqual([10, 20, 30]);
      expect(Buffer.from(data)).toEqual(Buffer.from(frame0!.buffer));
      expect(resultText(result)).toContain(`**Saved:** ${output}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['frame.png', './frame.png', '~/frame.png', '/tmp/../tmp/frame.png', '/tmp//frame.png'])(
    'output %j fails invalid_output_path before the page loads',
    async (output) => {
      const { result, client } = await pushHtml({ html: '<p>hi</p>', output });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expectForwardedRecovery(result, pixooRenderHtml.errors, 'invalid_output_path');
      expect(resultText(result)).toContain(`"${output}"`);
      expect(calls).toHaveLength(0);
      expect(client.push).not.toHaveBeenCalled();
    },
  );
});

describe('pixooRenderHtml — page_error', () => {
  it.each<[string, string, string]>([
    [
      'throws',
      "if (frame === 3) throw new Error('boom');",
      'window.render threw at frame 3: Error: boom',
    ],
    [
      'rejects',
      "if (frame === 3) return Promise.reject(new Error('late boom'));",
      'window.render threw at frame 3: Error: late boom',
    ],
  ])(
    'render that %s at frame 3 fails page_error (-32602) naming frame 3 and the message; nothing is pushed or saved',
    async (_label, body, message) => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-html-out-'));
      process.env['PIXOO_OUTPUT_DIR'] = outDir;
      resetServerConfig();
      try {
        const html = script(`window.render = (t, frame) => { ${body} };`);
        const { result, client } = await pushHtml({ html, frames: 8 });

        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, message },
        });
        expectForwardedRecovery(result, pixooRenderHtml.errors, 'page_error');
        expect(resultText(result)).toContain(message);
        expect(calls[0]?.captures).toBe(3);
        expect(calls[0]?.evaluated).toHaveLength(4);
        expect(client.push).not.toHaveBeenCalled();
        expect(client.pushAnimation).not.toHaveBeenCalled();
        expect(client.getChannel).not.toHaveBeenCalled();
        expect(await listFiles(outDir)).toEqual([]);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    },
  );

  it('a render message of 1,000 characters is cut so the page_error is 500 characters', async () => {
    const html = script(
      "window.render = (t, frame) => { if (frame === 3) throw new Error('x'.repeat(1000)); };",
    );
    const { result } = await pushHtml({ html, frames: 8 });

    const { message } = (result.structuredContent as { error: { message: string } }).error;
    expect(message).toHaveLength(500);
    expect(message.startsWith('window.render threw at frame 3: Error: xxx')).toBe(true);
  });

  it('page_error is declared as InvalidParams', () => {
    const declared = pixooRenderHtml.errors?.find((entry) => entry.reason === 'page_error');
    expect(declared?.code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});

describe('pixooRenderHtml — pageErrors', () => {
  const consoleErrors = (count: number, text = (i: number) => `error ${i}`) =>
    script(
      Array.from({ length: count }, (_, i) => `console.error(${JSON.stringify(text(i))});`).join(
        '',
      ),
    );

  it('30 console.error calls return the first 20 in order, and a notice says more arrived', async () => {
    const result = await run({ html: consoleErrors(30), push: false });
    const sc = result.structuredContent as Output;

    const first20 = Array.from({ length: 20 }, (_, i) => `error ${i}`);
    expect(sc.pageErrors).toEqual(first20);
    expect(sc.notice).toBe(TOO_MANY_ERRORS_NOTICE);
    const text = resultText(result);
    expect(text).toContain('**Page errors (20):**');
    for (const entry of first20) expect(text).toContain(`- ${entry}\n`);
    expect(text).not.toContain('error 20');
    expect(text).toContain(TOO_MANY_ERRORS_NOTICE);
  });

  it('exactly 20 console.error calls return all 20 and no notice', async () => {
    const result = await run({ html: consoleErrors(20), push: false });
    const sc = result.structuredContent as Output;
    expect(sc.pageErrors).toHaveLength(20);
    expect(sc).not.toHaveProperty('notice');
  });

  it('an entry of 600 characters is cut to 500', async () => {
    const result = await run({ html: consoleErrors(1, () => 'y'.repeat(600)), push: false });
    expect((result.structuredContent as Output).pageErrors).toEqual(['y'.repeat(500)]);
    expect(resultText(result)).toContain(`- ${'y'.repeat(500)}`);
    expect(resultText(result)).not.toContain('y'.repeat(501));
  });

  it('an uncaught timer error lands in pageErrors without failing the call', async () => {
    const html = script(`setTimeout(() => { throw new Error('tick failed'); }, 10);`);
    const result = await run({ html, frames: 2, push: false });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).pageErrors).toEqual([
      'Uncaught Error: tick failed',
    ]);
  });

  it('<img src="https://example.com/a.png"> lists that URL', async () => {
    const result = await run({ html: '<img src="https://example.com/a.png">', push: false });
    expect((result.structuredContent as Output).pageErrors).toEqual([
      'Blocked request: https://example.com/a.png',
    ]);
    expect(resultText(result)).toContain('- Blocked request: https://example.com/a.png');
  });

  it('more than 20 errors and a screen-off push fold into one notice', async () => {
    stubDeviceState({ screenOn: false });
    const result = await run({ html: consoleErrors(21), push: true });
    const sc = result.structuredContent as Output;
    expect(sc.notice).toBe(`${TOO_MANY_ERRORS_NOTICE} ${SCREEN_OFF_NOTICE}`);
    expect(resultText(result)).toContain(sc.notice);
  });
});

describe('pixooRenderHtml — finish', () => {
  const PALETTE = ['#000000', '#ffffff', '#ff8800'];
  const PALETTE_RGB = ['0,0,0', '255,255,255', '255,136,0'];

  it('finish: { colors: 4 } over 8 frames pushes frames holding at most 4 colors in all, and the preview is their sheet', async () => {
    const unfinished = animationFrames((await pushHtml({ html: '<p>hi</p>', frames: 8 })).client);
    expect(colorsOf(...unfinished).size).toBeGreaterThan(4);

    const { result, client } = await pushHtml({
      html: '<p>hi</p>',
      frames: 8,
      finish: { colors: 4 },
    });

    expect(result.isError).toBeFalsy();
    const frames = animationFrames(client);
    expect(frames).toHaveLength(8);
    expect(colorsOf(...frames).size).toBeLessThanOrEqual(4);
    expect(colorsOf(...frames).size).toBeGreaterThan(1);
    expect(previewOf(result)).toBe((await buildContactSheet(frames)).data);
  });

  it.each(['none', 'bayer4', 'floyd-steinberg'] as const)(
    'finish: { palette } under dither %s draws every pixel of every frame in a palette color',
    async (dither) => {
      const { result, client } = await pushHtml({
        html: '<p>hi</p>',
        frames: 3,
        finish: { palette: PALETTE, dither },
      });
      expect(result.isError).toBeFalsy();
      const frames = animationFrames(client);
      expect([...colorsOf(...frames)].every((rgb) => PALETTE_RGB.includes(rgb))).toBe(true);
    },
  );

  it.each<[string, Record<string, unknown>, string]>([
    ['both colors and palette', { colors: 8, palette: PALETTE }, 'finish: Unrecognized key'],
    ['neither colors nor palette', {}, 'finish: colors: '],
    ['only a dither', { dither: 'bayer4' }, 'finish: colors: '],
    ['colors 1', { colors: 1 }, 'finish.colors: Too small'],
    ['colors 257', { colors: 257 }, 'finish.colors: Too big'],
    ['an empty palette', { palette: [] }, 'finish.palette: Too small'],
    ['a 257-entry palette', { palette: Array(257).fill('#000000') }, 'finish.palette: Too big'],
  ])('%s fails -32602 naming finish; no page loads', async (_label, finish, named) => {
    const { result, client } = await pushHtml({
      html: '<p>hi</p>',
      finish: finish as Input['finish'],
    });
    expectInvalidArguments(result, named);
    expect(calls).toHaveLength(0);
    expect(client.push).not.toHaveBeenCalled();
  });

  it.each(['#zzzzzz', 'not-a-color', ...PROTOTYPE_NAME_CASES])(
    'a palette entry %j fails invalid_color before the page loads',
    async (entry) => {
      const { result, client } = await pushHtml({
        html: '<p>hi</p>',
        finish: { palette: ['#000000', entry] },
      });
      expectInvalidColor(result, pixooRenderHtml.errors, entry);
      expect(resultText(result)).toContain('finish.palette');
      expect(calls).toHaveLength(0);
      expect(client.push).not.toHaveBeenCalled();
    },
  );
});

describe('pixooRenderHtml — renderer failures', () => {
  it('with no browser, the call fails browser_unavailable (-32008) with the install hint; nothing is pushed', async () => {
    installFakeBrowserRenderer({ fail: browserUnavailableError() });
    const { result, client } = await pushHtml({ html: '<p>hi</p>' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ConfigurationError,
        data: { reason: 'browser_unavailable', recovery: { hint: BROWSER_UNAVAILABLE_RECOVERY } },
      },
    });
    expectForwardedRecovery(result, pixooRenderHtml.errors, 'browser_unavailable');
    expect(resultText(result)).toContain(`Recovery: ${BROWSER_UNAVAILABLE_RECOVERY}`);
    expect(client.push).not.toHaveBeenCalled();
    expect(client.getChannel).not.toHaveBeenCalled();
  });

  it('render_timeout passes through as Timeout with its declared recovery', async () => {
    installFakeBrowserRenderer({
      fail: timeout('The render did not finish within 30 s.', { reason: 'render_timeout' }),
    });
    const { result, client } = await pushHtml({ html: '<p>hi</p>' });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.Timeout, message: 'The render did not finish within 30 s.' },
    });
    expectForwardedRecovery(result, pixooRenderHtml.errors, 'render_timeout');
    expect(client.push).not.toHaveBeenCalled();
  });

  it('render_crashed passes through as ServiceUnavailable, retryable, with its declared recovery', async () => {
    installFakeBrowserRenderer({
      fail: serviceUnavailable('The browser crashed.', {
        reason: 'render_crashed',
        retryable: true,
      }),
    });
    const { result, client } = await pushHtml({ html: '<p>hi</p>' });

    expectDeviceFailure(result, pixooRenderHtml.errors, 'render_crashed', true);
    expectForwardedRecovery(result, pixooRenderHtml.errors, 'render_crashed');
    expect(client.push).not.toHaveBeenCalled();
  });
});

describe('pixooRenderHtml — format()', () => {
  it('renders every output field as text', () => {
    const [block] = pixooRenderHtml.format!({
      pushed: true,
      frames: 8,
      pageErrors: ['Blocked request: https://example.com/a.png', 'Uncaught Error: x'],
      deviceState: { reachable: true, channel: 'custom', brightness: 40, screenOn: false },
      outputFiles: ['/tmp/a.png'],
    });
    expect(block).toEqual({
      type: 'text',
      text: [
        '**Pushed:** Yes | **Frames:** 8',
        '**Device:** Reachable | Channel: custom | Brightness: 40 | Screen: Off',
        '**Page errors (2):**',
        '- Blocked request: https://example.com/a.png',
        '- Uncaught Error: x',
        '**Saved:** /tmp/a.png',
      ].join('\n'),
    });
  });
});
