/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`) for `pixoo_render_html`'s
 * capture path: `withPage(pageDocument(html), { inject: [VIRTUAL_CLOCK_SOURCE], sampling })`,
 * then `frameStepExpression` and `capture()` per frame. That is the tool's path without the
 * `pixoo` runtime, which `page-runtime.test.ts` covers. Covers a CSS animation on the virtual
 * clock, the black default around text,
 * hidden scrollbars, the zero body margin a page can still override, supersample
 * area-averaging, and a blocked network image reported in `pageErrors`.
 * @module tests/browser/render-html.test
 */

import type { Canvas, RGB } from '@cyanheads/pixoo-toolkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  frameStepExpression,
  pageDocument,
  VIRTUAL_CLOCK_SOURCE,
} from '@/renderer/virtual-clock.js';
import { BrowserRenderer, type RenderOptions } from '@/services/browser/browser-renderer.js';
import { hashOf, inkColors, inkPixels } from '../helpers/canvas-ink.js';
import { BrowserWrapper } from './helpers/browser-under-test.js';

const BLACK: RGB = [0, 0, 0];
const SPEED = 100;
const signal = new AbortController().signal;

let wrapper: BrowserWrapper;
let renderer: BrowserRenderer;

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
  renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 64 });
});

afterAll(async () => {
  await renderer?.close();
  expect(await wrapper?.cleanup()).toEqual([]);
});

interface RenderRun {
  frames: Canvas[];
  pageErrors: string[];
  /** The page's value for `probe`, evaluated after the last capture. */
  probed: unknown;
  steps: unknown[];
}

/** Renders `html` the way `pixoo_render_html` does: step, then capture, `frames` times. */
function render(
  html: string,
  {
    frames = 1,
    sampling = 'native',
    probe,
  }: {
    frames?: number;
    probe?: string;
    sampling?: RenderOptions['sampling'];
  } = {},
): Promise<RenderRun> {
  return renderer.withPage(
    pageDocument(html),
    { inject: [VIRTUAL_CLOCK_SOURCE], sampling },
    async (page) => {
      const captured: Canvas[] = [];
      const steps: unknown[] = [];
      for (let frame = 0; frame < frames; frame++) {
        steps.push(await page.evaluate(frameStepExpression(frame, frames, SPEED)));
        captured.push(await page.capture());
      }
      const probed = probe === undefined ? undefined : await page.evaluate(probe);
      return { frames: captured, pageErrors: [...page.pageErrors], probed, steps };
    },
    signal,
  );
}

/** The single frame of a one-frame run. */
async function renderOne(html: string, opts?: Parameters<typeof render>[1]): Promise<Canvas> {
  const [frame] = (await render(html, opts)).frames;
  if (!frame) throw new Error('render returned no frame');
  return frame;
}

/** Column `x` of `canvas`, top to bottom, as `[r, g, b]` tuples. */
function column(canvas: Canvas, x: number): RGB[] {
  return Array.from({ length: canvas.height }, (_, y) => {
    const [r, g, b] = canvas.getPixelRgba(x, y);
    return [r, g, b] as RGB;
  });
}

/** Leftmost column holding a pixel of `color`, or -1. */
function leftmost(canvas: Canvas, color: RGB): number {
  for (let x = 0; x < canvas.width; x++) {
    for (let y = 0; y < canvas.height; y++) {
      const [r, g, b] = canvas.getPixelRgba(x, y);
      if (r === color[0] && g === color[1] && b === color[2]) return x;
    }
  }
  return -1;
}

/** Four 16-px lanes, one per animation source; each moves a block along its lane. */
const ALL_SOURCES = `
<style>
  i { position: absolute; width: 4px; height: 4px; }
  #css { top: 0; background: #f00; animation: slide 800ms linear infinite; }
  #raf { top: 16px; background: #0f0; }
  #interval { top: 32px; background: #00f; }
  canvas { position: absolute; top: 48px; left: 0; }
  @keyframes slide { from { left: 0; } to { left: 64px; } }
</style>
<i id="css"></i><i id="raf"></i><i id="interval"></i><canvas width="64" height="16"></canvas>
<script>
  const raf = document.getElementById('raf');
  requestAnimationFrame(function move(ts) {
    raf.style.left = (ts / 20) % 60 + 'px';
    requestAnimationFrame(move);
  });
  let ticks = 0;
  const interval = document.getElementById('interval');
  setInterval(() => { ticks++; interval.style.left = (ticks * 3) % 60 + 'px'; }, 30);
  const ctx = document.querySelector('canvas').getContext('2d');
  window.render = (t) => {
    ctx.clearRect(0, 0, 64, 16);
    ctx.fillStyle = '#ff0';
    ctx.fillRect(Math.round(t * 60), 0, 4, 16);
  };
</script>`;

/** Only a CSS animation: a red 4-px block sliding 64 px per 800 ms, 8 px per 100-ms frame. */
const CSS_ONLY = `
<style>
  i { position: absolute; top: 0; width: 4px; height: 4px; background: #f00;
      animation: slide 800ms linear infinite; }
  @keyframes slide { from { left: 0; } to { left: 64px; } }
