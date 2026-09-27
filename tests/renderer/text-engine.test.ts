/**
 * @fileoverview Tests for the styled text engine: semantic layout, measurement, overflow.
 * @module tests/renderer/text-engine.test
 */

import {
  Canvas,
  FONT_3x5,
  FONT_5x7,
  FONT_DIGITS_11x18,
  measureText,
} from '@cyanheads/pixoo-toolkit';
import { describe, expect, it } from 'vitest';
import {
  boxFits,
  describeMissingNumerals,
  drawStyledText,
  FONT_FACES,
  FONT_VARIANTS,
  missingNumeralGlyphs,
  renderAutoFitText,
  resolveX,
  resolveY,
  scrollCycle,
} from '@/renderer/text-engine.js';

// ─── resolveX / resolveY ─────────────────────────────────────────────────────

describe('resolveX', () => {
  it('"left" resolves to 0 (plus dx)', () => {
    expect(resolveX('left', 10, 64, 0)).toBe(0);
    expect(resolveX('left', 10, 64, 5)).toBe(5);
  });

  it('"right" resolves to canvasWidth - contentWidth', () => {
    expect(resolveX('right', 10, 64, 0)).toBe(54);
    expect(resolveX('right', 10, 64, -2)).toBe(52);
  });

  it('"center" resolves to floor((canvas - content) / 2)', () => {
    expect(resolveX('center', 10, 64, 0)).toBe(27); // floor((64-10)/2)
    expect(resolveX('center', 20, 64, 0)).toBe(22); // floor((64-20)/2)
  });

  it('numeric x is used directly (plus dx)', () => {
    expect(resolveX(10, 8, 64, 0)).toBe(10);
    expect(resolveX(10, 8, 64, 3)).toBe(13);
  });

  it('dx nudge applies to all semantic alignments', () => {
    const base = resolveX('center', 10, 64, 0);
    expect(resolveX('center', 10, 64, 4)).toBe(base + 4);
    expect(resolveX('center', 10, 64, -2)).toBe(base - 2);
  });
});

describe('resolveY', () => {
  it('"top" resolves to 0 (plus dy)', () => {
    expect(resolveY('top', 7, 64, 0)).toBe(0);
    expect(resolveY('top', 7, 64, 3)).toBe(3);
  });

  it('"bottom" resolves to canvasHeight - contentHeight', () => {
    expect(resolveY('bottom', 7, 64, 0)).toBe(57);
    expect(resolveY('bottom', 7, 64, -1)).toBe(56);
  });

  it('"center" resolves to floor((canvas - content) / 2)', () => {
    expect(resolveY('center', 7, 64, 0)).toBe(28); // floor((64-7)/2)
  });

  it('numeric y is used directly (plus dy)', () => {
    expect(resolveY(20, 7, 64, 0)).toBe(20);
    expect(resolveY(20, 7, 64, -5)).toBe(15);
  });
});

// ─── drawStyledText ───────────────────────────────────────────────────────────

describe('drawStyledText', () => {
  it('returns a bounding box with non-negative dimensions for non-empty text', () => {
    const canvas = new Canvas(64);
    const box = drawStyledText(canvas, 'HI', 0, 0, {});
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });

  it('compact font produces smaller width than standard font for same text', () => {
    const canvas = new Canvas(64);
    const boxStd = drawStyledText(canvas, 'TEST', 0, 0, {}, 'standard');
    const boxComp = drawStyledText(canvas, 'TEST', 0, 0, {}, 'compact');
    expect(boxComp.w).toBeLessThan(boxStd.w);
  });

  it('scale multiplier increases bounding box dimensions', () => {
    const canvas = new Canvas(64);
    const box1 = drawStyledText(canvas, 'A', 0, 0, { scale: 1 });
    const box2 = drawStyledText(canvas, 'A', 0, 0, { scale: 2 });
    expect(box2.w).toBeGreaterThan(box1.w);
    expect(box2.h).toBeGreaterThan(box1.h);
  });

  it('palette does not crash the renderer', () => {
    const canvas = new Canvas(64);
    expect(() => drawStyledText(canvas, 'OK', 0, 0, { palette: 'ember' })).not.toThrow();
  });

  it('shadow and outline flags do not crash the renderer', () => {
    const canvas = new Canvas(64);
    expect(() => drawStyledText(canvas, 'OK', 5, 5, { shadow: true, outline: true })).not.toThrow();
  });

  it('custom gradient stop palette works', () => {
    const canvas = new Canvas(64);
    expect(() =>
      drawStyledText(canvas, 'HI', 0, 0, { palette: { from: '#ff0000', to: '#0000ff' } }),
    ).not.toThrow();
  });

  it('height matches font.height × scale for standard font', () => {
    const canvas = new Canvas(64);
    const scale = 2;
    const box = drawStyledText(canvas, 'A', 0, 0, { scale }, 'standard');
    expect(box.h).toBe(FONT_5x7.height * scale);
  });

  it('height matches font.height × scale for compact font', () => {
    const canvas = new Canvas(64);
    const scale = 1;
    const box = drawStyledText(canvas, 'A', 0, 0, { scale }, 'compact');
    expect(box.h).toBe(FONT_3x5.height * scale);
  });
});

