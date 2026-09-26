/**
 * @fileoverview Tests for scene-renderer: element rendering, background application, layout entries.
 * @module tests/renderer/scene-renderer.test
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Canvas, lerpColor, type RGB, resolveColor, savePng } from '@cyanheads/pixoo-toolkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ICON_NAMES } from '@/renderer/icons.js';
import type { KeyframeEntry } from '@/renderer/keyframes.js';
import {
  type AssetCache,
  applyBackground,
  type IconElement,
  type ImageElement,
  type ProgressElement,
  preloadAssets,
  type RectElement,
  renderElement,
  renderFrame,
  renderScene,
  type SceneElement,
  type SparklineElement,
  type SpriteElement,
  type TextElement,
} from '@/renderer/scene-renderer.js';
import type { LayoutEntry } from '@/renderer/text-engine.js';
import { PALETTES, type PaletteName } from '@/renderer/themes.js';
import { hashOf, inkColors, inkPixels, inkRows, isInk } from '../helpers/canvas-ink.js';
import { trickleRoute } from '../helpers/trickle-body.js';

/** Empty asset cache — no images or sprites preloaded. */
function emptyCache(): AssetCache {
  return { images: new Map(), sprites: new Map() };
}

/** The error `fn` throws; fails the test when `fn` returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected the call to throw.');
}

/** Asset cache holding one preloaded image for `el`. */
function imageCache(el: ImageElement, image: Canvas): AssetCache {
  return { images: new Map([[el, image]]), sprites: new Map() };
}

const BLUE = [0, 0, 255] as const;
const RED = [255, 0, 0] as const;

const GREEN = [0, 255, 0] as const;
const YELLOW = [255, 255, 0] as const;

/** Directory for on-disk image and sprite fixtures, removed after the suite. */
let fixtureDir: string;
/** A 64×64 opaque red PNG. */
let redPngPath: string;
/** A 64×64 PNG in four quadrants: red top-left, blue top-right, green bottom-left, yellow bottom-right. */
let quadrantPngPath: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-scene-renderer-'));
  const red = new Canvas(64);
  red.clear([...RED]);
  redPngPath = path.join(fixtureDir, 'red.png');
  await savePng(red, redPngPath);

  const quadrants = new Canvas(64);
  quadrants.fillRect(0, 0, 32, 32, [...RED]);
  quadrants.fillRect(32, 0, 32, 32, [...BLUE]);
  quadrants.fillRect(0, 32, 32, 32, [...GREEN]);
  quadrants.fillRect(32, 32, 32, 32, [...YELLOW]);
  quadrantPngPath = path.join(fixtureDir, 'quadrants.png');
  await savePng(quadrants, quadrantPngPath);
});

afterAll(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

// ─── applyBackground ──────────────────────────────────────────────────────────

describe('applyBackground', () => {
  it('solid color fills canvas', () => {
    const canvas = new Canvas(64);
    applyBackground(canvas, '#ff0000');
    const [r] = canvas.getPixelRgba(0, 0);
    expect(r).toBe(255);
  });

  it('vertical gradient: top pixel differs from bottom pixel', () => {
    const canvas = new Canvas(64);
    applyBackground(canvas, { gradient: { type: 'v', from: '#ffffff', to: '#000000' } });
    const [, , , aTop] = canvas.getPixelRgba(32, 0);
    const [, , , aBot] = canvas.getPixelRgba(32, 63);
    // Top should be lighter (sum) than bottom
    const topSum = canvas
      .getPixelRgba(32, 0)
      .slice(0, 3)
      .reduce((a, b) => (a as number) + (b as number), 0) as number;
    const botSum = canvas
      .getPixelRgba(32, 63)
      .slice(0, 3)
      .reduce((a, b) => (a as number) + (b as number), 0) as number;
    expect(topSum).toBeGreaterThan(botSum);
    // Both pixels are visible (alpha > 0)
    expect(aTop).toBeGreaterThan(0);
    expect(aBot).toBeGreaterThan(0);
  });

  it('named theme applies without throwing', () => {
    const canvas = new Canvas(64);
    expect(() => applyBackground(canvas, { theme: 'midnight' })).not.toThrow();
  });

  it('transparent background clears canvas to zero', () => {
    const canvas = new Canvas(64);
    canvas.clear([255, 0, 0]);
    applyBackground(canvas, 'transparent');
    const [, , , a] = canvas.getPixelRgba(0, 0);
    expect(a).toBe(0);
  });
});

// ─── renderElement — rect ─────────────────────────────────────────────────────

describe('renderElement — rect', () => {
  it('solid rect paints pixels in the declared region', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: RectElement = { type: 'rect', x: 0, y: 0, w: 10, h: 5, color: '#00ff00' };
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);

    // A pixel inside the rect should be green
    const [, g] = canvas.getPixelRgba(5, 2);
    expect(g).toBeGreaterThan(0);

    // Layout entry
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      element: 0,
      type: 'rect',
      box: { x: 0, y: 0, w: 10, h: 5 },
    });
  });

  it('gradient rect produces different colors at opposing corners', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: RectElement = {
      type: 'rect',
      x: 0,
      y: 0,
      w: 20,
      h: 20,
      gradient: { type: 'v', from: '#ffffff', to: '#000000' },
    };
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);

    const topBrightness = canvas
      .getPixelRgba(10, 0)
      .slice(0, 3)
      .reduce((a, b) => (a as number) + (b as number), 0) as number;
    const botBrightness = canvas
      .getPixelRgba(10, 19)
      .slice(0, 3)
      .reduce((a, b) => (a as number) + (b as number), 0) as number;
    expect(topBrightness).toBeGreaterThan(botBrightness);
  });
});

// ─── renderElement — sparkline ────────────────────────────────────────────────

