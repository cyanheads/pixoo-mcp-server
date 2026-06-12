/**
 * @fileoverview Tests for keyframe interpolation and effect compilation.
 * @module tests/renderer/keyframes.test
 */

import { describe, expect, it } from 'vitest';
import {
  compileEffect,
  EFFECT_NAMES,
  type EffectName,
  getKeyframeValue,
  interpolateKeyframe,
  type KeyframeEntry,
} from '@/renderer/keyframes.js';

describe('interpolateKeyframe', () => {
  it('returns default 0 for empty frames array', () => {
    expect(interpolateKeyframe([], 5)).toBe(0);
  });

  it('clamps to first keyframe before its index', () => {
    const frames: KeyframeEntry[] = [[5, 100]];
    expect(interpolateKeyframe(frames, 0)).toBe(100);
    expect(interpolateKeyframe(frames, 4)).toBe(100);
  });

  it('clamps to last keyframe after its index', () => {
    const frames: KeyframeEntry[] = [
      [0, 0],
      [10, 100],
    ];
    expect(interpolateKeyframe(frames, 20)).toBe(100);
  });

  it('returns exact value at a keyframe index', () => {
    const frames: KeyframeEntry[] = [
      [0, 0],
      [10, 100],
    ];
    expect(interpolateKeyframe(frames, 0)).toBe(0);
    expect(interpolateKeyframe(frames, 10)).toBe(100);
  });

  it('linearly lerps numbers between keyframes', () => {
    const frames: KeyframeEntry[] = [
      [0, 0],
      [10, 100],
    ];
    const mid = interpolateKeyframe(frames, 5) as number;
    expect(mid).toBeCloseTo(50, 5);
  });

  it('lerps a fractional number correctly', () => {
    const frames: KeyframeEntry[] = [
      [0, 10],
      [4, 14],
    ];
    const val = interpolateKeyframe(frames, 1) as number;
    expect(val).toBeCloseTo(11, 5);
  });

  it('boolean snaps at midpoint — returns first value before t=0.5', () => {
    const frames: KeyframeEntry[] = [
      [0, false],
      [10, true],
    ];
    expect(interpolateKeyframe(frames, 4)).toBe(false);
  });

  it('boolean snaps at midpoint — returns second value at/after t=0.5', () => {
    const frames: KeyframeEntry[] = [
      [0, false],
      [10, true],
    ];
    expect(interpolateKeyframe(frames, 5)).toBe(true);
    expect(interpolateKeyframe(frames, 7)).toBe(true);
  });

  it('interpolates color strings through RGB', () => {
    const frames: KeyframeEntry[] = [
      [0, '#000000'],
      [10, '#ffffff'],
    ];
    const mid = interpolateKeyframe(frames, 5) as string;
    expect(mid).toMatch(/^rgb\(/);
    // Midpoint should be around grey
    const nums = mid.match(/\d+/g)!.map(Number);
    expect(nums[0]).toBeGreaterThan(100);
    expect(nums[0]).toBeLessThan(160);
  });

  it('falls back to first value for unresolvable color strings', () => {
    const frames: KeyframeEntry[] = [
      [0, 'not-a-color'],
      [10, 'also-not'],
    ];
    // Should not throw — falls back
    expect(() => interpolateKeyframe(frames, 5)).not.toThrow();
  });
});

describe('getKeyframeValue', () => {
  it('returns defaultValue when keyframes is undefined', () => {
    expect(getKeyframeValue(undefined, 'x', 0, 42)).toBe(42);
  });

  it('returns defaultValue when prop is missing from map', () => {
    expect(getKeyframeValue({}, 'opacity', 5, 100)).toBe(100);
  });

  it('returns interpolated value when prop exists', () => {
    const kf = {
      dy: [
        [0, 0],
        [10, 20],
      ] as KeyframeEntry[],
    };
    const val = getKeyframeValue(kf, 'dy', 5, 0) as number;
    expect(val).toBeCloseTo(10, 5);
  });
});

describe('compileEffect', () => {
  it('covers all effect names (no unhandled case)', () => {
    for (const name of EFFECT_NAMES) {
      const result = compileEffect(name as EffectName, {}, 10);
      expect(typeof result).toBe('object');
    }
  });

  it('float produces dy keyframes with sine-based values', () => {
    const result = compileEffect('float', { amplitude: 3 }, 8);
    expect(result).toHaveProperty('dy');
    expect(result['dy']!.length).toBe(8);
    // All values should be within amplitude range
    for (const [, v] of result['dy']!) {
      expect(Math.abs(v as number)).toBeLessThanOrEqual(3);
    }
  });

  it('scroll-left produces monotonically decreasing dx', () => {
    const result = compileEffect('scroll-left', { amplitude: 2 }, 5);
    const dx = result['dx']!;
    for (let i = 1; i < dx.length; i++) {
      expect(dx[i]![1] as number).toBeLessThanOrEqual(dx[i - 1]![1] as number);
    }
  });

  it('scroll-right produces monotonically increasing dx', () => {
    const result = compileEffect('scroll-right', { amplitude: 2 }, 5);
    const dx = result['dx']!;
    for (let i = 1; i < dx.length; i++) {
      expect(dx[i]![1] as number).toBeGreaterThanOrEqual(dx[i - 1]![1] as number);
    }
  });

  it('fade-in starts near 0 and ends at 100', () => {
    const result = compileEffect('fade-in', {}, 10);
    const op = result['opacity']!;
    expect(op[0]![1]).toBe(0);
    expect(op[op.length - 1]![1]).toBe(100);
  });

  it('fade-out starts at 100 and ends near 0', () => {
    const result = compileEffect('fade-out', {}, 10);
    const op = result['opacity']!;
    expect(op[0]![1]).toBe(100);
    expect(op[op.length - 1]![1]).toBe(0);
  });

  it('blink produces boolean visible values', () => {
    const result = compileEffect('blink', {}, 10);
    const vis = result['visible']!;
    expect(vis.length).toBe(10);
    for (const [, v] of vis) {
      expect(typeof v).toBe('boolean');
    }
  });

  it('pulse values stay within 50–100 range', () => {
    const result = compileEffect('pulse', {}, 20);
    const op = result['opacity']!;
    for (const [, v] of op) {
      expect(v as number).toBeGreaterThanOrEqual(50);
      expect(v as number).toBeLessThanOrEqual(100);
    }
  });

  it('totalFrames controls output array length', () => {
    const result = compileEffect('float', {}, 20);
    expect(result['dy']!.length).toBe(20);
  });

  it('phase offsets produce different values at some frame', () => {
    // phase=0 → sin(0)=0, phase=0.25 → sin(π/2)=1 at frame 0 (amp=4 → rounds to 4)
    const a = compileEffect('float', { amplitude: 4, phase: 0 }, 10);
    const b = compileEffect('float', { amplitude: 4, phase: 0.25 }, 10);
    // The two waveforms should not be identical across all frames
    const aVals = a['dy']!.map(([, v]) => v);
    const bVals = b['dy']!.map(([, v]) => v);
    const anyDiffers = aVals.some((v, i) => v !== bVals[i]);
    expect(anyDiffers).toBe(true);
  });
});