// ─── renderAutoFitText ────────────────────────────────────────────────────────

describe('renderAutoFitText', () => {
  it('returns a layout entry with type "text"', () => {
    const canvas = new Canvas(64);
    const entry = renderAutoFitText(canvas, 'Hi', 'center', 'center', 0, 0, {}, 'auto', 0, 0, 1);
    expect(entry.type).toBe('text');
    expect(entry.element).toBe(0);
  });

  it('fits:true for short text in auto mode', () => {
    const canvas = new Canvas(64);
    const entry = renderAutoFitText(canvas, 'Hi', 0, 0, 0, 0, {}, 'auto', 0, 0, 1);
    expect(entry.fits).toBe(true);
    expect(entry.action).toBe('none');
  });

  it('auto mode shrinks long text to compact font', () => {
    // A long string that fits in standard but we can test the decision path with overflow
    // Use a text wide enough to overflow at scale 3 but fit at compact
    const canvas = new Canvas(64);
    const longText = 'ABCDEFGHIJKLMN'; // wide enough to test shrink path
    // With scale=2 standard, this will overflow; compact should fit
    const stdW = measureText(longText, { font: FONT_5x7, scale: 2 });
    // Only run the shrink assertion if standard would overflow
    if (stdW > 64) {
      const entry = renderAutoFitText(canvas, longText, 0, 0, 0, 0, { scale: 2 }, 'auto', 0, 0, 1);
      // Action is either shrunk-to-compact or scrolling
      expect(['shrunk-to-compact', 'scrolling']).toContain(entry.action);
    } else {
      // Standard fits — action should be none
      const entry = renderAutoFitText(canvas, longText, 0, 0, 0, 0, { scale: 2 }, 'auto', 0, 0, 1);
      expect(entry.action).toBe('none');
    }
  });

  it('truncate mode sets action to "truncated" on overflow', () => {
    const canvas = new Canvas(64);
    // Force a very wide text with scale 2 — should overflow 64px
    const wideText = 'ABCDEFGHIJKLMNO';
    const textW = measureText(wideText, { font: FONT_5x7, scale: 2 });
    if (textW > 64) {
      const entry = renderAutoFitText(
        canvas,
        wideText,
        0,
        0,
        0,
        0,
        { scale: 2 },
        'truncate',
        0,
        0,
        1,
      );
      expect(entry.action).toBe('truncated');
    }
  });

  it('scroll mode sets action to "scrolling" on overflow', () => {
    const canvas = new Canvas(64);
    const wideText = 'ABCDEFGHIJKLMNO';
    const textW = measureText(wideText, { font: FONT_5x7, scale: 2 });
    if (textW > 64) {
      const entry = renderAutoFitText(
        canvas,
        wideText,
        0,
        0,
        0,
        0,
        { scale: 2 },
        'scroll',
        0,
        0,
        1,
      );
      expect(entry.action).toBe('scrolling');
    }
  });

  it('layout entry box has non-negative dimensions', () => {
    const canvas = new Canvas(64);
    const entry = renderAutoFitText(canvas, 'Hi', 'center', 'center', 0, 0, {}, 'auto', 0, 0, 1);
    expect(entry.box.w).toBeGreaterThan(0);
    expect(entry.box.h).toBeGreaterThan(0);
  });

  it('center alignment places text within canvas bounds (with reasonable text)', () => {
    const canvas = new Canvas(64);
    const entry = renderAutoFitText(canvas, 'Hi', 'center', 'center', 0, 0, {}, 'auto', 0, 0, 1);
    expect(entry.box.x).toBeGreaterThanOrEqual(0);
    expect(entry.box.y).toBeGreaterThanOrEqual(0);
  });

  describe('a requested font is used as given', () => {
    // Overflows 64px in 5×7, fits in 3×5.
    const SHRINKABLE = 'HELLO WORLD!';

    it('compact on text that fits in standard renders compact', () => {
      const entry = renderAutoFitText(
        new Canvas(64),
        'HI',
        0,
        0,
        0,
        0,
        {},
        'auto',
        0,
        0,
        1,
        'compact',
      );
      expect(entry).toMatchObject({ font: 'compact', action: 'none', fits: true });
      expect(entry.box.h).toBe(FONT_3x5.height);
      expect(entry.box.w).toBe(measureText('HI', { font: FONT_3x5 }));
    });

    it('standard on text that only fits compact overflows in standard instead of shrinking', () => {
      expect(measureText(SHRINKABLE, { font: FONT_5x7 })).toBeGreaterThan(64);
      expect(measureText(SHRINKABLE, { font: FONT_3x5 })).toBeLessThanOrEqual(64);
      const entry = renderAutoFitText(
        new Canvas(64),
        SHRINKABLE,
        0,
        0,
        0,
        0,
        {},
        'auto',
        0,
        0,
        1,
        'standard',
      );
      expect(entry).toMatchObject({ font: 'standard', action: 'scrolling', fits: false });
      expect(entry.box.w).toBe(measureText(SHRINKABLE, { font: FONT_5x7 }));
    });

    it('omitting the font keeps auto-fit: the same text shrinks to compact', () => {
      const entry = renderAutoFitText(new Canvas(64), SHRINKABLE, 0, 0, 0, 0, {}, 'auto', 0, 0, 1);
      expect(entry).toMatchObject({ font: 'compact', action: 'shrunk-to-compact', fits: true });
    });

    it('compact that still overflows scrolls in compact', () => {
      const wide = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      expect(measureText(wide, { font: FONT_3x5 })).toBeGreaterThan(64);
      const entry = renderAutoFitText(
        new Canvas(64),
        wide,
        0,
        0,
        0,
        0,
        {},
        'auto',
        0,
        0,
        1,
        'compact',
      );
      expect(entry).toMatchObject({ font: 'compact', action: 'scrolling' });
    });
  });

  it('non-zero frameIdx shifts scroll position', () => {
    const canvas = new Canvas(64);
    const wideText = 'ABCDEFGHIJKLMNO';
    const textW = measureText(wideText, { font: FONT_5x7, scale: 2 });
    if (textW > 64) {
      const e0 = renderAutoFitText(canvas, wideText, 0, 0, 0, 0, { scale: 2 }, 'scroll', 0, 0, 10);
      const e5 = renderAutoFitText(canvas, wideText, 0, 0, 0, 0, { scale: 2 }, 'scroll', 0, 5, 10);
      // Both should be scrolling; resolved box.x stays the same (based on non-animated resolvedX)
      expect(e0.action).toBe('scrolling');
      expect(e5.action).toBe('scrolling');
    }
  });
});

