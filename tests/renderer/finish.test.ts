/**
 * @fileoverview Tests for palette finishing: one canvas, and a frame set sharing one
 * palette under `colors`.
 * @module tests/renderer/finish.test
 */

import { Canvas, quantize, type RGB } from '@cyanheads/pixoo-toolkit';
import { describe, expect, it } from 'vitest';
import { type Finish, finishFrame, finishFrames } from '@/renderer/finish.js';
import { hashOf, inkColors } from '../helpers/canvas-ink.js';

const DITHERS = ['none', 'bayer4', 'floyd-steinberg'] as const;
const PALETTE = ['#000000', '#ffffff', '#ff8800'];
const PALETTE_RGB = ['0,0,0', '255,255,255', '255,136,0'];

/** HSV hue (0–360) at full saturation and value, as RGB. */
function hue(degrees: number): RGB {
  const h = (((degrees % 360) + 360) % 360) / 60;
  const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
  const sector: RGB[] = [
    [255, x, 0],
    [x, 255, 0],
    [0, 255, x],
    [0, x, 255],
    [x, 0, 255],
    [255, 0, x],
  ];
  return sector[Math.floor(h) % 6]!;
}

/**
 * A 16×16 frame: a hue ramp across the columns, shifted by `shift` degrees, over the
 * top 12 rows; the bottom 4 rows are transparent.
 */
function rampFrame(shift: number): Canvas {
  const canvas = new Canvas(16);
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 12; y++) canvas.setPixel(x, y, hue(shift + (x * 360) / 16));
  }
  return canvas;
}

/** Distinct RGB of every pixel with a non-zero alpha across `frames`, as `r,g,b`. */
const opaqueColors = (...frames: Canvas[]) =>
  new Set(frames.flatMap((frame) => inkColors(frame).map((rgb) => rgb.join(','))));

/** Indices of every alpha-0 pixel. */
function transparentPixels(canvas: Canvas): number[] {
  const out: number[] = [];
  for (let p = 0; p < canvas.width * canvas.height; p++) {
    if (canvas.buffer[p * 4 + 3] === 0) out.push(p);
  }
  return out;
}

describe('finishFrame', () => {
  it('colors: 8 leaves at most 8 distinct opaque colors', () => {
    const source = rampFrame(0);
    expect(opaqueColors(source).size).toBeGreaterThan(8);
    const out = finishFrame(source, { colors: 8, dither: 'none' });
    expect(opaqueColors(out).size).toBeLessThanOrEqual(8);
    expect(opaqueColors(out).size).toBeGreaterThan(1);
  });

  it.each(DITHERS)(
    'palette under dither %s: every opaque pixel is a palette color, every transparent pixel stays transparent',
    (dither) => {
      const source = rampFrame(30);
      const out = finishFrame(source, { palette: PALETTE, dither });
      expect([...opaqueColors(out)].every((c) => PALETTE_RGB.includes(c))).toBe(true);
      expect(transparentPixels(out)).toEqual(transparentPixels(source));
      expect(transparentPixels(out)).toHaveLength(16 * 4);
    },
  );

  it('named colors resolve in a palette', () => {
    const out = finishFrame(rampFrame(0), { palette: ['black', 'white'], dither: 'none' });
    expect([...opaqueColors(out)].sort()).toEqual(['0,0,0', '255,255,255']);
  });

  it('an unresolvable palette entry throws the toolkit color error', () => {
    expect(() => finishFrame(rampFrame(0), { palette: ['#zzzzzz'], dither: 'none' })).toThrow(
      /Unknown color: "#zzzzzz"/,
    );
  });

  it('never mutates its input', () => {
    const source = rampFrame(0);
    const before = hashOf(source);
    finishFrame(source, { colors: 4, dither: 'floyd-steinberg' });
    finishFrame(source, { palette: PALETTE, dither: 'bayer4' });
    expect(hashOf(source)).toBe(before);
  });
});

describe('finishFrames', () => {
  // Shifts off the ramp's 22.5° step, so no two frames hold the same colors.
  const frames = () => [0, 7, 14, 21].map(rampFrame);

  it.each(DITHERS)(
    'colors: 4 under dither %s builds one palette: the frames together hold at most 4 colors',
    (dither) => {
      const out = finishFrames(frames(), { colors: 4, dither });
      expect(out).toHaveLength(4);
      expect(opaqueColors(...out).size).toBeLessThanOrEqual(4);
      // Transparent pixels stay unlit in every frame.
      for (const frame of out) expect(transparentPixels(frame)).toHaveLength(16 * 4);
    },
  );

  it('a palette per frame would not hold the loop to 4 colors', () => {
    // The shared palette is what the test above measures: frame by frame, `colors: 4`
    // gives each frame 4 colors of its own.
    const perFrame = frames().map((frame) => quantize(frame, { colors: 4 }));
    expect(opaqueColors(...perFrame).size).toBeGreaterThan(4);
  });

  it.each(DITHERS)('palette under dither %s applies to each frame on its own', (dither) => {
    const finish: Finish = { palette: PALETTE, dither };
    const out = finishFrames(frames(), finish);
    expect(out.map(hashOf)).toEqual(frames().map((frame) => hashOf(finishFrame(frame, finish))));
  });

  it('one frame with colors finishes exactly as finishFrame does', () => {
    const finish: Finish = { colors: 5, dither: 'floyd-steinberg' };
    const [only] = finishFrames([rampFrame(45)], finish);
    expect(hashOf(only!)).toBe(hashOf(finishFrame(rampFrame(45), finish)));
  });

  it('frames already within colors come back unchanged', () => {
    const flat = [new Canvas(16).clear([255, 0, 0]), new Canvas(16).clear([0, 0, 255])];
    const out = finishFrames(flat, { colors: 2, dither: 'floyd-steinberg' });
    expect(out.map(hashOf)).toEqual(flat.map(hashOf));
  });

  it('fully transparent frames come back unchanged', () => {
    const empty = [new Canvas(16), new Canvas(16)];
    const out = finishFrames(empty, { colors: 4, dither: 'none' });
    expect(out.map(hashOf)).toEqual(empty.map(hashOf));
  });

  it('never mutates its input frames', () => {
    const input = frames();
    const before = input.map(hashOf);
    const out = finishFrames(input, { colors: 3, dither: 'bayer4' });
    expect(input.map(hashOf)).toEqual(before);
    for (const [i, frame] of out.entries()) expect(frame).not.toBe(input[i]);
  });
});
