/**
 * @fileoverview Tests for keyframe interpolation and effect compilation.
 * @module tests/renderer/keyframes.test
 */

import { lerpColor, resolveColor } from '@cyanheads/pixoo-toolkit';
import { describe, expect, it, vi } from 'vitest';
import {
  compileEffect,
  EFFECT_NAMES,
  type EffectName,
  getKeyframeValue,
  interpolateColorKeyframe,
  interpolateKeyframe,
  type KeyframeEntry,
  type KeyframeMap,
} from '@/renderer/keyframes.js';

/** The opacity values an effect's keyframes step through, in frame order. */
function opacities(keyframes: KeyframeMap): Array<KeyframeEntry[1]> {
  return (keyframes['opacity'] ?? []).map(([, value]) => value);
}

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

  it.each<[string, KeyframeEntry[], number[]]>([
    [
      'numeric strings',
      [
        [0, '10'],
        [2, '90'],
      ],
      [10, 50, 90],
    ],
    [
      'numeric strings that also read as hex colors',
      [
        [0, '000'],
        [4, '100'],
      ],
      [0, 25, 50, 75, 100],
    ],
    [
      'six-digit numeric strings',
      [
        [0, '123456'],
        [2, '123460'],
      ],
      [123456, 123458, 123460],
    ],
    [
      'a number, then a numeric string',
      [
        [0, 40],
        [2, '80'],
      ],
      [40, 60, 80],
    ],
    [
      'a numeric string, then a number',
      [
        [0, '40'],
        [2, 80],
      ],
      [40, 60, 80],
    ],
    [
      'negative and fractional strings',
      [
        [0, '-4'],
        [2, '2.5'],
      ],
      [-4, -0.75, 2.5],
    ],
    [
      'three keyframes, past the first segment',
      [
        [0, '0'],
        [2, '100'],
        [4, '-100'],
      ],
      [0, 50, 100, 0, -100],
    ],
  ])('lerps %s exactly as it lerps the same numbers', (_label, frames, expected) => {
    const asNumbers = frames.map(([frame, value]): KeyframeEntry => [frame, Number(value)]);
    for (const [frame, value] of expected.entries()) {
      expect(interpolateKeyframe(frames, frame)).toBeCloseTo(value, 10);
      expect(interpolateKeyframe(frames, frame)).toBe(interpolateKeyframe(asNumbers, frame));
    }
  });

  it('holds the first value between two strings that are not numbers, without throwing', () => {
    const frames: KeyframeEntry[] = [
      [0, 'not-a-color'],
      [10, 'also-not'],
    ];
    expect(interpolateKeyframe(frames, 5)).toBe('not-a-color');
  });
});