describe('renderElement — sparkline', () => {
  /** Render one sparkline on a black 64px canvas; return the canvas and its layout box. */
  function sparkline(el: Omit<SparklineElement, 'type'>) {
    const canvas = new Canvas(64);
    canvas.clear([0, 0, 0]);
    const entries: LayoutEntry[] = [];
    renderElement(canvas, { type: 'sparkline', ...el }, 0, 0, 1, emptyCache(), entries);
    return { canvas, box: entries[0]!.box };
  }

  /** The bounding box of every ink pixel on `canvas`, over a black background. */
  function inkBounds(canvas: Canvas) {
    const points = inkPixels(canvas, [0, 0, 0]).map((p) => p.split(',').map(Number));
    const xs = points.map(([x]) => x!);
    const ys = points.map(([, y]) => y!);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  it.each<[string, Omit<SparklineElement, 'type'>]>([
    ['a rising pair', { x: 0, y: 0, w: 20, h: 8, data: [1, 2] }],
    ['a falling pair', { x: 5, y: 3, w: 20, h: 8, data: [2, 1] }],
    ['the smallest box', { x: 10, y: 10, w: 2, h: 2, data: [0, 1] }],
    [
      'more points than columns',
      { x: 0, y: 20, w: 8, h: 6, data: [3, 9, 1, 7, 2, 8, 4, 6, 5, 0, 9, 3] },
    ],
    ['negative values', { x: 30, y: 30, w: 30, h: 12, data: [-5, 3, -2, 8, -9] }],
    ['a box flush to the bottom-right corner', { x: 44, y: 56, w: 20, h: 8, data: [1, 5, 2, 9] }],
  ])('line mode with %s inks exactly its box, edge to edge', (_label, el) => {
    const { canvas, box } = sparkline(el);
    expect(box).toEqual({ x: el.x, y: el.y, w: el.w, h: el.h });
    expect(inkBounds(canvas)).toEqual({
      x0: el.x,
      x1: el.x + el.w - 1,
      y0: el.y,
      y1: el.y + el.h - 1,
    });
    const [min, max] = [Math.min(...el.data), Math.max(...el.data)];
    const first = el.data[0]!;
    const last = el.data.at(-1)!;
    const rowOf = (v: number) =>
      el.y + el.h - 1 - Math.round(((v - min) / (max - min)) * (el.h - 1));
    expect(isInk(canvas, el.x, rowOf(first), [0, 0, 0])).toBe(true);
    expect(isInk(canvas, el.x + el.w - 1, rowOf(last), [0, 0, 0])).toBe(true);
  });

  it('line mode with a flat series draws along the bottom row of its box', () => {
    const { canvas } = sparkline({ x: 4, y: 4, w: 10, h: 5, data: [7, 7, 7] });
    expect(inkBounds(canvas)).toEqual({ x0: 4, x1: 13, y0: 8, y1: 8 });
  });

  it('bar mode renders a pinned frame', () => {
    const canvas = new Canvas(64);
    canvas.clear([0, 0, 0]);
    const bars: SceneElement[] = [
      { type: 'sparkline', kind: 'bar', x: 0, y: 0, w: 20, h: 8, data: [1, 2] },
      { type: 'sparkline', kind: 'bar', x: 30, y: 0, w: 34, h: 10, data: [3, -1, 4, 1, 5, 9, 2] },
      { type: 'sparkline', kind: 'bar', x: 0, y: 20, w: 2, h: 2, data: [5, 5, 5] },
      {
        type: 'sparkline',
        kind: 'bar',
        x: 10,
        y: 30,
        w: 54,
        h: 34,
        data: [0, 10, 20, 15, 5],
        color: 'orange',
      },
    ];
    for (const [i, el] of bars.entries()) renderElement(canvas, el, i, 0, 1, emptyCache(), []);
    expect(hashOf(canvas)).toBe('6bb49d105295ee075f2dbbcb68b174c91ea9925661fb1783c89a44de7c89c542');
  });
});

// ─── renderElement — icon ─────────────────────────────────────────────────────

describe('renderElement — icon', () => {
  it.each(ICON_NAMES)('registered icon "%s" renders and reports its box', (name) => {
    const entries: LayoutEntry[] = [];
    renderElement(
      new Canvas(64),
      { type: 'icon', name, x: 3, y: 5, w: 16, h: 16 },
      0,
      0,
      1,
      emptyCache(),
      entries,
    );
    expect(entries).toEqual([
      { element: 0, type: 'icon', box: { x: 3, y: 5, w: 16, h: 16 }, fits: true, action: 'none' },
    ]);
  });

  it('icons without a palette render a pinned frame: every registered icon but music (pinned by its glyph tests), default and explicit color, plus a custom path', () => {
    const icons: SceneElement[] = ICON_NAMES.map((name, i) => ({
      type: 'icon' as const,
      name,
      x: (i % 5) * 13,
      y: Math.floor(i / 5) * 13,
      ...(i % 2 === 1 ? { color: '#ff8800' } : {}),
    })).filter((icon) => icon.name !== 'music');
    icons.push({
      type: 'icon',
      d: 'M2 2h20v20H2z',
      viewBox: '0 0 24 24',
      x: 0,
      y: 52,
      w: 12,
      h: 12,
    });
    const { canvas } = renderFrame(0, 1, '#000000', icons, emptyCache(), 64);
    expect(hashOf(canvas)).toMatchInlineSnapshot(
      `"c13da96f343eebfb540f10abbbafe3d5ae6ff7ec6ad1b971ad65407d74f80d0b"`,
    );
  });

  it('fill-drawn icons other than music and a custom path render byte-identically at 16px and the default 12px', () => {
    const fillIcons = ['cloud', 'lightning', 'heart', 'star', 'play', 'pause', 'stop'];
    const icons: SceneElement[] = fillIcons.map((name, i) => ({
      type: 'icon',
      name,
      x: (i % 4) * 16,
      y: Math.floor(i / 4) * 16,
      w: 16,
      h: 16,
      ...(i % 2 === 1 ? { color: '#ff8800' } : {}),
    }));
    for (const [i, name] of fillIcons.entries()) {
      icons.push({ type: 'icon', name, x: (i % 5) * 13, y: 32 + Math.floor(i / 5) * 13 });
    }
    icons.push({
      type: 'icon',
      d: 'M2 2h20v20H2z',
      viewBox: '0 0 24 24',
      x: 52,
      y: 52,
      w: 12,
      h: 12,
    });
    const { canvas } = renderFrame(0, 1, '#000000', icons, emptyCache(), 64);
    expect(hashOf(canvas)).toBe('0d6e584e0bee995def84d18c3769ed6fe34ea5270c4f44ddc0f889df4cdc79bb');
  });

  describe('glyphs', () => {
    /** A registry icon drawn 16×16 at the origin, where one viewBox unit is one pixel. */
    function glyph(name: string): Canvas {
      const canvas = new Canvas(64);
      renderElement(
        canvas,
        { type: 'icon', name, x: 0, y: 0, w: 16, h: 16 },
        0,
        0,
        1,
        emptyCache(),
        [],
      );
      return canvas;
    }

    it.each(ICON_NAMES)('"%s" draws ink', (name) => {
      expect(inkPixels(glyph(name)).length).toBeGreaterThan(0);
    });

    type Pixel = [number, number];
    const ring: Pixel[] = [
      [1, 8],
      [15, 8],
    ];

    it.each<[string, Pixel[], Pixel[]]>([
      [
        'sun',
        [
          [8, 8],
          [8, 1],
          [8, 14],
          [1, 8],
          [14, 8],
          [3, 3],
          [12, 12],
        ],
        [],
      ],
      [
        'rain',
        [
          [5, 3],
          [5, 12],
          [8, 13],
          [11, 12],
        ],
        [],
      ],
      [
        'snow',
        [
          [8, 1],
          [8, 14],
          [1, 8],
          [14, 8],
          [8, 8],
          [3, 4],
          [12, 12],
        ],
        [],
      ],
      [
        'wind',
        [
          [1, 6],
          [1, 8],
          [6, 8],
          [1, 10],
          [14, 10],
        ],
        [],
      ],
      [
        'arrow-up',
        [
          [8, 2],
          [8, 5],
          [8, 12],
        ],
        [],
      ],
      [
        'arrow-down',
        [
          [8, 13],
          [8, 10],
          [8, 4],
        ],
        [],
      ],
      [
        'arrow-left',
        [
          [2, 8],
          [5, 8],
          [12, 8],
        ],
        [],
      ],
      [
        'arrow-right',
        [
          [14, 8],
          [11, 8],
          [3, 8],
        ],
        [],
      ],
      [
        'check-circle',
        [...ring, [5, 8], [7, 10], [10, 7]],
        [
          [8, 4],
          [8, 12],
        ],
      ],
      [
        'x-circle',
        [...ring, [5, 5], [8, 8], [11, 5], [5, 11], [11, 11]],
        [
          [8, 4],
          [4, 8],
        ],
      ],
      [
        'alert-circle',
        [...ring, [8, 5], [8, 9], [8, 11]],
        [
          [8, 10],
          [5, 8],
        ],
      ],
      [
        'info',
        [...ring, [8, 5], [8, 8], [8, 12]],
        [
          [8, 7],
          [5, 8],
        ],
      ],
    ])('"%s" draws its whole glyph, stroke and fill parts alike', (name, ink, blank) => {
      const canvas = glyph(name);
      expect(ink.filter(([x, y]) => !isInk(canvas, x, y))).toEqual([]);
      expect(blank.filter(([x, y]) => isInk(canvas, x, y))).toEqual([]);
    });

    it('"music" draws a beam that joins its two stems across the top', () => {
      const canvas = glyph('music');
      const beamRow = Array.from({ length: 11 }, (_, i): Pixel => [2 + i, 3]);
      const stems: Pixel[] = [
        [3, 6],
        [11, 6],
      ];
      expect([...beamRow, ...stems].filter(([x, y]) => !isInk(canvas, x, y))).toEqual([]);
      const clear: Pixel[] = [
        [7, 1],
        [7, 6],
        [1, 3],
      ];
      expect(clear.filter(([x, y]) => isInk(canvas, x, y))).toEqual([]);
    });

    it('"music" at the default 12px keeps its beam unbroken between the stems', () => {
      const canvas = new Canvas(64);
      renderElement(canvas, { type: 'icon', name: 'music' }, 0, 0, 1, emptyCache(), []);
      const beamRow = Array.from({ length: 8 }, (_, i): Pixel => [2 + i, 2]);
      expect(beamRow.filter(([x, y]) => !isInk(canvas, x, y))).toEqual([]);
    });

    it('x-circle, alert-circle, and info each draw their own mark', () => {
      const shapes = ['x-circle', 'alert-circle', 'info'].map((name) =>
        inkPixels(glyph(name)).join(' '),
      );
      expect(new Set(shapes).size).toBe(3);
    });
  });

  it.each(Object.getOwnPropertyNames(Object.prototype))(
    'Object.prototype name "%s" is an unknown icon',
    (name) => {
      expect(
        thrownBy(() =>
          renderElement(new Canvas(64), { type: 'icon', name }, 0, 0, 1, emptyCache(), []),
        ),
      ).toMatchObject({ code: JsonRpcErrorCode.InvalidParams, data: { reason: 'unknown_icon' } });
    },
  );

  describe('palette', () => {
    const heart = { name: 'heart', x: 4, y: 4, w: 24, h: 24 } as const;

    /** Render one icon onto a transparent 64px canvas. */
    function icon(el: Omit<IconElement, 'type'>, frameIdx = 0, totalFrames = 1): Canvas {
      const canvas = new Canvas(64);
      renderElement(canvas, { type: 'icon', ...el }, 0, frameIdx, totalFrames, emptyCache(), []);
      return canvas;
    }

    /** The color each ink row of `canvas` should hold under the palette's top-to-bottom ramp. */
    function expectedRamp(canvas: Canvas, palette: PaletteName): RGB[][] {
      const from = resolveColor(PALETTES[palette].from);
      const to = resolveColor(PALETTES[palette].to);
      const rows = inkRows(canvas);
      const top = rows[0]!;
      const span = rows.at(-1)! - top;
      return rows.map((y) => [lerpColor(from, to, span === 0 ? 0 : (y - top) / span)]);
    }

    it('paints every ink row with its step of the from → to ramp, over the unchanged ink shape', () => {
      const ramped = icon({ ...heart, palette: 'fire' });
      const rows = inkRows(ramped);
      expect(rows).toEqual(inkRows(icon(heart)));
      expect(rows.map((y) => inkColors(ramped, y))).toEqual(expectedRamp(ramped, 'fire'));
    });

    it.each(['sun', 'snow', 'arrow-up', 'x-circle'])(
      'ramps every ink row of "%s", stroke and fill parts alike, over the unchanged ink shape',
      (name) => {
        const el = { name, x: 4, y: 4, w: 24, h: 24 };
        const ramped = icon({ ...el, palette: 'fire' });
        expect(inkRows(ramped).length).toBeGreaterThan(2);
        expect(inkPixels(ramped)).toEqual(inkPixels(icon(el)));
        expect(inkRows(ramped).map((y) => inkColors(ramped, y))).toEqual(
          expectedRamp(ramped, 'fire'),
        );
      },
    );

    it('ramps a custom path the same way', () => {
      const ramped = icon({
        d: 'M2 2h20v20H2z',
        viewBox: '0 0 24 24',
        x: 4,
        y: 4,
        w: 24,
        h: 24,
        palette: 'neon',
      });
      expect(inkRows(ramped).length).toBeGreaterThan(2);
      expect(inkRows(ramped).map((y) => inkColors(ramped, y))).toEqual(
        expectedRamp(ramped, 'neon'),
      );
    });

    it('mono renders byte-identically to the default white icon', () => {
      expect(hashOf(icon({ ...heart, palette: 'mono' }))).toBe(hashOf(icon(heart)));
    });

    it('an icon one ink row tall takes the `from` color', () => {
      const flat = icon({ ...heart, name: 'stop', h: 1, palette: 'ember' });
      expect(inkRows(flat)).toHaveLength(1);
      expect(inkColors(flat)).toEqual([resolveColor(PALETTES.ember.from)]);
    });

    it('an icon clipped by the top edge ramps across its visible ink rows', () => {
      const clipped = icon({ ...heart, y: -10, palette: 'ice' });
      const rows = inkRows(clipped);
      expect(rows[0]).toBe(0);
      expect(inkColors(clipped, rows[0])).toEqual([resolveColor(PALETTES.ice.from)]);
      expect(inkColors(clipped, rows.at(-1))).toEqual([resolveColor(PALETTES.ice.to)]);
    });

    it('an icon entirely off the canvas draws nothing and does not throw', () => {
      expect(inkRows(icon({ ...heart, x: 100, palette: 'ice' }))).toEqual([]);
    });

    it('the ramp moves with the icon across animated frames', () => {
      for (const frameIdx of [0, 1, 2, 3]) {
        const frame = icon(
          { ...heart, palette: 'claude', effect: { name: 'float', amplitude: 3 } },
          frameIdx,
          4,
        );
        const rows = inkRows(frame);
        expect(inkColors(frame, rows[0])).toEqual([resolveColor(PALETTES.claude.from)]);
        expect(inkColors(frame, rows.at(-1))).toEqual([resolveColor(PALETTES.claude.to)]);
      }
    });

    it('opacity below 100 blends the ramp over the layer beneath', () => {
      const black: RGB = [0, 0, 0];
      const canvas = new Canvas(64).clear(black);
      renderElement(
        canvas,
        { type: 'icon', name: 'stop', x: 0, y: 0, w: 16, h: 16, palette: 'fire', opacity: 50 },
        0,
        0,
        1,
        emptyCache(),
        [],
      );
      const half = (c: RGB): RGB => [
        Math.round(c[0] / 2),
        Math.round(c[1] / 2),
        Math.round(c[2] / 2),
      ];
      const rows = inkRows(canvas, black);
      expect(inkColors(canvas, rows[0], black)).toEqual([half(resolveColor(PALETTES.fire.from))]);
      expect(inkColors(canvas, rows.at(-1), black)).toEqual([half(resolveColor(PALETTES.fire.to))]);
    });
  });
});

// ─── renderScene — colors with no keyframed color ─────────────────────────────

describe('renderScene — elements with no keyframed color', () => {
  it('render byte-identically, frame by frame, under effects and non-color keyframes', async () => {
    const { frames } = await renderScene(
      '#101020',
      [
        {
          type: 'text',
          text: 'HI',
          x: 2,
          y: 2,
          color: '#ffa500',
          style: { shadow: true },
          effect: { name: 'float' },
        },
        { type: 'icon', name: 'star', x: 40, y: 2, color: '#44ccff', effect: { name: 'pulse' } },
        { type: 'rect', x: 2, y: 20, w: 20, h: 6, color: '#ff0000', borderColor: '#ffffff' },
        {
          type: 'circle',
          cx: 40,
          cy: 24,
          radius: 5,
          color: '#00ff00',
          animate: {
            dx: [
              [0, 0],
              [2, 6],
            ],
          },
        },
        { type: 'line', x0: 0, y0: 40, x1: 63, y1: 44, color: '#ffff00' },
        { type: 'sparkline', x: 2, y: 46, w: 30, h: 10, data: [1, 4, 2, 6, 3] },
        { type: 'pixels', data: [{ x: 60, y: 60, color: '#ff00ff' }] },
      ],
      3,
      createMockContext(),
      64,
    );
    expect(frames.map(hashOf)).toMatchInlineSnapshot(`
      [
        "d171624a4d349a28719edbf939573f2c4dda5757ce2e65a409a7bdd0ace21255",
        "aa7a11426df5cbaa54bfdfb297c10594ee9de9ced78ddbf97d838afe886e7a7e",
        "9ee2da2b742bc98b0db94fee4212127d42eaa6f44acfc44cb1b0b9f5d35d6112",
      ]
    `);
  });
});

// ─── renderScene — keyframed color ────────────────────────────────────────────

describe('renderScene — keyframed color', () => {
  /** Render `elements` onto a transparent background; return each frame's ink colors. */
  async function frameColors(elements: SceneElement[], frames: number): Promise<RGB[][]> {
    const rendered = await renderScene('transparent', elements, frames, createMockContext(), 64);
    return rendered.frames.map((frame) => inkColors(frame));
  }

  it('walks every segment of a multi-keyframe track, holding the ends', async () => {
    const colors = await frameColors(
      [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: 4,
          h: 4,
          animate: {
            color: [
              [1, 'red'],
              [3, '#00ff00'],
              [5, 'blue'],
            ],
          },
        },
      ],
      7,
    );
    expect(colors).toEqual([
      [[255, 0, 0]], // held before the first keyframe
      [[255, 0, 0]],
      [[128, 128, 0]],
      [[0, 255, 0]],
      [[0, 128, 128]], // second segment
      [[0, 0, 255]],
      [[0, 0, 255]], // held after the last keyframe
    ]);
  });

  it('a text element with a style object animates on every frame, not just the first', async () => {
    const colors = await frameColors(
      [
        {
          type: 'text',
          text: 'HI',
          style: { scale: 2 },
          animate: {
            color: [
              [0, 'red'],
              [2, 'blue'],
            ],
          },
        },
      ],
      3,
    );
    expect(colors).toEqual([[[255, 0, 0]], [[128, 0, 128]], [[0, 0, 255]]]);
  });

  it.each<[string, SceneElement, RGB[]]>([
    [
      'an icon palette',
      {
        type: 'icon',
        name: 'stop',
        w: 16,
        h: 16,
        palette: 'mono',
        animate: { color: [[0, 'red']] },
      },
      [[255, 255, 255]],
    ],
    [
      'a rect gradient',
      {
        type: 'rect',
        x: 0,
        y: 0,
        w: 4,
        h: 1,
        gradient: { type: 'v', from: '#00ff00', to: '#00ff00' },
        animate: { color: [[0, 'red']] },
      },
      [[0, 255, 0]],
    ],
    [
      "a text style's palette",
      { type: 'text', text: 'I', style: { palette: 'mono' }, animate: { color: [[0, 'red']] } },
      [[255, 255, 255]],
    ],
  ])('keyframed color yields to %s, as the static color does', async (_label, el, expected) => {
    expect(await frameColors([el], 1)).toEqual([expected]);
  });

  it('a color track of numeric-looking strings lerps through RGB, as colors', async () => {
    const colors = await frameColors(
      [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          animate: {
            color: [
              [0, '000'],
              [4, '100'],
            ],
          },
        },
      ],
      5,
    );
    const [black, darkRed] = [resolveColor('000'), resolveColor('100')];
    expect(colors).toEqual([0, 1, 2, 3, 4].map((frame) => [lerpColor(black, darkRed, frame / 4)]));
  });

  it.each<[string, KeyframeEntry[], number, string]>([
    [
      'past the last frame rendered',
      [
        [0, 'red'],
        [5, 'notacolor'],
      ],
      2,
      'notacolor',
    ],
    [
      'on a one-frame scene',
      [
        [0, 'red'],
        [5, 'notacolor'],
      ],
      1,
      'notacolor',
    ],
    [
      'between two good keyframes, beyond the frames rendered',
      [
        [0, 'red'],
        [4, 'notacolor'],
        [8, 'blue'],
      ],
      3,
      'notacolor',
    ],
    [
      'before the first frame',
      [
        [-2, 'notacolor'],
        [0, 'red'],
      ],
      3,
      'notacolor',
    ],
    [
      'as a number',
      [
        [0, 'red'],
        [3, 7],
      ],
      2,
      '7',
    ],
  ])('a color keyframe that is not a color fails %s', async (_label, color, frames, bad) => {
    await expect(
      renderScene(
        '#000000',
        [{ type: 'pixels', data: [{ x: 1, y: 1, color: 'white' }], animate: { color } }],
        frames,
        createMockContext(),
        64,
      ),
    ).rejects.toThrow(`Unknown color: "${bad}"`);
  });
});