</style>
<i></i>`;

describe('pixoo_render_html capture on a real browser', () => {
  it('renders a page animated by render, rAF, setInterval, and CSS byte-identically on two calls', async () => {
    const first = await render(ALL_SOURCES, { frames: 8 });
    const second = await render(ALL_SOURCES, { frames: 8 });
    expect(second.frames.map(hashOf)).toEqual(first.frames.map(hashOf));
    expect(new Set(first.frames.map(hashOf)).size).toBe(8);
    expect(first.steps).toEqual(Array(8).fill(undefined));
    expect(first.pageErrors).toEqual([]);
    // The CSS lane moves on the virtual clock: 8 px per 100-ms frame.
    expect(first.frames.map((frame) => leftmost(frame, [255, 0, 0]))).toEqual([
      0, 8, 16, 24, 32, 40, 48, 56,
    ]);
  });

  it('steps a CSS-only animation on the virtual clock, byte-identically on two calls', async () => {
    const first = await render(CSS_ONLY, { frames: 8 });
    const second = await render(CSS_ONLY, { frames: 8 });
    expect(second.frames.map(hashOf)).toEqual(first.frames.map(hashOf));
    expect(first.frames.map((frame) => leftmost(frame, [255, 0, 0]))).toEqual([
      0, 8, 16, 24, 32, 40, 48, 56,
    ]);
    for (const [i, frame] of first.frames.entries()) {
      const block = Array.from({ length: 16 }, (_, k) => `${8 * i + (k % 4)},${Math.floor(k / 4)}`);
      expect(inkPixels(frame, BLACK)).toEqual(block);
    }
  });

  it('renders white text on #000000 everywhere but the text', async () => {
    const run = await render('<p style="color:#fff">hi</p>', {
      probe: `(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('p'));
        const r = range.getBoundingClientRect();
        return JSON.stringify([r.left, r.top, r.right, r.bottom]);
      })()`,
    });
    const [frame] = run.frames as [Canvas];
    const [left, top, right, bottom]: [number, number, number, number] = JSON.parse(
      String(run.probed),
    );
    const ink = inkPixels(frame, BLACK).map((p) => p.split(',').map(Number) as [number, number]);
    expect(ink.length).toBeGreaterThan(0);
    expect(inkColors(frame, undefined, BLACK)).toContainEqual([255, 255, 255]);
    for (const [x, y] of ink) {
      expect(x).toBeGreaterThanOrEqual(Math.floor(left));
      expect(x).toBeLessThan(Math.ceil(right));
      expect(y).toBeGreaterThanOrEqual(Math.floor(top));
      expect(y).toBeLessThan(Math.ceil(bottom));
    }
  });

  it('shows no scrollbar on a page taller than the panel', async () => {
    const short = await renderOne('<p style="color:#fff">hi</p>');
    const tall = await renderOne('<p style="color:#fff">hi</p><div style="height:500px"></div>');
    expect(column(tall, 63)).toEqual(column(short, 63));
    expect(column(tall, 63)).toEqual(Array(64).fill(BLACK));
    expect(hashOf(tall)).toBe(hashOf(short));
  });

  it('serves the body with no margin, so a full-width block covers pixel (0,0)', async () => {
    const frame = await renderOne('<div style="height:4px;background:#f00"></div>');
    expect(inkPixels(frame, BLACK)).toEqual(
      Array.from({ length: 4 * 64 }, (_, k) => `${k % 64},${Math.floor(k / 64)}`),
    );
    expect(inkColors(frame, undefined, BLACK)).toEqual([[255, 0, 0]]);
  });

  it("keeps a page's own body margin", async () => {
    const frame = await renderOne(
      '<style>body{margin:8px}</style><div style="height:4px;background:#f00"></div>',
    );
    expect(inkPixels(frame, BLACK)).toEqual(
      Array.from({ length: 4 * 48 }, (_, k) => `${8 + (k % 48)},${8 + Math.floor(k / 48)}`),
    );
    expect(inkColors(frame, undefined, BLACK)).toEqual([[255, 0, 0]]);
  });

  it('area-averages a half-pixel-offset white box into two #bcbcbc pixels under supersample', async () => {
    // Half coverage averaged in linear light: 0.5 linear is 0xbc in sRGB.
    const frame = await renderOne(
      '<div style="position:absolute;left:0;top:0;width:1px;height:1px;background:#fff;transform:translateX(0.5px)"></div>',
      { sampling: 'supersample' },
    );
    expect(inkPixels(frame, BLACK)).toEqual(['0,0', '1,0']);
    expect(inkColors(frame, undefined, BLACK)).toEqual([[0xbc, 0xbc, 0xbc]]);
  });

  it('snaps a box placed by left: 0.5px to a whole CSS pixel before supersampling', async () => {
    // Chromium snaps a box's background to whole CSS pixels before the 8× device scale,
    // so [0.5, 1.5] paints as [1, 2] and the half-pixel offset never reaches the average.
    const offset = await renderOne(
      '<div style="position:absolute;left:0.5px;top:0;width:1px;height:1px;background:#fff"></div>',
      { sampling: 'supersample' },
    );
    expect(inkPixels(offset, BLACK)).toEqual(['1,0']);
    expect(inkColors(offset, undefined, BLACK)).toEqual([[255, 255, 255]]);
  });

  it('lists a blocked network image in pageErrors', async () => {
    const url = 'https://example.com/a.png';
    const run = await render(`<img src="${url}">`);
    expect(run.steps).toEqual([undefined]);
    expect(run.pageErrors).toEqual([expect.stringContaining(url)]);
  });
});