// ─── font faces ──────────────────────────────────────────────────────────────

describe('FONT_FACES', () => {
  it('maps each variant to its toolkit face', () => {
    expect(FONT_VARIANTS).toEqual(['standard', 'compact', 'numerals']);
    expect(FONT_FACES).toEqual({
      standard: FONT_5x7,
      compact: FONT_3x5,
      numerals: FONT_DIGITS_11x18,
    });
  });

  it('drawStyledText draws numerals in the 11×18 face, 13 px per digit', () => {
    const canvas = new Canvas(64);
    expect(drawStyledText(canvas, '12:45', 0, 0, {}, 'numerals')).toEqual({
      x: 0,
      y: 0,
      w: 58,
      h: 18,
    });
    expect(drawStyledText(canvas, '00', 0, 0, { scale: 2 }, 'numerals')).toMatchObject({
      w: 52,
      h: 36,
    });
  });
});

describe('renderAutoFitText with numerals', () => {
  const layOut = (text: string, scale: number, fixedFont?: 'numerals') =>
    renderAutoFitText(
      new Canvas(64),
      text,
      'center',
      'center',
      0,
      0,
      { scale },
      'auto',
      0,
      0,
      1,
      fixedFont,
    );

  it('given explicitly, lays 12:45 out in numerals', () => {
    expect(layOut('12:45', 1, 'numerals')).toMatchObject({
      font: 'numerals',
      action: 'none',
      fits: true,
      box: { x: 3, y: 23, w: 58, h: 18 },
    });
  });

  it('too wide, it scrolls in numerals instead of falling back to compact', () => {
    expect(layOut('12:45', 2, 'numerals')).toMatchObject({
      font: 'numerals',
      action: 'scrolling',
      fits: false,
      box: { w: 116, h: 36 },
    });
  });

  it('auto-fit never selects numerals', () => {
    expect(layOut('12:45', 1)).toMatchObject({ font: 'standard', action: 'none' });
    expect(layOut('0123456789012', 1)).toMatchObject({
      font: 'compact',
      action: 'shrunk-to-compact',
    });
    expect(layOut('01234567890123456789', 1)).toMatchObject({
      font: 'standard',
      action: 'scrolling',
    });
  });
});

