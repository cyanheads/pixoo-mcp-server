/**
 * @fileoverview Tests for preview encoding utilities: PNG content block, contact sheet,
 * and the PIXOO_OUTPUT_DIR / temp-dir preview files.
 * @module tests/renderer/preview.test
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Canvas, type RGB } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  autoSavePreview,
  buildContactSheet,
  encodePreviewBlock,
  saveGifPreview,
  savePngPreview,
  saveTempPreview,
} from '@/renderer/preview.js';

// ─── encodePreviewBlock ───────────────────────────────────────────────────────

describe('encodePreviewBlock', () => {
  it('returns type:"image", mimeType:"image/png", and non-empty base64 data', () => {
    const canvas = new Canvas(64);
    canvas.clear([0, 128, 255]);
    const block = encodePreviewBlock(canvas);

    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(typeof block.data).toBe('string');
    expect(block.data.length).toBeGreaterThan(0);
  });

  it('encoded data is valid base64 (decodes to a non-empty buffer)', () => {
    const canvas = new Canvas(64);
    const block = encodePreviewBlock(canvas);
    const decoded = Buffer.from(block.data, 'base64');
    expect(decoded.byteLength).toBeGreaterThan(0);
  });

  it('upscaled output PNG has larger dimensions than the canvas (8× scale → ≥512px)', () => {
    const canvas = new Canvas(64);
    const block = encodePreviewBlock(canvas);
    // PNG dimensions are embedded in bytes 16–24 of a PNG file
    const buf = Buffer.from(block.data, 'base64');
    // PNG signature is 8 bytes, IHDR chunk starts at offset 8 (4 len + 4 type + data)
    // Width is at bytes 16–19, height at 20–23
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    // 64 × 8 = 512
    expect(width).toBe(512);
    expect(height).toBe(512);
  });
});

// ─── buildContactSheet ────────────────────────────────────────────────────────

describe('buildContactSheet', () => {
  /** Frames cleared to distinct solid colors, in order. */
  function solidFrames(colors: RGB[], size: 16 | 32 | 64 = 64): Canvas[] {
    return colors.map((color) => new Canvas(size).clear(color));
  }

  /** Decode the sheet and read the pixel at the center of grid cell (col, row). */
  async function decodeGrid(block: { data: string }, cols: number, rows: number) {
    const { data, info } = await sharp(Buffer.from(block.data, 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cell = (col: number, row: number): RGB => {
      const x = Math.floor(((col + 0.5) * info.width) / cols);
      const y = Math.floor(((row + 0.5) * info.height) / rows);
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    return { width: info.width, height: info.height, cell };
  }

  it('tiles every frame, in order, into a ceil(sqrt(n)) grid', async () => {
    const colors: RGB[] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    const block = await buildContactSheet(solidFrames(colors));
    expect(block).toMatchObject({ type: 'image', mimeType: 'image/png' });

    const grid = await decodeGrid(block, 2, 2);
    expect(grid.width).toBe(grid.height);
    expect([grid.cell(0, 0), grid.cell(1, 0), grid.cell(0, 1)]).toEqual(colors);
    // The fourth cell of the 2×2 grid holds no frame.
    expect(colors).not.toContainEqual(grid.cell(1, 1));
  });

  it('differs from every single constituent frame', async () => {
    const frames = solidFrames([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
    const block = await buildContactSheet(frames);
    for (const frame of frames) expect(block.data).not.toBe(encodePreviewBlock(frame).data);
    const width = Buffer.from(block.data, 'base64').readUInt32BE(16);
    expect(width).not.toBe(512);
  });

  it('lays 40 frames out as a 7×6 grid within the 512px budget', async () => {
    const colors = Array.from({ length: 40 }, (_, i): RGB => [i * 6, 250 - i * 6, 100]);
    const grid = await decodeGrid(await buildContactSheet(solidFrames(colors)), 7, 6);
    expect(grid.width).toBeLessThanOrEqual(512);
    expect(grid.height).toBeLessThan(grid.width);
    for (let i = 0; i < 40; i++) {
      expect(grid.cell(i % 7, Math.floor(i / 7)), `frame ${i}`).toEqual(colors[i]);
    }
    expect(colors).not.toContainEqual(grid.cell(5, 5));
    expect(colors).not.toContainEqual(grid.cell(6, 5));
  });

  it('scales a small display up toward the 512px budget', async () => {
    const colors: RGB[] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    const grid = await decodeGrid(await buildContactSheet(solidFrames(colors, 16)), 2, 2);
    expect(grid.width).toBeGreaterThan(256);
    expect(grid.width).toBeLessThanOrEqual(512);
    expect([grid.cell(0, 0), grid.cell(1, 0), grid.cell(0, 1), grid.cell(1, 1)]).toEqual(colors);
  });

  it('a single frame previews exactly as encodePreviewBlock does', async () => {
    const [frame] = solidFrames([[128, 128, 128]]);
    expect(await buildContactSheet([frame!])).toEqual(encodePreviewBlock(frame!));
  });

  it('returns a fallback black canvas for an empty frame array', async () => {
    const block = await buildContactSheet([]);
    expect(block.type).toBe('image');
    expect(block.data.length).toBeGreaterThan(0);
  });
});

// ─── autoSavePreview / saveTempPreview ────────────────────────────────────────

describe('saving previews', () => {
  const writePng = (canvas: Canvas) => (dir: string) => savePngPreview(canvas, dir, 'preview-test');

  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
  });

  afterEach(() => {
    delete process.env['PIXOO_OUTPUT_DIR'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('autoSavePreview writes nothing when PIXOO_OUTPUT_DIR is not set', async () => {
    delete process.env['PIXOO_OUTPUT_DIR'];
    resetServerConfig();
    expect(await autoSavePreview(writePng(new Canvas(64)))).toEqual([]);
  });

  it('autoSavePreview writes a non-empty PNG into PIXOO_OUTPUT_DIR', async () => {
    const outDir = path.join(os.tmpdir(), `pixoo-preview-test-${Date.now()}`);
    process.env['PIXOO_OUTPUT_DIR'] = outDir;
    resetServerConfig();

    const saved = await autoSavePreview(writePng(new Canvas(64).clear([255, 0, 0])));

    expect(saved).toEqual([path.join(outDir, 'preview-test.png')]);
    const bytes = await readFile(saved[0]!);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('saveTempPreview writes into a fresh directory under the OS temp dir', async () => {
    const write = writePng(new Canvas(64).clear([0, 255, 0]));
    const first = await saveTempPreview(write);
    const second = await saveTempPreview(write);

    expect(first.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(first)).toBe('preview-test.png');
    expect(path.dirname(first)).not.toBe(path.dirname(second));
    expect((await readFile(first)).subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('saveGifPreview writes an animated GIF', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pixoo-gif-test-'));
    const frames = [new Canvas(64).clear([255, 0, 0]), new Canvas(64).clear([0, 0, 255])];
    const saved = await saveGifPreview(frames, 150, dir, 'anim');
    expect(saved).toBe(path.join(dir, 'anim.gif'));
    expect((await readFile(saved)).subarray(0, 4).toString('latin1')).toBe('GIF8');
  });
});