// ─── renderScene — keyframed numbers ──────────────────────────────────────────

describe('renderScene — keyframed numbers', () => {
  it('numeric-string opacity keyframes render as numbers, on their own frames and between them', async () => {
    const { frames } = await renderScene(
      '#000000',
      [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          color: '#ffffff',
          animate: {
            opacity: [
              [0, '10'],
              [2, '90'],
            ],
          },
        },
      ],
      3,
      createMockContext(),
      64,
    );
    expect(frames.map((frame) => frame.getPixelRgba(0, 0))).toEqual([
      [26, 26, 26, 255],
      [128, 128, 128, 255],
      [230, 230, 230, 255],
    ]);
  });

  /** The same keyframe map with every value read as a number. */
  function asNumbers(animate: Record<string, KeyframeEntry[]>): Record<string, KeyframeEntry[]> {
    return Object.fromEntries(
      Object.entries(animate).map(([prop, track]) => [
        prop,
        track.map(([frame, value]): KeyframeEntry => [frame, Number(value)]),
      ]),
    );
  }

  it.each<[string, Record<string, KeyframeEntry[]>]>([
    [
      'opacity, hex-looking',
      {
        opacity: [
          [0, '000'],
          [4, '100'],
        ],
      },
    ],
    [
      'opacity',
      {
        opacity: [
          [0, '10'],
          [2, '90'],
          [4, '40'],
        ],
      },
    ],
    [
      'dx',
      {
        dx: [
          [0, '0'],
          [4, '12'],
        ],
      },
    ],
    [
      'dy',
      {
        dy: [
          [0, '-3'],
          [4, '9'],
        ],
      },
    ],
    [
      'dx, dy, and opacity together',
      {
        dx: [
          [0, '2'],
          [4, '-6'],
        ],
        dy: [
          [0, '6'],
          [4, '0'],
        ],
        opacity: [
          [0, '100'],
          [4, '000'],
        ],
      },
    ],
  ])(
    'a numeric-string %s track renders every frame exactly as the same numbers do',
    async (_label, animate) => {
      const render = async (track: Record<string, KeyframeEntry[]>) => {
        const { frames } = await renderScene(
          '#000000',
          [{ type: 'rect', x: 20, y: 20, w: 4, h: 4, color: '#ffffff', animate: track }],
          5,
          createMockContext(),
          64,
        );
        return frames.map(hashOf);
      };
      const numbers = await render(asNumbers(animate));
      expect(new Set(numbers).size).toBeGreaterThan(2);
      expect(await render(animate)).toEqual(numbers);
    },
  );
});

