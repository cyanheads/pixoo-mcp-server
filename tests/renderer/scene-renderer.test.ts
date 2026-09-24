/**
 * @fileoverview Tests for scene-renderer: element rendering, background application, layout entries.
 * @module tests/renderer/scene-renderer.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Canvas, savePng } from '@cyanheads/pixoo-toolkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AssetCache,
  applyBackground,
  type ImageElement,
  type ProgressElement,
  preloadAssets,
  type RectElement,
  renderElement,
  renderFrame,
  renderScene,
  type SpriteElement,
  type TextElement,
} from '@/renderer/scene-renderer.js';
import type { LayoutEntry } from '@/renderer/text-engine.js';

/** Empty asset cache — no images or sprites preloaded. */
function emptyCache(): AssetCache {
  return { images: new Map(), sprites: new Map() };
}

/** Asset cache holding one preloaded image under `source`. */
function imageCache(source: string, image: Canvas): AssetCache {
  return { images: new Map([[source, image]]), sprites: new Map() };
}

const BLUE = [0, 0, 255] as const;
const RED = [255, 0, 0] as const;

/** Directory for on-disk image and sprite fixtures, removed after the suite. */
let fixtureDir: string;
/** A 64×64 opaque red PNG. */
let redPngPath: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-scene-renderer-'));
  const red = new Canvas(64);
  red.clear([...RED]);
  redPngPath = path.join(fixtureDir, 'red.png');
  await savePng(red, redPngPath);
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
    renderElement(canvas, el, 0, 0, 1, imageCache('img', image), []);

    expect(Buffer.from(canvas.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
  });

  it('opacity 30 blends the image with the layer beneath it', () => {
    const canvas = new Canvas(64);
    canvas.clear([...BLUE]);
    const el: ImageElement = { type: 'image', source: 'img', opacity: 30 };
    renderElement(canvas, el, 0, 0, 1, imageCache('img', halfImage()), []);

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
    renderElement(canvas, el, 0, 0, 1, imageCache('img', halfImage()), []);
    expect(Buffer.from(canvas.buffer).equals(before)).toBe(true);
  });
});

// ─── preloadAssets — local image and sprite paths ─────────────────────────────

describe('preloadAssets — local paths', () => {
  it('loads a local image file into the cache', async () => {
    const cache = await preloadAssets([{ type: 'image', source: redPngPath }], createMockContext());
    const image = cache.images.get(redPngPath);
    expect(image).toBeInstanceOf(Canvas);
    expect(image?.getPixelRgba(10, 10)).toEqual([...RED, 255]);
  });

  it('loads a local sprite sheet into the cache', async () => {
    const cache = await preloadAssets(
      [{ type: 'sprite', path: redPngPath, cols: 4, rows: 4 }],
      createMockContext(),
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
    await expect(preloadAssets([build(missing)], createMockContext())).rejects.toMatchObject({
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
      ),
    ).rejects.toMatchObject({ data: { reason: 'asset_not_found', path: missing } });
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
