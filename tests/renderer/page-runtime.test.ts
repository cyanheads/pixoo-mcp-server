/**
 * @fileoverview The `pixoo` page runtime, run as the built bundle a page receives: built by
 * `scripts/build-page-runtime.ts` into this file's temp dir, then evaluated in a `node:vm`
 * context standing in for the page, with no browser. Its text and icons are replayed from a
 * recording 2D context onto a black panel and compared pixel for pixel with the server's
 * own renderers: `drawStyledText`, and a scene `text` or `icon` element on `#000000`. A
 * project copy whose entry reaches `sharp` proves the build refuses to bundle it.
 * @module tests/renderer/page-runtime.test
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { Canvas, measureText } from '@cyanheads/pixoo-toolkit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderFrame, type SceneElement } from '@/renderer/scene-renderer.js';
import { drawStyledText, FONT_FACES, type TextStyle } from '@/renderer/text-engine.js';
import { PALETTES } from '@/renderer/themes.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

type Box = { x: number; y: number; w: number; h: number };

/** The page-facing surface of `globalThis.pixoo`, as the bundle assigns it. */
interface PixooRuntime {
  context(): unknown;
  icon(ctx: unknown, name: string, x?: unknown, y?: unknown, opts?: object): Box;
  palettes: Record<string, { from: string; to: string }>;
  size: number;
  text(ctx: unknown, text: string, x?: unknown, y?: unknown, opts?: object): Box;
}

interface FillRect {
  h: number;
  style: string;
  w: number;
  x: number;
  y: number;
}

let bundle: string;

beforeAll(async () => {
  const outdir = os.tmpdir();
  const build = spawnSync('bun', ['run', 'scripts/build-page-runtime.ts', outdir], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  expect(build.status, build.stderr).toBe(0);
  bundle = await readFile(path.join(outdir, 'page-runtime.js'), 'utf8');
}, 60_000);

/** Evaluate the bundle in a fresh page-like global holding `globals`; returns its `pixoo`. */
function loadRuntime(globals: Record<string, unknown> = { __PIXOO_SIZE__: 64 }): PixooRuntime {
  const page = vm.createContext({ ...globals });
  vm.runInContext(bundle, page);
  return page['pixoo'] as PixooRuntime;
}

/** A 2D context that records every `fillRect` with the `fillStyle` it drew in, and each state op. */
function recordingContext() {
  const rects: FillRect[] = [];
  const ops: string[] = [];
  const ctx = {
    fillStyle: '#000000' as string,
    save() {
      ops.push('save');
    },
    restore() {
      ops.push('restore');
    },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push('fillRect');
      rects.push({ x, y, w, h, style: ctx.fillStyle });
    },
  };
  return { ctx, rects, ops };
}

/**
 * Replay recorded rects onto a black panel. Every rect must be one whole panel pixel in an
 * opaque `rgba()` color, and no pixel may be painted twice.
 */
function replayOnBlack(rects: FillRect[], size = 64): Canvas {
  const canvas = new Canvas(size).clear('#000000');
  const seen = new Set<string>();
  for (const { x, y, w, h, style } of rects) {
    expect({ w, h, integral: Number.isInteger(x) && Number.isInteger(y) }).toEqual({
      w: 1,
      h: 1,
      integral: true,
    });
    const key = `${x},${y}`;
    expect(seen.has(key), `pixel ${key} painted twice`).toBe(false);
    seen.add(key);
    const match = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(style);
    expect(match, style).not.toBeNull();
    const [, r, g, b, a] = match as RegExpExecArray;
    expect(Number(a)).toBe(1);
    canvas.setPixel(x, y, [Number(r), Number(g), Number(b)]);
  }
  return canvas;
}

/** A scene element alone on `#000000`, drawn by the scene renderer. */
function sceneOnBlack(element: SceneElement, size: 16 | 32 | 64 = 64): Canvas {
  return renderFrame(0, 1, '#000000', [element], { images: new Map(), sprites: new Map() }, size)
    .canvas;
}