describe('missingNumeralGlyphs', () => {
  it('names each character the face lacks once, in order of first appearance', () => {
    expect(missingNumeralGlyphs('72°F')).toEqual(['F']);
    expect(missingNumeralGlyphs('am')).toEqual(['a', 'm']);
    expect(missingNumeralGlyphs('m1a2m3a')).toEqual(['m', 'a']);
  });

  it('accepts every character the face holds, and empty text', () => {
    const held = Object.keys(FONT_DIGITS_11x18.glyphs).join('');
    expect([...held].sort()).toEqual([...'0123456789 :.-+/%°?'].sort());
    expect(missingNumeralGlyphs(held)).toEqual([]);
    expect(missingNumeralGlyphs('')).toEqual([]);
  });

  it('treats a character outside the Basic Multilingual Plane as one character', () => {
    expect(missingNumeralGlyphs('1😀2')).toEqual(['😀']);
  });

  it('describes the gap with the characters quoted and the face listed', () => {
    expect(describeMissingNumerals(['a', 'm'])).toBe(
      'Characters not in the numerals font: "a", "m". It draws 0–9, space, and : . - + / % ° ? only.',
    );
  });
});

// ─── layout fits ─────────────────────────────────────────────────────────────

describe('boxFits', () => {
  it.each([
    [{ x: 0, y: 0, w: 16, h: 16 }, true],
    [{ x: -1, y: 0, w: 4, h: 4 }, false],
    [{ x: 0, y: -1, w: 4, h: 4 }, false],
    [{ x: 13, y: 0, w: 4, h: 4 }, false],
    [{ x: 0, y: 13, w: 4, h: 4 }, false],
    [{ x: 12, y: 12, w: 4, h: 4 }, true],
  ])('%j on a 16×16 canvas: %s', (box, fits) => {
    expect(boxFits(box, 16, 16)).toBe(fits);
  });
});

describe('renderAutoFitText fits: the placed box, every edge', () => {
  it('"1" at scale 3 on a 16-px canvas is 21 px tall — it does not fit', () => {
    const entry = renderAutoFitText(
      new Canvas(16),
      '1',
      'center',
      'center',
      0,
      0,
      { scale: 3 },
      'auto',
      0,
      0,
      1,
    );
    expect(entry).toMatchObject({ box: { x: 3, y: -3, w: 9, h: 21 }, fits: false, action: 'none' });
  });

  it.each([
    ['the left edge', false, -1, 0],
    ['the right edge', false, 56, 0],
    ['the top edge', false, 0, -1],
    ['the bottom edge', false, 0, 58],
    ['no edge (flush right and bottom)', true, 55, 57],
  ] as const)('"Hi" (9×7) placed off %s: fits %s', (_edge, fits, x, y) => {
    const entry = renderAutoFitText(new Canvas(64), 'Hi', x, y, 0, 0, {}, 'auto', 0, 0, 1);
    expect(entry).toMatchObject({ box: { x, y, w: 9, h: 7 }, fits, action: 'none' });
  });

  it('a dx/dy nudge that carries the text off an edge counts', () => {
    const entry = renderAutoFitText(
      new Canvas(64),
      'Hi',
      'left',
      'top',
      -2,
      0,
      {},
      'auto',
      0,
      0,
      1,
    );
    expect(entry).toMatchObject({ box: { x: -2, y: 0 }, fits: false });
  });

  it('text shrunk to compact still fits only where its box is on the canvas', () => {
    const shrunk = renderAutoFitText(
      new Canvas(64),
      'HELLO WORLD!',
      'center',
      62,
      0,
      0,
      {},
      'auto',
      0,
      0,
      1,
    );
    expect(shrunk).toMatchObject({
      action: 'shrunk-to-compact',
      box: { y: 62, h: 5 },
      fits: false,
    });
  });
});

// ─── scrollCycle ─────────────────────────────────────────────────────────────

describe('scrollCycle', () => {
  it('moves 2px a frame while one full crossing fits in 40 frames', () => {
    // 10px wide + 64px canvas = 74px to cross.
    expect(scrollCycle(10, 64)).toEqual({ frames: 37, step: 2 });
  });

  it('holds the 40-frame cap at the boundary where 2px/frame just fits', () => {
    expect(scrollCycle(16, 64)).toEqual({ frames: 40, step: 2 });
  });

  it.each([
    [17, 27],
    [212, 40],
    [1000, 40],
  ])('crosses a %ipx block completely in %i frames, with no blank tail', (width, expected) => {
    const { frames, step } = scrollCycle(width, 64);
    expect(frames).toBe(expected);
    expect(frames).toBeLessThanOrEqual(40);
    // The frame after the last one has the block fully past the left edge…
    expect(64 - frames * step + width).toBeLessThanOrEqual(0);
    // …while the last frame still shows part of it.
    expect(64 - (frames - 1) * step + width).toBeGreaterThan(0);
  });
});
