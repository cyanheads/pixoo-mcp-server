/**
 * @fileoverview Keyframe interpolation and effect compiler for animation presets.
 * @module renderer/keyframes
 */

import { lerpColor, resolveColor, rgbToHex } from '@cyanheads/pixoo-toolkit';

/** A single keyframe entry: [frameIndex, value]. */
export type KeyframeEntry = [number, number | string | boolean];

/** Raw keyframe map: property → keyframe entries. */
export type KeyframeMap = Record<string, KeyframeEntry[]>;

/** Effect preset names. */
export type EffectName =
  | 'float'
  | 'scroll-left'
  | 'scroll-right'
  | 'pulse'
  | 'blink'
  | 'twinkle'
  | 'drift'
  | 'fade-in'
  | 'fade-out';

export const EFFECT_NAMES: EffectName[] = [
  'float',
  'scroll-left',
  'scroll-right',
  'pulse',
  'blink',
  'twinkle',
  'drift',
  'fade-in',
  'fade-out',
];

/**
 * A fixed value in [0, 1) for one frame of one element: a 32-bit integer hash of the pair,
 * so a render repeats exactly while neighbouring frames and elements still land far apart.
 */
function flicker(frame: number, element: number): number {
  let h = Math.imul(frame, 0x9e3779b1) ^ Math.imul(element + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/**
 * Compile a named effect preset into a keyframe map.
 *
 * `amplitude` is pixels of movement for `float`, `scroll-left`/`scroll-right` (speed), and
 * `drift`, default 2. For `pulse` and `twinkle` it is the depth of the opacity dip below 100,
 * on a 0–1 scale: default 0.5 for `pulse` (a 50–100 ramp) and 0.6 for `twinkle` (40–100).
 * `blink`, `fade-in`, and `fade-out` ignore it.
 *
 * `twinkle` jitters each frame's phase by an amount fixed by the frame and `element`, the
 * element's index in the scene, so the flicker is irregular and differs between elements
 * while identical scenes render identically.
 */
export function compileEffect(
  name: EffectName,
  opts: {
    amplitude?: number;
    period?: number;
    phase?: number;
  },
  totalFrames: number,
  element = 0,
): KeyframeMap {
  const amp = opts.amplitude ?? 2;
  const period = opts.period ?? totalFrames;
  const phase = opts.phase ?? 0;

  switch (name) {
    case 'float': {
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        frames.push([i, Math.round(Math.sin(t) * amp)]);
      }
      return { dy: frames };
    }
    case 'scroll-left': {
      const frames: KeyframeEntry[] = [];
      const speed = amp * 2;
      for (let i = 0; i < totalFrames; i++) {
        frames.push([i, -(i * speed)]);
      }
      return { dx: frames };
    }
    case 'scroll-right': {
      const frames: KeyframeEntry[] = [];
      const speed = amp * 2;
      for (let i = 0; i < totalFrames; i++) {
        frames.push([i, i * speed]);
      }
      return { dx: frames };
    }
    case 'pulse': {
      const depth = (opts.amplitude ?? 0.5) * 100;
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        const brightness = 0.5 + 0.5 * Math.sin(t);
        frames.push([i, Math.round(100 - depth + depth * brightness)]);
      }
      return { opacity: frames };
    }
    case 'blink': {
      const frames: KeyframeEntry[] = [];
      const half = Math.floor(period / 2);
      for (let i = 0; i < totalFrames; i++) {
        frames.push([i, i % period < half]);
      }
      return { visible: frames };
    }
    case 'twinkle': {
      const depth = (opts.amplitude ?? 0.6) * 100;
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        const brightness = 0.5 + 0.5 * Math.sin(t + flicker(i, element) * 0.3);
        frames.push([i, Math.round(100 - depth + depth * brightness)]);
      }
      return { opacity: frames };
    }
    case 'drift': {
      const frames: KeyframeEntry[] = [];
      const speed = amp * 0.5;
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        frames.push([i, Math.round(Math.sin(t) * speed * 8)]);
      }
      return { dx: frames };
    }
    case 'fade-in': {
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        frames.push([i, Math.round((i / Math.max(totalFrames - 1, 1)) * 100)]);
      }
      return { opacity: frames };
    }
    case 'fade-out': {
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        frames.push([i, Math.round((1 - i / Math.max(totalFrames - 1, 1)) * 100)]);
      }
      return { opacity: frames };
    }
    default:
      return {};
  }
}

