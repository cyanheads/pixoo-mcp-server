/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`) for the `pixoo` page
 * runtime `pixoo_render_html` injects. Text and icons a page draws with `pixoo.text` and
 * `pixoo.icon` capture byte-identical to the same `pixoo_compose_scene` element on
 * `#000000`, in both sampling modes, through the tool itself. A `<head>` script reads
 * `pixoo.size` and the palettes. An unknown palette, icon, color, or numerals glyph throws
 * in the page naming the value, and inside `window.render` fails the call as `page_error`.
 * The bundle is built fresh into a temp dir, so the suite never runs a stale `dist/`.
 * @module tests/browser/page-runtime.test
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { RGB } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { pixooRenderHtml } from '@/mcp-server/tools/definitions/pixoo-render-html.tool.js';
import { pageScripts } from '@/renderer/page-scripts.js';
import { renderFrame, type SceneElement } from '@/renderer/scene-renderer.js';
import { PALETTES } from '@/renderer/themes.js';
import { frameStepExpression, pageDocument } from '@/renderer/virtual-clock.js';
import {
  type BrowserRenderer,
  getBrowserRenderer,
  initBrowserRenderer,
} from '@/services/browser/browser-renderer.js';
import { inkPixels } from '../helpers/canvas-ink.js';
import { BrowserWrapper } from './helpers/browser-under-test.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BLACK: RGB = [0, 0, 0];

/** The freshly built bundle, which the tool's `pageRuntime` returns in place of `dist/`'s. */
const runtime = vi.hoisted(() => ({ bundle: '' }));

vi.mock('@/renderer/page-scripts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/page-scripts.js')>()),
  pageRuntime: async () => runtime.bundle,
}));

const signal = new AbortController().signal;

let wrapper: BrowserWrapper;
let renderer: BrowserRenderer;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'pixoo-page-runtime-'));
  const build = spawnSync('bun', ['run', 'scripts/build-page-runtime.ts', workDir], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  expect(build.status, build.stderr).toBe(0);
  runtime.bundle = await readFile(path.join(workDir, 'page-runtime.js'), 'utf8');

  // The tool renders on the shared renderer, launched from PIXOO_BROWSER_PATH at PIXOO_SIZE.
  wrapper = await BrowserWrapper.create();
  process.env['PIXOO_BROWSER_PATH'] = wrapper.executablePath;
  delete process.env['PIXOO_SIZE'];
  resetServerConfig();
  initBrowserRenderer();
  renderer = getBrowserRenderer();
});

afterAll(async () => {
  await renderer?.close();
  delete process.env['PIXOO_BROWSER_PATH'];
  resetServerConfig();
  if (workDir) await rm(workDir, { recursive: true, force: true });
  expect(await wrapper?.cleanup()).toEqual([]);
});

type Sampling = 'native' | 'supersample';

let saved = 0;

/**
 * Run `pixoo_render_html` on `html` with push off; returns the result and the panel-size
 * RGBA of the frame it saved, which `output` writes 8× upscaled, one uniform block per LED.
 */
async function renderViaTool(html: string, sampling: Sampling = 'native') {
  const output = path.join(workDir, `frame-${saved++}.png`);
  const result = await runToolContract(pixooRenderHtml, { html, sampling, push: false, output });
  const size = getServerConfig().pixooSize;
  const rgba = result.isError
    ? undefined
    : await sharp(output)
        .resize(size, size, { kernel: sharp.kernel.nearest })
        .ensureAlpha()
        .raw()
        .toBuffer();
  return { result, rgba };
}

