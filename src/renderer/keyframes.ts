/**
 * @fileoverview Keyframe interpolation and effect compiler for animation presets.
 * @module renderer/keyframes
 */

import { lerpColor, resolveColor } from '@cyanheads/pixoo-toolkit';

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

/** Compile a named effect preset into a keyframe map. */
export function compileEffect(
  name: EffectName,
  opts: {
    amplitude?: number;
    period?: number;
    phase?: number;
  },
  totalFrames: number,
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
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        const brightness = 0.5 + 0.5 * Math.sin(t);
        // Encode brightness as opacity 50–100
        frames.push([i, Math.round(50 + 50 * brightness)]);
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
      const frames: KeyframeEntry[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / period + phase) * 2 * Math.PI;
        frames.push([i, Math.round(40 + 60 * (0.5 + 0.5 * Math.sin(t + Math.random() * 0.3)))]);
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

/** Interpolate a keyframe property at a given frame index. */
export function interpolateKeyframe(
  frames: KeyframeEntry[],
  frameIdx: number,
): number | string | boolean {
  if (frames.length === 0) return 0;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return 0;
  if (frameIdx <= first[0]) return first[1];
  if (frameIdx >= last[0]) return last[1];

  // Find surrounding keyframes
  let lo = 0;
  let hi = frames.length - 1;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (a && b && a[0] <= frameIdx && b[0] >= frameIdx) {
      lo = i;
      hi = i + 1;
      break;
    }
  }

  const loEntry = frames[lo];
  const hiEntry = frames[hi];
  if (!loEntry || !hiEntry) return 0;
  const [f0, v0] = loEntry;
  const [f1, v1] = hiEntry;
  if (f0 === f1) return v0;

  const t = (frameIdx - f0) / (f1 - f0);

  // Boolean: snap at midpoint
  if (typeof v0 === 'boolean') return t < 0.5 ? v0 : v1;

  // Number: lerp
  if (typeof v0 === 'number' && typeof v1 === 'number') {
    return v0 + (v1 - v0) * t;
  }

  // Color string: lerp through RGB
  if (typeof v0 === 'string' && typeof v1 === 'string') {
    try {
      const c0 = resolveColor(v0);
      const c1 = resolveColor(v1);
      const lerped = lerpColor(c0, c1, t);
      return `rgb(${lerped[0]},${lerped[1]},${lerped[2]})`;
    } catch {
      return v0;
    }
  }

  return v0;
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
