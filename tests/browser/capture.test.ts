/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`): at device scale factor
 * 8, 16-, 32-, and 64-px viewports capture 128, 256, and 512 px, and a page painted in
 * whole CSS pixels downsamples to exactly the panel frame. A pass-through spy on the
 * toolkit's `downsample` records the raw capture size.
 * @module tests/browser/capture.test
 */

import type { Canvas } from '@cyanheads/pixoo-toolkit';
import { downsample } from '@cyanheads/pixoo-toolkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRenderer } from '@/services/browser/browser-renderer.js';
import { BrowserWrapper } from './helpers/browser-under-test.js';

vi.mock('@cyanheads/pixoo-toolkit', async (importOriginal) => {
  const toolkit = await importOriginal<typeof import('@cyanheads/pixoo-toolkit')>();
  return { ...toolkit, downsample: vi.fn(toolkit.downsample) };
});

const signal = new AbortController().signal;
let wrapper: BrowserWrapper;

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
});

beforeEach(() => {
  vi.mocked(downsample).mockClear();
});

afterAll(async () => {
  expect(await wrapper?.cleanup()).toEqual([]);
});

/** A distinct, spread-out color for every panel pixel. */
function colorAt(x: number, y: number): [number, number, number] {
  return [
    (x * 37 + y * 11 + 5) & 0xff,
    (x * 5 + y * 53 + 90) & 0xff,
    (x * 97 + y * 29 + 170) & 0xff,
  ];
}

/** One `size`×`size` grid of 1-CSS-px cells, each cell `colorAt` its position. */
function gridPage(size: number): string {
  const cells: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hex = colorAt(x, y)
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('');
      cells.push(`<i style="background:#${hex}"></i>`);
    }
  }
  return `<!doctype html><style>
html, body { margin: 0; background: #000; }
main { display: grid; grid-template-columns: repeat(${size}, 1px); grid-auto-rows: 1px; }
i { display: block; }
</style><main>${cells.join('')}</main>`;
}

function pixels(frame: Canvas): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) out.push([...frame.getPixel(x, y)]);
  }
  return out;
}

describe('BrowserRenderer capture on a real browser', () => {
  it.each([
    [16, 128],
    [32, 256],
    [64, 512],
  ])(
    'at %i px and scale factor 8, captures %i px and downsamples whole-pixel blocks exactly',
    async (size, captured) => {
      const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size });
      try {
        const html = gridPage(size);
        const supersampled = await renderer.withPage(
          html,
          { sampling: 'supersample', inject: [] },
          (page) => page.capture(),
          signal,
        );
        expect(vi.mocked(downsample)).toHaveBeenCalledTimes(1);
        const [source, width, height] = vi.mocked(downsample).mock.calls[0] ?? [];
        expect([source?.width, source?.height]).toEqual([captured, captured]);
        expect([width, height]).toEqual([size, size]);

        const native = await renderer.withPage(
          html,
          { sampling: 'native', inject: [] },
          (page) => page.capture(),
          signal,
        );
        expect(vi.mocked(downsample)).toHaveBeenCalledTimes(1);

        const expected: number[][] = [];
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) expected.push(colorAt(x, y));
        }
        expect([supersampled.width, supersampled.height]).toEqual([size, size]);
        expect(pixels(native)).toEqual(expected);
        expect(pixels(supersampled)).toEqual(expected);
      } finally {
        await renderer.close();
      }
    },
  );
});