/** A scene element alone on `#000000`, as pixoo_compose_scene renders it. */
function sceneOnBlack(element: SceneElement): Buffer {
  const { canvas } = renderFrame(0, 1, '#000000', [element], {
    images: new Map(),
    sprites: new Map(),
  });
  return Buffer.from(canvas.buffer);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Each page draw beside the scene element it must match, and that element's pinned hash
 * from the `pixoo_compose_scene` suite, so both sides are held to the frame the scene tool
 * has always pushed.
 */
const PARITY_CASES: [string, string, SceneElement, string][] = [
  [
    'text, palette, scale 2, shadow',
    "pixoo.text(pixoo.context(), 'HELLO', 'center', 4, { palette: 'ember', scale: 2, shadow: true });",
    {
      type: 'text',
      text: 'HELLO',
      x: 'center',
      y: 4,
      style: { palette: 'ember', scale: 2, shadow: true },
    },
    'f39c0ed4d78985ee082520d774849dd5458ded8c03bdb729b9729b4b90398f87',
  ],
  [
    'text, color, outline, compact',
    "pixoo.text(pixoo.context(), 'Pixoo 64', 2, 'bottom', { font: 'compact', color: '#44ccff', outline: true });",
    {
      type: 'text',
      text: 'Pixoo 64',
      font: 'compact',
      x: 2,
      y: 'bottom',
      color: '#44ccff',
      style: { outline: true },
    },
    'c5966bf34119c7928c6d6a926fea5d56fccbd0cd10d2d485cd3a4b2bdc20fca6',
  ],
  [
    'text, numerals, color',
    "pixoo.text(pixoo.context(), '12:45', 'center', 'center', { font: 'numerals', color: '#ff8800' });",
    {
      type: 'text',
      text: '12:45',
      font: 'numerals',
      x: 'center',
      y: 'center',
      color: '#ff8800',
    },
    'b3732f0f41c595cd46356cb7c1bb93d11e3339f577f20b95666ff1283c7ad817',
  ],
  [
    'icon, color',
    "pixoo.icon(pixoo.context(), 'check-circle', 50, 2, { color: 'green' });",
    { type: 'icon', name: 'check-circle', x: 50, y: 2, color: 'green' },
    'db83ea70cfdb0793d4299aeb3a080ca6de905c5a8affa1b472f2a9e0d12279ab',
  ],
  [
    'icon, palette',
    "pixoo.icon(pixoo.context(), 'check-circle', 50, 2, { palette: 'ember' });",
    { type: 'icon', name: 'check-circle', x: 50, y: 2, palette: 'ember' },
    'cf495c17502545f86080426f1140d97f8436f9731f7d67099136f44413c32f1e',
  ],
  [
    'icon, palette, 16px',
    "pixoo.icon(pixoo.context(), 'heart', 4, 40, { w: 16, h: 16, palette: 'ice' });",
    { type: 'icon', name: 'heart', x: 4, y: 40, w: 16, h: 16, palette: 'ice' },
    '21c948d30f5e5177e6a456edf7dd6709e5b646a4f184fecb73f5bb87f699d59e',
  ],
];

describe('pixoo page runtime on a real browser', () => {
  describe.each<Sampling>(['native', 'supersample'])('%s sampling', (sampling) => {
    it.each(PARITY_CASES)(
      '%s captures byte-identical to the scene element on #000000',
      async (_name, draw, element, pinned) => {
        const { result, rgba } = await renderViaTool(`<script>${draw}</script>`, sampling);

        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { pageErrors: string[] }).pageErrors).toEqual([]);
        const scene = sceneOnBlack(element);
        expect(sha256(scene)).toBe(pinned);
        expect(rgba?.equals(scene)).toBe(true);
      },
    );
  });

  it('a <head> script reads pixoo.size, which is PIXOO_SIZE, and all 7 palettes, and draws before <body> exists', async () => {
    const html = `<html><head><script>
      window.seen = {
        bodyAtRun: document.body,
        size: pixoo.size,
        palettes: pixoo.palettes,
        box: pixoo.text(pixoo.context(), 'HELLO', 'center', 4, { palette: 'ember', scale: 2, shadow: true }),
      };
    </script></head><body></body></html>`;
    const { size, palettes, bodyAtRun, box } = (await renderer.withPage(
      pageDocument(html),
      { inject: pageScripts(getServerConfig().pixooSize, runtime.bundle), sampling: 'native' },
      (page) => page.evaluate('window.seen'),
      signal,
    )) as { size: number; palettes: unknown; bodyAtRun: unknown; box: unknown };

    expect(getServerConfig().pixooSize).toBe(64);
    expect(size).toBe(64);
    expect(Object.keys(palettes as object)).toHaveLength(7);
    expect(palettes).toEqual(PALETTES);
    expect(bodyAtRun).toBeNull();
    expect(box).toEqual({ x: 3, y: 4, w: 58, h: 14 });

    const { rgba } = await renderViaTool(html);
    expect(rgba?.equals(sceneOnBlack(PARITY_CASES[0]![2]))).toBe(true);
  });

  /** Each bad value, the page call that passes it, and the phrase that names it. */
  const THROW_CASES: [string, string, string][] = [
    [
      'palette "constructor"',
      "pixoo.text(pixoo.context(), 'HI', 0, 0, { palette: 'constructor' });",
      'Unknown palette "constructor". Palettes: ',
    ],
    [
      'icon "toString"',
      "pixoo.icon(pixoo.context(), 'toString', 0, 0);",
      'Unknown icon "toString". Use pixoo://reference/icons to browse available icons.',
    ],
    [
      'color "nope"',
      "pixoo.text(pixoo.context(), 'HI', 0, 0, { color: 'nope' });",
      'Unknown color: "nope"',
    ],
    [
      'numerals text "12A"',
      "pixoo.text(pixoo.context(), '12A', 0, 0, { font: 'numerals' });",
      'Characters not in the numerals font: "A".',
    ],
  ];

  it.each(THROW_CASES)(
    '%s throws in the page naming it; a page script reports it in pageErrors and paints nothing',
    async (_label, call, named) => {
      const { result, rgba } = await renderViaTool(`<script>${call}</script>`);

      expect(result.isError).toBeFalsy();
      const { pageErrors } = result.structuredContent as { pageErrors: string[] };
      expect(pageErrors).toHaveLength(1);
      expect(pageErrors[0]).toContain(named);
      expect(rgba).toBeDefined();
      const { canvas } = renderFrame(0, 1, '#000000', [], {
        images: new Map(),
        sprites: new Map(),
      });
      expect(rgba?.equals(Buffer.from(canvas.buffer))).toBe(true);
      expect(inkPixels(canvas, BLACK)).toEqual([]);
    },
  );

  it.each(THROW_CASES)(
    '%s thrown inside window.render fails pixoo_render_html as page_error naming it',
    async (_label, call, named) => {
      const { result } = await renderViaTool(`<script>window.render = () => { ${call} };</script>`);

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'page_error' },
        },
      });
      const { message } = (result.structuredContent as { error: { message: string } }).error;
      expect(message.startsWith('window.render threw at frame 0: Error: ')).toBe(true);
      expect(message).toContain(named);
    },
  );

  it('the step expression reports the same throw the tool fails on', async () => {
    const failure = await renderer.withPage(
      pageDocument(
        "<script>window.render = () => pixoo.icon(pixoo.context(), 'toString', 0, 0);</script>",
      ),
      { inject: pageScripts(64, runtime.bundle), sampling: 'native' },
      (page) => page.evaluate(frameStepExpression(0, 1, 150)),
      signal,
    );
    expect(failure).toContain('Unknown icon "toString"');
  });
});