/** Canvases compared as raw RGBA, so a mismatch reports the first differing byte. */
function expectSamePixels(actual: Canvas, expected: Canvas): void {
  expect(actual.width).toBe(expected.width);
  expect(Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
}

describe('pixoo page runtime', () => {
  describe('the bundle build', () => {
    it('fails, naming the import, when sharp becomes reachable from the entry', async () => {
      // A project copy whose runtime entry reaches sharp, built by the real build script.
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'runtime-canary-')));
      await mkdir(path.join(root, 'scripts'));
      await mkdir(path.join(root, 'src', 'renderer'), { recursive: true });
      for (const script of ['build-page-runtime.ts', 'find-node-imports.ts']) {
        await copyFile(
          path.join(PROJECT_ROOT, 'scripts', script),
          path.join(root, 'scripts', script),
        );
      }
      await symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(root, 'node_modules'));
      await writeFile(
        path.join(root, 'tsconfig.page-runtime.json'),
        JSON.stringify({
          compilerOptions: { module: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] },
          files: ['src/renderer/page-runtime.ts'],
        }),
      );
      await writeFile(
        path.join(root, 'src', 'renderer', 'page-runtime.ts'),
        "import sharp = require('sharp');\nexport const reach = sharp;\n",
      );

      const build = spawnSync('bun', ['run', 'scripts/build-page-runtime.ts'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(build.stderr).toContain('src/renderer/page-runtime.ts imports sharp');
      expect(build.status).toBe(1);
      expect(existsSync(path.join(root, 'dist'))).toBe(false);
    });
  });

  describe('loading, size, and palettes', () => {
    it('reads the panel size the tool sets before the bundle runs', () => {
      expect(loadRuntime({ __PIXOO_SIZE__: 64 }).size).toBe(64);
      expect(loadRuntime({ __PIXOO_SIZE__: 32 }).size).toBe(32);
      expect(loadRuntime({ __PIXOO_SIZE__: 16 }).size).toBe(16);
    });

    it('refuses to load without a panel size of 16, 32, or 64, naming what it got', () => {
      expect(() => loadRuntime({})).toThrow(
        /__PIXOO_SIZE__ must be 16, 32, or 64 \(got undefined\)/,
      );
      expect(() => loadRuntime({ __PIXOO_SIZE__: 48 })).toThrow(/\(got 48\)/);
    });

    it('adds pixoo and nothing else to the page global', () => {
      const page = vm.createContext({ __PIXOO_SIZE__: 64 });
      vm.runInContext(bundle, page);
      expect(Object.keys(page).sort()).toEqual(['__PIXOO_SIZE__', 'pixoo']);
    });

    it('exposes all 7 palettes as their gradient stops', () => {
      const { palettes } = loadRuntime();
      expect(Object.keys(palettes)).toHaveLength(7);
      expect(JSON.parse(JSON.stringify(palettes))).toEqual(PALETTES);
    });
  });

  describe('text', () => {
    it('draws HELLO center/4 in ember, scale 2, with shadow, pixel for pixel as drawStyledText', () => {
      const pixoo = loadRuntime();
      const { ctx, rects, ops } = recordingContext();
      const box = pixoo.text(ctx, 'HELLO', 'center', 4, {
        palette: 'ember',
        scale: 2,
        shadow: true,
      });

      const style: TextStyle = { palette: 'ember', scale: 2, shadow: true };
      const w = measureText('HELLO', { font: FONT_FACES.standard, scale: 2 });
      const expected = new Canvas(64).clear('#000000');
      const expectedBox = drawStyledText(expected, 'HELLO', Math.floor((64 - w) / 2), 4, style);

      expect(box).toEqual(expectedBox);
      expect(box).toEqual({ x: 3, y: 4, w: 58, h: 14 });
      expectSamePixels(replayOnBlack(rects), expected);
      // One fillRect per lit pixel, inside save/restore so the page's fillStyle survives.
      expect(ops[0]).toBe('save');
      expect(ops.at(-1)).toBe('restore');
    });

    it.each<[string, SceneElement & { type: 'text' }]>([
      [
        'compact, color, outline',
        {
          type: 'text',
          text: 'Pixoo 64',
          font: 'compact',
          x: 2,
          y: 'bottom',
          color: '#44ccff',
          style: { outline: true },
        },
      ],
      [
        'numerals, color',
        {
          type: 'text',
          text: '12:45',
          font: 'numerals',
          x: 'center',
          y: 'center',
          color: '#ff8800',
        },
      ],
    ])('draws %s as the scene text element does on #000000', (_name, element) => {
      const pixoo = loadRuntime();
      const { ctx, rects } = recordingContext();
      pixoo.text(ctx, element.text, element.x, element.y, {
        ...element.style,
        color: element.color,
        font: element.font,
      });
      expectSamePixels(replayOnBlack(rects), sceneOnBlack(element));
    });

    it('places text against the panel size it was given', () => {
      const pixoo = loadRuntime({ __PIXOO_SIZE__: 32 });
      const { ctx, rects } = recordingContext();
      const box = pixoo.text(ctx, 'HI', 'right', 'bottom', { color: 'orange' });
      const element: SceneElement = {
        type: 'text',
        text: 'HI',
        x: 'right',
        y: 'bottom',
        color: 'orange',
      };
      expect(box).toEqual({ x: 23, y: 25, w: 9, h: 7 });
      expectSamePixels(replayOnBlack(rects, 32), sceneOnBlack(element, 32));
    });

    it('defaults to the standard font in white at 0,0', () => {
      const pixoo = loadRuntime();
      const { ctx, rects } = recordingContext();
      expect(pixoo.text(ctx, 'OK')).toEqual({ x: 0, y: 0, w: 11, h: 7 });
      expectSamePixels(replayOnBlack(rects), sceneOnBlack({ type: 'text', text: 'OK' }));
    });
  });

  describe('icon', () => {
    it.each<[string, SceneElement & { type: 'icon' }]>([
      ['color', { type: 'icon', name: 'check-circle', x: 50, y: 2, color: 'green' }],
      ['palette', { type: 'icon', name: 'check-circle', x: 50, y: 2, palette: 'ember' }],
      ['palette, 16px', { type: 'icon', name: 'heart', x: 4, y: 40, w: 16, h: 16, palette: 'ice' }],
      ['defaults (12px, white, 0,0)', { type: 'icon', name: 'sun' }],
      [
        'semantic placement',
        { type: 'icon', name: 'heart', x: 'center', y: 'bottom', color: 'red' },
      ],
    ])('draws the %s case as the scene icon element does on #000000', (_name, element) => {
      const pixoo = loadRuntime();
      const { ctx, rects } = recordingContext();
      const { name, x, y, w, h, color, palette } = element;
      const box = pixoo.icon(ctx, name as string, x, y, { w, h, color, palette });
      expect(box).toMatchObject({ w: w ?? 12, h: h ?? 12 });
      expect(rects.length).toBeGreaterThan(0);
      expectSamePixels(replayOnBlack(rects), sceneOnBlack(element));
    });
  });

  describe('lookups and page errors', () => {
    /** Runs `draw`, expecting it to throw matching `message` before painting anything. */
    function expectThrowBeforeDrawing(
      draw: (pixoo: PixooRuntime, ctx: unknown) => void,
      message: RegExp,
    ) {
      const pixoo = loadRuntime();
      const { ctx, rects } = recordingContext();
      expect(() => draw(pixoo, ctx)).toThrow(message);
      expect(rects).toEqual([]);
    }

    it('an unknown palette throws naming it; lookups answer only for own keys', () => {
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.text(ctx, 'HI', 0, 0, { palette: 'constructor' }),
        /Unknown palette "constructor"/,
      );
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.icon(ctx, 'heart', 0, 0, { palette: 'constructor' }),
        /Unknown palette "constructor"/,
      );
    });

    it('an unknown icon throws naming it; lookups answer only for own keys', () => {
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.icon(ctx, 'toString'),
        /Unknown icon "toString"/,
      );
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.icon(ctx, 'nope-icon'),
        /Unknown icon "nope-icon"/,
      );
    });

    it('an unknown color throws naming it, even under a palette', () => {
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.text(ctx, 'HI', 0, 0, { color: 'nope' }),
        /Unknown color: "nope"/,
      );
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.text(ctx, 'HI', 0, 0, { color: 'nope', palette: 'ember' }),
        /Unknown color: "nope"/,
      );
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.icon(ctx, 'heart', 0, 0, { color: 'nope' }),
        /Unknown color: "nope"/,
      );
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.icon(ctx, 'heart', 0, 0, { color: 'nope', palette: 'ember' }),
        /Unknown color: "nope"/,
      );
    });

    it('an unknown font throws naming it', () => {
      expectThrowBeforeDrawing(
        (pixoo, ctx) => pixoo.text(ctx, 'HI', 0, 0, { font: 'toString' }),
        /Unknown font "toString"/,
      );
    });

    it('numerals text holding a character that face lacks throws naming only that character', () => {
      const pixoo = loadRuntime();
      const { ctx, rects } = recordingContext();
      let message = '';
      try {
        pixoo.text(ctx, '12A', 0, 0, { font: 'numerals' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(
        'Characters not in the numerals font: "A". It draws 0–9, space, and : . - + / % ° ? only.',
      );
      expect(rects).toEqual([]);
    });
  });

  describe('context()', () => {
    /** A page with a `devicePixelRatio` and a document that hands out recorded canvases. */
    function fakePage(devicePixelRatio: number) {
      const appended: unknown[] = [];
      const calls: string[] = [];
      const context2d = {
        imageSmoothingEnabled: true,
        setTransform(...args: number[]) {
          calls.push(`setTransform(${args.join(',')})`);
        },
      };
      const document = {
        documentElement: { append: (el: unknown) => appended.push(el) },
        createElement(tag: string) {
          calls.push(`createElement(${tag})`);
          return {
            width: 300,
            height: 150,
            style: { cssText: '' },
            getContext(type: string) {
              calls.push(`getContext(${type})`);
              return context2d;
            },
          };
        },
      };
      return {
        globals: { __PIXOO_SIZE__: 64, devicePixelRatio, document },
        appended,
        calls,
        context2d,
      };
    }

    it('returns the 2D context of one transparent panel-size canvas fixed over the page, scaled by devicePixelRatio with smoothing off', () => {
      const page = fakePage(4);
      const pixoo = loadRuntime(page.globals);
      const ctx = pixoo.context();

      expect(ctx).toBe(page.context2d);
      expect(page.context2d.imageSmoothingEnabled).toBe(false);
      expect(page.appended).toHaveLength(1);
      const canvas = page.appended[0] as {
        width: number;
        height: number;
        style: { cssText: string };
      };
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 256, height: 256 });
      expect(canvas.style.cssText).toContain('position:fixed');
      expect(canvas.style.cssText).toContain('width:64px');
      expect(canvas.style.cssText).toContain('height:64px');
      expect(page.calls).toEqual([
        'createElement(canvas)',
        'getContext(2d)',
        'setTransform(4,0,0,4,0,0)',
      ]);
    });

    it('hands back the same context on every call', () => {
      const page = fakePage(1);
      const pixoo = loadRuntime(page.globals);
      expect(pixoo.context()).toBe(pixoo.context());
      expect(page.appended).toHaveLength(1);
    });
  });
});
