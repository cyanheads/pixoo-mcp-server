/**
 * @fileoverview Palette finishing — reduce a rendered canvas, or every frame of an
 * animation, to a palette with optional dithering through the toolkit's `quantize`.
 * Tool-agnostic: any render path applies a caller's `finish` here, after the load and
 * before the preview, so the preview is exactly the frame the device receives.
 * @module renderer/finish
 */

import { Canvas, type QuantizeOptions, quantize, type RGB } from '@cyanheads/pixoo-toolkit';

/**
 * A palette finish: exactly one of `colors` (build a palette of at most that many colors
 * from the image) or `palette` (map to these colors), plus `dither`. Transparent pixels
 * stay unlit and don't count toward `colors`.
 */
export type Finish = QuantizeOptions;

/**
 * Apply `finish` to one canvas.
 *
 * @returns A new canvas; the input is never mutated.
 * @throws {Error} The toolkit's `Unknown color` error for an unresolvable palette entry.
 */
export function finishFrame(canvas: Canvas, finish: Finish): Canvas {
  return quantize(canvas, finish);
}

/**
 * Apply `finish` to every frame of an animation. `colors` builds one palette from all
 * the frames' visible pixels together, so the whole loop holds at most that many colors;
 * `palette` and `dither` apply to each frame on its own, so dither error never crosses
 * from one frame into the next.
 *
 * @param frames - Frames of one size, up to 4096 stacked rows in all (64 frames of a
 *   64-pixel panel).
 * @returns New canvases, one per frame; the inputs are never mutated.
 * @throws {Error} The toolkit's `Unknown color` error for an unresolvable palette entry.
 */
export function finishFrames(frames: readonly Canvas[], finish: Finish): Canvas[] {
  if (finish.colors === undefined || frames.length <= 1) {
    return frames.map((frame) => quantize(frame, finish));
  }
  const palette = sharedPalette(frames, finish.colors);
  // Nothing visible to reduce — quantize returns such a frame unchanged too.
  if (palette.length === 0) return frames.map((frame) => frame.clone());
  return frames.map((frame) => quantize(frame, { palette, dither: finish.dither ?? 'none' }));
}

/**
 * The palette of at most `colors` colors `quantize` builds from every frame's visible
 * pixels at once: the frames stacked into one canvas and reduced without dithering,
 * then the reduced canvas's distinct visible colors read back in raster order.
 */
function sharedPalette(frames: readonly Canvas[], colors: number): RGB[] {
  const [first] = frames as readonly [Canvas, ...Canvas[]];
  const stack = new Canvas(first.width, first.height * frames.length);
  frames.forEach((frame, k) => {
    stack.buffer.set(frame.buffer, k * frame.buffer.length);
  });

  const buf = quantize(stack, { colors }).buffer;
  const palette = new Map<number, RGB>();
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] === 0) continue;
    const rgb: RGB = [buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0];
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (!palette.has(key)) palette.set(key, rgb);
  }
  return [...palette.values()];
}