// ─── renderScene — effect amplitude ───────────────────────────────────────────

describe('renderScene — effect amplitude', () => {
  it.each(['pulse', 'twinkle'] as const)(
    '%s at amplitude 0.1 and 1 renders different frames',
    async (name) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const render = (amplitude: number) =>
          renderScene(
            '#000000',
            [
              {
                type: 'rect',
                x: 0,
                y: 0,
                w: 4,
                h: 4,
                color: '#ffffff',
                effect: { name, amplitude },
              },
            ],
            6,
            createMockContext(),
            64,
          );
        const [shallow, deep] = await Promise.all([render(0.1), render(1)]);
        expect(shallow.frames.map(hashOf)).not.toEqual(deep.frames.map(hashOf));
      } finally {
        random.mockRestore();
      }
    },
  );
});

// ─── renderElement — text ─────────────────────────────────────────────────────

describe('renderElement — text', () => {
  it('text element produces a layout entry with correct type', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: TextElement = { type: 'text', text: 'AB', x: 0, y: 0 };
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('text');
    expect(entries[0]!.box.w).toBeGreaterThan(0);
    expect(entries[0]!.box.h).toBeGreaterThan(0);
  });

  it('text with scale:2 reports height = font.height * 2', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: TextElement = { type: 'text', text: 'X', x: 0, y: 0, style: { scale: 2 } };
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);
    // Standard font height is 7; scale 2 → 14
    expect(entries[0]!.box.h).toBe(14);
  });
});

