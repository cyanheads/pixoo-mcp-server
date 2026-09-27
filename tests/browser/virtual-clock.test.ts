/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`) for the page-side virtual
 * clock: a page animated through `window.render`, `requestAnimationFrame`, `setInterval`,
 * and a CSS animation captures byte-identical frames on two renders; `render` sees
 * `t = i / frames` and `performance.now() = i × speed`; a throwing `render` names its
 * frame; a throwing timer lands in `pageErrors`; and an unpainted page captures black.
 * @module tests/browser/virtual-clock.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  frameStepExpression,
  pageDocument,
  VIRTUAL_CLOCK_SOURCE,
} from '@/renderer/virtual-clock.js';
import { BrowserRenderer, type RenderOptions } from '@/services/browser/browser-renderer.js';
import { hashOf } from '../helpers/canvas-ink.js';
import { BrowserWrapper } from './helpers/browser-under-test.js';

const CLOCK: RenderOptions = { sampling: 'native', inject: [VIRTUAL_CLOCK_SOURCE] };
const FRAMES = 8;
const SPEED = 100;
const signal = new AbortController().signal;

/** Four 16-px lanes, one per animation source; each moves a 4-px block along its lane. */
const ANIMATED = `
<style>
  body { margin: 0; background: #102030; }
  i { position: absolute; width: 4px; height: 4px; }
  #css { top: 0; background: #f00; animation: slide 800ms linear infinite; }
  #raf { top: 16px; background: #0f0; }
  #interval { top: 32px; background: #00f; }
  canvas { position: absolute; top: 48px; left: 0; }
  @keyframes slide { from { left: 0; } to { left: 60px; } }
</style>
<i id="css"></i><i id="raf"></i><i id="interval"></i><canvas width="64" height="16"></canvas>
<script>
  window.log = [];
  const raf = document.getElementById('raf');
  requestAnimationFrame(function move(ts) {
    raf.style.left = (ts / 20) % 60 + 'px';
    requestAnimationFrame(move);
  });
  let ticks = 0;
  const interval = document.getElementById('interval');
  setInterval(() => { ticks++; interval.style.left = (ticks * 3) % 60 + 'px'; }, 30);
  const ctx = document.querySelector('canvas').getContext('2d');
  window.render = (t, frame) => {
    log.push([t, frame, performance.now()]);
    ctx.clearRect(0, 0, 64, 16);
    ctx.fillStyle = '#ff0';
    ctx.fillRect(Math.round(t * 60), 0, 4, 16);
  };
</script>`;

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

/** Steps and captures every frame of `html`, returning each frame's hash and the step results. */
function renderFrames(html: string) {
  return renderer.withPage(
    pageDocument(html),
    CLOCK,
    async (page) => {
      const hashes: string[] = [];
      const steps: unknown[] = [];
      for (let frame = 0; frame < FRAMES; frame++) {
        steps.push(await page.evaluate(frameStepExpression(frame, FRAMES, SPEED)));
        hashes.push(hashOf(await page.capture()));
      }
      const log = await page.evaluate('JSON.stringify(window.log ?? [])');
      return {
        hashes,
        log: JSON.parse(String(log)) as unknown,
        pageErrors: [...page.pageErrors],
        steps,
      };
    },
    signal,
  );
}

describe('virtual clock on a real browser', () => {
  it('captures byte-identical animated frames on two renders', async () => {
    const first = await renderFrames(ANIMATED);
    const second = await renderFrames(ANIMATED);
    expect(second.hashes).toEqual(first.hashes);
    expect(new Set(first.hashes).size).toBe(FRAMES);
    expect(first.steps).toEqual(Array(FRAMES).fill(undefined));
    expect(first.pageErrors).toEqual([]);
    expect(first.log).toEqual(Array.from({ length: FRAMES }, (_, i) => [i / FRAMES, i, i * SPEED]));
  });

  it('names the frame when render throws, and reports a throwing timer in pageErrors', async () => {
    const result = await renderFrames(`<script>
      setTimeout(() => { throw new Error('timer broke'); }, 150);
      window.render = (t, frame) => { if (frame === 3) throw new Error('boom'); };
    </script>`);
    expect(result.steps.slice(0, 4)).toEqual([
      undefined,
      undefined,
      undefined,
      'window.render threw at frame 3: Error: boom',
    ]);
    expect(result.pageErrors.some((entry) => entry.includes('timer broke'))).toBe(true);
  });

  it('captures an unpainted page on black and a painted body in its own color', async () => {
    const corner = async (html: string) =>
      renderer.withPage(
        pageDocument(html),
        CLOCK,
        async (page) => {
          await page.evaluate(frameStepExpression(0, 1, SPEED));
          return [...(await page.capture()).getPixel(63, 63)];
        },
        signal,
      );
    expect(await corner('<p style="color:#fff">hi</p>')).toEqual([0, 0, 0]);
    expect(await corner('<body style="background:#123456"><p>hi</p></body>')).toEqual([
      0x12, 0x34, 0x56,
    ]);
  });
});