describe('interpolateColorKeyframe', () => {
  const redToBlue: KeyframeEntry[] = [
    [0, 'red'],
    [2, 'Blue'],
  ];

  it('interpolates a valid track through RGB, holding the ends', () => {
    expect([0, 1, 2, 5].map((frame) => interpolateColorKeyframe(redToBlue, frame))).toEqual([
      'red',
      '#800080',
      'Blue',
      'Blue',
    ]);
  });

  it('interpolates color strings through RGB, as #rrggbb', () => {
    const frames: KeyframeEntry[] = [
      [0, '#000000'],
      [10, '#ffffff'],
    ];
    expect(interpolateColorKeyframe(frames, 5)).toBe('#808080');
  });

  it('reads a track of numbers as colors and lerps them through RGB, never as numbers', () => {
    const frames: KeyframeEntry[] = [
      [0, 100],
      [3, 200],
    ];
    for (const frame of [1, 2]) {
      expect(resolveColor(interpolateColorKeyframe(frames, frame))).toEqual(
        lerpColor(resolveColor('100'), resolveColor('200'), frame / 3),
      );
    }
  });

  it('throws for an empty track rather than reading it as a color', () => {
    expect(() => interpolateColorKeyframe([], 0)).toThrow('at least one keyframe');
  });

  it('returns a keyframe color unchanged on its own frame', () => {
    expect(interpolateColorKeyframe(redToBlue, 0)).toBe('red');
    expect(interpolateColorKeyframe(redToBlue, 2)).toBe('Blue');
  });

  it('interpolates within the segment a frame falls in, past the first', () => {
    const frames: KeyframeEntry[] = [
      [0, 'red'],
      [2, '#0f0'],
      [4, 'blue'],
      [8, '#000000'],
    ];
    expect(interpolateColorKeyframe(frames, 1)).toBe('#808000');
    expect(interpolateColorKeyframe(frames, 3)).toBe('#008080');
    expect(interpolateColorKeyframe(frames, 6)).toBe('#000080');
  });

  it('every in-between color resolves back to the RGB it was lerped to', () => {
    const pairs: Array<[string, string]> = [
      ['red', 'blue'],
      ['#123', 'ABCDEF'],
      ['claude', '#ffffff'],
      ['black', 'white'],
      ['000', '100'],
      ['123456', '654321'],
    ];
    for (const [a, b] of pairs) {
      const frames: KeyframeEntry[] = [
        [0, a],
        [7, b],
      ];
      for (let frame = 1; frame < 7; frame++) {
        const value = interpolateColorKeyframe(frames, frame);
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
        expect(resolveColor(value)).toEqual(lerpColor(resolveColor(a), resolveColor(b), frame / 7));
      }
    }
  });

  it.each<[string, KeyframeEntry[], string]>([
    [
      'a name that is not a color, past the frame asked for',
      [
        [0, 'red'],
        [9, 'notacolor'],
      ],
      'notacolor',
    ],
    [
      'the first of three keyframes',
      [
        [0, 'nope'],
        [4, 'red'],
        [8, 'blue'],
      ],
      'nope',
    ],
    [
      'a number',
      [
        [0, 'red'],
        [4, 7],
      ],
      '7',
    ],
    [
      'a boolean',
      [
        [0, 'red'],
        [4, true],
      ],
      'true',
    ],
  ])('throws for %s, on every frame', (_label, frames, bad) => {
    for (const frame of [0, 1, 4, 20]) {
      expect(() => interpolateColorKeyframe(frames, frame)).toThrow(`Unknown color: "${bad}"`);
    }
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

  it('pulse without an amplitude keeps its 50–100 ramp, frame for frame', () => {
    expect(opacities(compileEffect('pulse', {}, 20))).toEqual([
      75, 83, 90, 95, 99, 100, 99, 95, 90, 83, 75, 67, 60, 55, 51, 50, 51, 55, 60, 67,
    ]);
    expect(opacities(compileEffect('pulse', { period: 3, phase: 0.2 }, 7))).toEqual([
      99, 70, 56, 99, 70, 56, 99,
    ]);
  });

  it('twinkle without an amplitude keeps its 40–100 flicker, frame for frame', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(opacities(compileEffect('twinkle', {}, 20))).toEqual([
        74, 83, 91, 97, 100, 100, 97, 91, 84, 75, 66, 57, 49, 43, 40, 40, 43, 49, 56, 65,
      ]);
      random.mockReturnValue(0.999);
      expect(opacities(compileEffect('twinkle', { period: 4 }, 9))).toEqual([
        79, 99, 61, 41, 79, 99, 61, 41, 79,
      ]);
    } finally {
      random.mockRestore();
    }
  });

  it.each([0.1, 0.25, 1])(
    'pulse at amplitude %s dips to 100 × (1 − amplitude) at its trough and peaks at 100',
    (amplitude) => {
      const values = opacities(compileEffect('pulse', { amplitude }, 20)) as number[];
      expect(Math.min(...values)).toBe(Math.round(100 * (1 - amplitude)));
      expect(Math.max(...values)).toBe(100);
    },
  );

  it.each([0.2, 1])(
    'twinkle at amplitude %s flickers between 100 × (1 − amplitude) and 100',
    (amplitude) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const values = opacities(compileEffect('twinkle', { amplitude }, 20)) as number[];
        const floor = Math.round(100 * (1 - amplitude));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(floor);
        expect(Math.min(...values)).toBeLessThanOrEqual(floor + 1);
        expect(Math.max(...values)).toBeGreaterThanOrEqual(99);
        expect(Math.max(...values)).toBeLessThanOrEqual(100);
      } finally {
        random.mockRestore();
      }
    },
  );

  it('amplitude 0.5 on pulse and 0.6 on twinkle reproduce their defaults exactly', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(compileEffect('pulse', { amplitude: 0.5 }, 20)).toEqual(
        compileEffect('pulse', {}, 20),
      );
      expect(compileEffect('twinkle', { amplitude: 0.6 }, 20)).toEqual(
        compileEffect('twinkle', {}, 20),
      );
    } finally {
      random.mockRestore();
    }
  });

  it('amplitude changes float, scroll-left, scroll-right, pulse, twinkle, and drift — no other effect', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const readsAmplitude = EFFECT_NAMES.filter(
        (name) =>
          JSON.stringify(compileEffect(name, { amplitude: 0.1 }, 12)) !==
          JSON.stringify(compileEffect(name, { amplitude: 1 }, 12)),
      );
      expect(readsAmplitude).toEqual([
        'float',
        'scroll-left',
        'scroll-right',
        'pulse',
        'twinkle',
        'drift',
      ]);
    } finally {
      random.mockRestore();
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