// ─── renderElement — progress bar ─────────────────────────────────────────────

describe('renderElement — progress', () => {
  it('progress bar renders fill and reports layout entry', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: ProgressElement = {
      type: 'progress',
      x: 0,
      y: 0,
      w: 60,
      h: 6,
      value: 50,
      max: 100,
    };
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'progress', box: { w: 60, h: 6 } });

    // The filled half should have a non-dark pixel (default fill is [0, 200, 100])
    const [, g] = canvas.getPixelRgba(5, 3);
    expect(g).toBeGreaterThan(50);
  });

  it('opacity < 100 blends the element (pixel alpha is between 0 and full)', () => {
    const canvas = new Canvas(64);
    const entries: LayoutEntry[] = [];
    const el: ProgressElement & { opacity: number } = {
      type: 'progress',
      x: 0,
      y: 0,
      w: 60,
      h: 6,
      value: 100,
      max: 100,
      opacity: 50,
    };
    // Start with a known base color
    canvas.clear([0, 0, 0]);
    renderElement(canvas, el, 0, 0, 1, emptyCache(), entries);

    // At 50% opacity over black, the green channel should be around 100 (half of 200), not full 200
    const [, g] = canvas.getPixelRgba(5, 3);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(200);
  });
});

// ─── renderElement — image ────────────────────────────────────────────────────

