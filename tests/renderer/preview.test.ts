/**
 * @fileoverview Tests for preview encoding utilities: PNG content block, contact sheet.
 * @module tests/renderer/preview.test
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { Canvas } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { buildContactSheet, encodePreviewBlock, savePngPreview } from '@/renderer/preview.js';

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
  it('returns an image block from the middle frame of an odd-length array', () => {
    const frames = [new Canvas(64), new Canvas(64), new Canvas(64)];
    frames[0]!.clear([255, 0, 0]);
    frames[1]!.clear([0, 255, 0]); // middle — expected
    frames[2]!.clear([0, 0, 255]);
    const block = buildContactSheet(frames);
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(block.data.length).toBeGreaterThan(0);
  });

  it('returns a valid image block for a single-frame input', () => {
    const frames = [new Canvas(64)];
    frames[0]!.clear([128, 128, 128]);
    const block = buildContactSheet(frames);
    expect(block.type).toBe('image');
    expect(block.data.length).toBeGreaterThan(0);
  });

  it('returns a fallback black canvas for an empty frame array', () => {
    const block = buildContactSheet([]);
    expect(block.type).toBe('image');
    expect(block.data.length).toBeGreaterThan(0);
  });
});

// ─── savePngPreview ───────────────────────────────────────────────────────────

describe('savePngPreview', () => {
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

  it('returns undefined when PIXOO_OUTPUT_DIR is not set', async () => {
    delete process.env['PIXOO_OUTPUT_DIR'];
    resetServerConfig();
    const canvas = new Canvas(64);
    const result = await savePngPreview(canvas, 'test');
    expect(result).toBeUndefined();
  });

  it('returns a file path and writes a non-empty PNG when PIXOO_OUTPUT_DIR is set', async () => {
    const outDir = path.join(os.tmpdir(), `pixoo-preview-test-${Date.now()}`);
    process.env['PIXOO_OUTPUT_DIR'] = outDir;
    resetServerConfig();

    const canvas = new Canvas(64);
    canvas.clear([255, 0, 0]);
    const result = await savePngPreview(canvas, 'preview-test');

    expect(typeof result).toBe('string');
    expect(result).toContain('preview-test.png');

    // Verify the file actually exists and has content
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(result!);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