/** A keyframe's value. */
type KeyframeValue = KeyframeEntry[1];

/**
 * The keyframes around `frameIdx` and how far between them it falls: `t` runs from 0 on
 * `from`'s frame to 1 on `to`'s. Before the first keyframe or past the last, that keyframe's
 * value is held: `from` and `to` are both it and `t` is 0. `undefined` for an empty track.
 */
function keyframeSpan(
  frames: KeyframeEntry[],
  frameIdx: number,
): { from: KeyframeValue; to: KeyframeValue; t: number } | undefined {
  const first = frames[0];
  const last = frames.at(-1);
  if (!first || !last) return;
  if (frameIdx <= first[0]) return { from: first[1], to: first[1], t: 0 };
  if (frameIdx < last[0]) {
    let before = first;
    for (const keyframe of frames) {
      if (keyframe[0] >= frameIdx) {
        const t = (frameIdx - before[0]) / (keyframe[0] - before[0]);
        return { from: before[1], to: keyframe[1], t };
      }
      before = keyframe;
    }
  }
  return { from: last[1], to: last[1], t: 0 };
}

/**
 * A number, or a string that reads as one (`"40"`, `"000"`, `"-2.5"`); `undefined` otherwise.
 * `pixoo_compose_scene` validates `dx`, `dy`, and `opacity` keyframes with it, so the input
 * schema and the interpolation agree on what a numeric string is.
 */
export function numericValue(value: KeyframeValue): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Interpolate a keyframe property at a given frame index. Booleans snap at the midpoint.
 * Numbers lerp, and so do numeric strings, read as the same numbers — `"000"` is 0 here, never
 * a color: only the `color` track lerps through RGB, in {@link interpolateColorKeyframe}.
 * Any other value holds until the next keyframe.
 */
export function interpolateKeyframe(frames: KeyframeEntry[], frameIdx: number): KeyframeValue {
  const span = keyframeSpan(frames, frameIdx);
  if (!span) return 0;
  const { from, to, t } = span;

  if (typeof from === 'boolean') return t < 0.5 ? from : to;

  const n0 = numericValue(from);
  const n1 = numericValue(to);
  if (n0 !== undefined && n1 !== undefined) return n0 + (n1 - n0) * t;

  return from;
}

/**
 * Interpolate a `color` keyframe track at a frame index: each keyframe value, number or
 * string, is read as a color and the track lerps through RGB, returning `#rrggbb` between
 * keyframes so it resolves like any other color. Every keyframe value is resolved first, so
 * one that isn't a color fails on every frame — including a keyframe the scene never
 * reaches, which interpolation alone would skip past by holding the previous color.
 *
 * @throws {Error} The toolkit's `Unknown color` error for the first value that isn't a color,
 *   or an error for an empty track, which input validation rejects before any render.
 */
export function interpolateColorKeyframe(frames: KeyframeEntry[], frameIdx: number): string {
  for (const [, value] of frames) resolveColor(String(value));
  const span = keyframeSpan(frames, frameIdx);
  if (!span) throw new Error('A color keyframe track needs at least one keyframe.');
  const { from, to, t } = span;
  if (t === 0) return String(from);
  const lerped = lerpColor(resolveColor(String(from)), resolveColor(String(to)), t);
  return `#${rgbToHex(lerped).toString(16).padStart(6, '0')}`;
}

/** Get the interpolated value for a named property at a frame index. */
export function getKeyframeValue(
  keyframes: KeyframeMap | undefined,
  prop: string,
  frameIdx: number,
  defaultValue: number | string | boolean,
): number | string | boolean {
  if (!keyframes?.[prop]) return defaultValue;
  return interpolateKeyframe(keyframes[prop], frameIdx);
}