describe('renderElement — image', () => {
  /** A red square over the top-left 32×32, transparent elsewhere. */
  function halfImage(): Canvas {
    const img = new Canvas(64);
    img.fillRect(0, 0, 32, 32, [...RED]);
    return img;
  }

  it.each([
    ['default opacity', undefined, 0, 0],
    ['explicit opacity 100', 100, 0, 0],
    ['opacity 100 with a dx/dy nudge', 100, 3, -2],
  ])('%s composites byte-identically to a direct blit', (_label, opacity, dx, dy) => {
    const image = halfImage();
    const expected = new Canvas(64);
    expected.clear([...BLUE]);
    expected.blit(image, dx, dy);

    const canvas = new Canvas(64);
    canvas.clear([...BLUE]);
    const el: ImageElement = { type: 'image', source: 'img', dx, dy };
    if (opacity !== undefined) el.opacity = opacity;
    renderElement(canvas, el, 0, 0, 1, imageCache(el, image), []);

    expect(Buffer.from(canvas.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
  });

  it('opacity 30 blends the image with the layer beneath it', () => {
    const canvas = new Canvas(64);
    canvas.clear([...BLUE]);
    const el: ImageElement = { type: 'image', source: 'img', opacity: 30 };
    renderElement(canvas, el, 0, 0, 1, imageCache(el, halfImage()), []);

    // Inside the image: strictly between red (image) and blue (background).
    const [r, g, b] = canvas.getPixelRgba(5, 5);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(255);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(255);
    expect(g).toBe(0);
    // Mostly background at 30%: blue still dominates.
    expect(b).toBeGreaterThan(r);

    // Outside the image's opaque region the background is untouched.
    expect(canvas.getPixelRgba(48, 48)).toEqual([...BLUE, 255]);
  });

  it('opacity 0 leaves the canvas untouched', () => {
    const canvas = new Canvas(64);
    canvas.clear([...BLUE]);
    const before = Buffer.from(canvas.buffer);
    const el: ImageElement = { type: 'image', source: 'img', opacity: 0 };
    renderElement(canvas, el, 0, 0, 1, imageCache(el, halfImage()), []);
    expect(Buffer.from(canvas.buffer).equals(before)).toBe(true);
  });
});

// ─── preloadAssets — local image and sprite paths ─────────────────────────────

describe('preloadAssets — local paths', () => {
  it('loads a local image file into the cache', async () => {
    const el: ImageElement = { type: 'image', source: redPngPath };
    const cache = await preloadAssets([el], createMockContext(), 64);
    const image = cache.images.get(el);
    expect(image).toBeInstanceOf(Canvas);
    expect(image?.getPixelRgba(10, 10)).toEqual([...RED, 255]);
  });

  it.each([16, 32, 64] as const)(
    'loads an image onto a %ipx canvas, fitted to it',
    async (size) => {
      const el: ImageElement = { type: 'image', source: quadrantPngPath };
      const cache = await preloadAssets([el], createMockContext(), size);
      const image = cache.images.get(el)!;
      expect(image.width).toBe(size);
      expect(image.getPixelRgba(size - 1, size - 1)).toEqual([...YELLOW, 255]);
    },
  );

  it('loads a local sprite sheet into the cache', async () => {
    const cache = await preloadAssets(
      [{ type: 'sprite', path: redPngPath, cols: 4, rows: 4 }],
      createMockContext(),
      64,
    );
    const sprite = cache.sprites.get(`${redPngPath}:4:4`);
    expect(sprite).toMatchObject({ cols: 4, rows: 4 });
  });

  it.each([
    ['image', (missing: string): ImageElement => ({ type: 'image', source: missing })],
    [
      'sprite',
      (missing: string): SpriteElement => ({ type: 'sprite', path: missing, cols: 4, rows: 4 }),
    ],
  ])('a missing local %s path fails as asset_not_found', async (_kind, build) => {
    const missing = path.join(fixtureDir, 'does-not-exist.png');
    await expect(preloadAssets([build(missing)], createMockContext(), 64)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'asset_not_found',
        path: missing,
        recovery: { hint: expect.any(String) },
      },
    });
  });

  it('a missing asset among valid ones still fails the whole preload', async () => {
    const missing = path.join(fixtureDir, 'nested-missing.png');
    await expect(
      preloadAssets(
        [
          { type: 'image', source: redPngPath },
          { type: 'sprite', path: redPngPath, cols: 2, rows: 2 },
          { type: 'sprite', path: missing, cols: 2, rows: 2 },
        ],
        createMockContext(),
        64,
      ),
    ).rejects.toMatchObject({ data: { reason: 'asset_not_found', path: missing } });
  });
});

// ─── preloadAssets — remote image cancellation ────────────────────────────────

describe('preloadAssets — remote image cancellation', () => {
  const url = 'https://images.test/slow-scene.png';

  it('aborting the request signal mid-download cancels the body stream', async () => {
    const controller = new AbortController();
    const { route, state } = trickleRoute(url, new Uint8Array(200 * 1024), {
      onChunk: (n) => n === 3 && controller.abort(),
    });
    const http = createFetchMock([route]);
    http.install();
    try {
      await expect(
        preloadAssets(
          [
            { type: 'image', source: redPngPath },
            { type: 'image', source: url },
          ],
          createMockContext({ signal: controller.signal }),
          64,
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThan(10);
    } finally {
      http.restore();
    }
  });

  it('an uncancelled remote image loads into the cache', async () => {
    const png = await fs.readFile(redPngPath);
    const { route, state } = trickleRoute(url, new Uint8Array(png), { chunkBytes: 64 });
    const http = createFetchMock([route]);
    http.install();
    try {
      const el: ImageElement = { type: 'image', source: url };
      const cache = await preloadAssets(
        [el],
        createMockContext({ signal: new AbortController().signal }),
        32,
      );
      expect(cache.images.get(el)?.getPixelRgba(31, 31)).toEqual([...RED, 255]);
      expect(state.cancelled).toBe(false);
    } finally {
      http.restore();
    }
  });
});

// ─── layout report ────────────────────────────────────────────────────────────

describe('layout report', () => {
  it('reports the placed box of each element inside the canvas, and that it fits', async () => {
    const { layoutEntries } = await renderScene(
      '#000000',
      [
        { type: 'text', text: 'HI', x: 2, y: 2 },
        { type: 'text', text: 'OK', x: 'right', y: 'bottom', style: { scale: 2 } },
        { type: 'icon', name: 'heart', x: 20, y: 2, w: 8, h: 8 },
        { type: 'icon', name: 'heart', x: 'center', y: 'center' },
        { type: 'rect', x: 30, y: 2, w: 6, h: 4, dx: 1, dy: 1 },
        { type: 'progress', x: 2, y: 22, w: 30, h: 4, value: 5, max: 10 },
        { type: 'sparkline', x: 2, y: 30, w: 20, h: 8, data: [1, 3, 2] },
        { type: 'bitmap', x: 40, y: 20, rows: ['111', '101'], palette: ['#000', '#fff'] },
        { type: 'image', source: redPngPath, x: 30, y: 40, w: 10, h: 10 },
        { type: 'sprite', path: redPngPath, cols: 4, rows: 2, x: 44, y: 44, scale: 2 },
      ],
      1,
      createMockContext(),
      64,
    );
    expect(layoutEntries.map(({ type, box, fits }) => ({ type, box, fits }))).toEqual([
      { type: 'text', box: { x: 2, y: 2, w: 9, h: 7 }, fits: true },
      { type: 'text', box: { x: 42, y: 50, w: 22, h: 14 }, fits: true },
      { type: 'icon', box: { x: 20, y: 2, w: 8, h: 8 }, fits: true },
      { type: 'icon', box: { x: 26, y: 26, w: 12, h: 12 }, fits: true },
      { type: 'rect', box: { x: 31, y: 3, w: 6, h: 4 }, fits: true },
      { type: 'progress', box: { x: 2, y: 22, w: 30, h: 4 }, fits: true },
      { type: 'sparkline', box: { x: 2, y: 30, w: 20, h: 8 }, fits: true },
      { type: 'bitmap', box: { x: 40, y: 20, w: 3, h: 2 }, fits: true },
      { type: 'image', box: { x: 30, y: 40, w: 10, h: 10 }, fits: true },
      { type: 'sprite', box: { x: 44, y: 44, w: 8, h: 4 }, fits: true },
    ]);
  });

  /** The layout entry one element reports on a 64px canvas. */
  function entryFor(el: SceneElement): LayoutEntry {
    const entries: LayoutEntry[] = [];
    renderElement(new Canvas(64), el, 0, 0, 1, emptyCache(), entries);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  const white = ['#000000', '#ffffff'];

  it.each<[string, SceneElement, LayoutEntry['box']]>([
    [
      'a circle spans its diameter and its center pixel',
      { type: 'circle', cx: 45, cy: 6, radius: 4 },
      { x: 41, y: 2, w: 9, h: 9 },
    ],
    [
      'a line spans both endpoints, moved by dx/dy',
      { type: 'line', x0: 2, y0: 14, x1: 20, y1: 18, dx: 1, dy: 2 },
      { x: 3, y: 16, w: 19, h: 5 },
    ],
    [
      'a horizontal line is one pixel tall',
      { type: 'line', x0: 20, y0: 5, x1: 2, y1: 5 },
      { x: 2, y: 5, w: 19, h: 1 },
    ],
    [
      'an image moves with dx/dy',
      { type: 'image', source: 'img', x: 4, y: 6, w: 10, h: 12, dx: -2, dy: 3 },
      { x: 2, y: 9, w: 10, h: 12 },
    ],
    [
      'a bitmap spans its widest row',
      { type: 'bitmap', x: 4, y: 4, rows: ['1', '111', '11'], palette: white },
      { x: 4, y: 4, w: 3, h: 3 },
    ],
    [
      'pixels span their points, moved by dx/dy',
      {
        type: 'pixels',
        data: [
          { x: 50, y: 50, color: 'red' },
          { x: 55, y: 52, color: 'red' },
        ],
        dx: 1,
      },
      { x: 51, y: 50, w: 6, h: 3 },
    ],
    [
      'pixels with no points have an empty box',
      { type: 'pixels', data: [] },
      { x: 0, y: 0, w: 0, h: 0 },
    ],
  ])('box: %s', (_label, el, box) => {
    expect(entryFor(el).box).toEqual(box);
  });

  it.each<[string, SceneElement, boolean]>([
    [
      'a 256×256 image at the origin',
      { type: 'image', source: 'img', x: 0, y: 0, w: 256, h: 256 },
      false,
    ],
    ['an image filling the canvas', { type: 'image', source: 'img', w: 64, h: 64 }, true],
    [
      'an image moved past the right edge by dx',
      { type: 'image', source: 'img', w: 64, h: 64, dx: 1 },
      false,
    ],
    ['a circle touching the right edge', { type: 'circle', cx: 58, cy: 32, radius: 5 }, true],
    [
      'a circle one pixel past the right edge',
      { type: 'circle', cx: 59, cy: 32, radius: 5 },
      false,
    ],
    ['a circle past the left edge', { type: 'circle', cx: 4, cy: 32, radius: 5 }, false],
    ['a line along the bottom row', { type: 'line', x0: 0, y0: 63, x1: 63, y1: 63 }, true],
    ['a line one pixel past the right edge', { type: 'line', x0: 0, y0: 0, x1: 64, y1: 0 }, false],
    [
      'a line moved past the bottom edge by dy',
      { type: 'line', x0: 0, y0: 63, x1: 9, y1: 63, dy: 1 },
      false,
    ],
    [
      'a progress bar past the right edge',
      { type: 'progress', x: 40, y: 0, w: 30, h: 4, value: 1, max: 2 },
      false,
    ],
    [
      'a sparkline past the bottom edge',
      { type: 'sparkline', x: 0, y: 60, w: 20, h: 8, data: [1, 2] },
      false,
    ],
    [
      'a bitmap whose widest row ends on the right edge',
      { type: 'bitmap', x: 59, y: 0, rows: ['1', '11111'], palette: white },
      true,
    ],
    [
      'a bitmap whose widest row crosses the right edge',
      { type: 'bitmap', x: 60, y: 0, rows: ['1', '11111'], palette: white },
      false,
    ],
    [
      'pixels in opposite corners',
      {
        type: 'pixels',
        data: [
          { x: 0, y: 0, color: 'red' },
          { x: 63, y: 63, color: 'red' },
        ],
      },
      true,
    ],
    ['a pixel off the canvas', { type: 'pixels', data: [{ x: 64, y: 10, color: 'red' }] }, false],
    ['a rect past the left edge', { type: 'rect', x: -1, y: 0, w: 4, h: 4 }, false],
    ['a text element past the top edge', { type: 'text', text: 'HI', x: 0, y: -1 }, false],
    ['an icon past the left edge', { type: 'icon', name: 'heart', x: -2, y: 0 }, false],
  ])('fits: %s', (_label, el, fits) => {
    expect(entryFor(el).fits).toBe(fits);
  });

  it('a sprite past the left edge does not fit', async () => {
    const { layoutEntries } = await renderScene(
      '#000000',
      [{ type: 'sprite', path: redPngPath, cols: 4, rows: 4, x: -1, y: 0 }],
      1,
      createMockContext(),
      64,
    );
    expect(layoutEntries).toMatchObject([{ type: 'sprite', box: { x: -1, y: 0 }, fits: false }]);
  });
});

// ─── renderFrame / renderScene ────────────────────────────────────────────────

describe('renderFrame', () => {
  it('returns a Canvas and layoutEntries', () => {
    const { canvas, layoutEntries } = renderFrame(
      0,
      1,
      '#001020',
      [{ type: 'text', text: 'OK', x: 0, y: 0 }],
      emptyCache(),
      64,
    );
    expect(canvas).toBeInstanceOf(Canvas);
    expect(Array.isArray(layoutEntries)).toBe(true);
    expect(layoutEntries.length).toBe(1);
  });
});

describe('renderScene', () => {
  it('static scene (frames:1) returns one canvas and layout entries from frame 0', async () => {
    const { frames, layoutEntries } = await renderScene(
      '#000000',
      [{ type: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#0000ff' }],
      1,
      createMockContext(),
      64,
    );
    expect(frames).toHaveLength(1);
    expect(layoutEntries).toHaveLength(1);
    expect(layoutEntries[0]!.type).toBe('rect');
  });

  it('multi-frame scene returns the correct frame count', async () => {
    const { frames, layoutEntries } = await renderScene(
      '#000000',
      [{ type: 'text', text: 'GO', x: 0, y: 0 }],
      3,
      createMockContext(),
      64,
    );
    expect(frames).toHaveLength(3);
    // Layout collected only from frame 0 — one entry per element
    expect(layoutEntries).toHaveLength(1);
  });

  describe('image elements fit the scene size', () => {
    it.each([16, 32] as const)(
      'size %i: the whole source fits, every quadrant in place',
      async (size) => {
        const { frames } = await renderScene(
          '#000000',
          [{ type: 'image', source: quadrantPngPath }],
          1,
          createMockContext(),
          size,
        );
        const frame = frames[0]!;
        expect(frame.width).toBe(size);
        const at = (fx: number, fy: number) => frame.getPixelRgba(size * fx, size * fy);
        expect(at(0.75, 0.75)).toEqual([...YELLOW, 255]); // the source's bottom-right quadrant
        expect(at(0.25, 0.75)).toEqual([...GREEN, 255]);
        expect(at(0.75, 0.25)).toEqual([...BLUE, 255]);
        expect(at(0.25, 0.25)).toEqual([...RED, 255]);
      },
    );

    it('size 16: an image placed with x/y and w/h lands at those scene coordinates', async () => {
      const { frames } = await renderScene(
        '#000000',
        [{ type: 'image', source: quadrantPngPath, x: 8, y: 8, w: 8, h: 8 }],
        1,
        createMockContext(),
        16,
      );
      const frame = frames[0]!;
      expect(frame.getPixelRgba(4, 4)).toEqual([0, 0, 0, 255]);
      expect(frame.getPixelRgba(9, 9)).toEqual([...RED, 255]);
      expect(frame.getPixelRgba(14, 14)).toEqual([...YELLOW, 255]);
    });

    it('two image elements sharing a source each keep their own placement and fit', async () => {
      const { frames, layoutEntries } = await renderScene(
        '#000000',
        [
          { type: 'image', source: quadrantPngPath, x: 0, y: 0, w: 8, h: 8 },
          { type: 'image', source: quadrantPngPath, x: 40, y: 40, w: 16, h: 16 },
        ],
        1,
        createMockContext(),
        64,
      );
      const frame = frames[0]!;
      // First element: 8×8 at the origin.
      expect(frame.getPixelRgba(1, 1)).toEqual([...RED, 255]);
      expect(frame.getPixelRgba(6, 6)).toEqual([...YELLOW, 255]);
      expect(frame.getPixelRgba(12, 12)).toEqual([0, 0, 0, 255]);
      // Second element: 16×16 at (40, 40), not a copy of the first.
      expect(frame.getPixelRgba(41, 41)).toEqual([...RED, 255]);
      expect(frame.getPixelRgba(54, 54)).toEqual([...YELLOW, 255]);
      expect(layoutEntries.map((e) => e.box)).toEqual([
        { x: 0, y: 0, w: 8, h: 8 },
        { x: 40, y: 40, w: 16, h: 16 },
      ]);
    });

    it('size 64: output is byte-identical to the pre-size-threading render', async () => {
      const { frames } = await renderScene(
        '#102030',
        [
          { type: 'image', source: quadrantPngPath },
          { type: 'image', source: redPngPath, x: 40, y: 4, w: 20, h: 12, kernel: 'lanczos3' },
        ],
        1,
        createMockContext(),
        64,
      );
      const hash = createHash('sha256').update(Buffer.from(frames[0]!.buffer)).digest('hex');
      expect(hash).toMatchInlineSnapshot(
        `"3702f1ebd066e5dc9646ef5222ef36a037e1308147ed95093b964a861eafb42c"`,
      );
    });
  });

  it('a fade-in image element ramps from background to image across frames', async () => {
    const { frames } = await renderScene(
      '#0000ff',
      [{ type: 'image', source: redPngPath, effect: { name: 'fade-in' } }],
      3,
      createMockContext(),
      64,
    );
    // fade-in compiles to opacity 0 → 50 → 100 over three frames.
    const [first, middle, last] = frames.map((f) => f.getPixelRgba(20, 20));
    expect(first).toEqual([...BLUE, 255]);
    expect(middle?.[0]).toBeGreaterThan(0);
    expect(middle?.[0]).toBeLessThan(255);
    expect(middle?.[2]).toBeGreaterThan(0);
    expect(middle?.[2]).toBeLessThan(255);
    expect(last).toEqual([...RED, 255]);
  });
});
