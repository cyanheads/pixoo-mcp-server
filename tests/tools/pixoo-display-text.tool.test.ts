/**
 * @fileoverview Tests for the pixoo_display_text tool.
 * @module tests/tools/pixoo-display-text.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

// A fake pushFrame that resolves immediately without hitting a device.
const fakeDeviceState = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

describe('pixooDisplayText', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  // Helper: stub pushFrame to avoid real network I/O
  async function stubPush() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushFrame').mockResolvedValue(fakeDeviceState);
  }

  it('happy path: renders text with push:false — returns layout[] and pushed:false', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({
      text: 'Hello',
      push: false,
    });
    const result = await pixooDisplayText.handler(input, ctx);

    expect(result.pushed).toBe(false);
    expect(Array.isArray(result.layout)).toBe(true);
    expect(result.layout.length).toBeGreaterThan(0);
    expect(result.deviceState).toBeUndefined();
  });

  it('layout entry has required fields', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({ text: 'Hi', push: false });
    const result = await pixooDisplayText.handler(input, ctx);

    const entry = result.layout[0]!;
    expect(entry).toHaveProperty('element');
    expect(entry).toHaveProperty('type');
    expect(entry).toHaveProperty('box');
    expect(entry.box).toHaveProperty('x');
    expect(entry.box).toHaveProperty('y');
    expect(entry.box).toHaveProperty('w');
    expect(entry.box).toHaveProperty('h');
    expect(entry).toHaveProperty('fits');
    expect(entry).toHaveProperty('action');
  });

  it('with push:true calls pushFrame and returns deviceState', async () => {
    await stubPush();
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({ text: 'Hello', push: true });
    const result = await pixooDisplayText.handler(input, ctx);

    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('applies theme background when theme is set', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({
      text: 'Theme test',
      theme: 'midnight',
      push: false,
    });
    // Just confirm no throw and layout is populated
    const result = await pixooDisplayText.handler(input, ctx);
    expect(result.layout.length).toBeGreaterThan(0);
  });

  it('accepts array of text lines and renders each as a layout entry', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({
      text: ['Line 1', 'Line 2'],
      push: false,
    });
    const result = await pixooDisplayText.handler(input, ctx);
    // Multi-line: one layout entry per line
    expect(result.layout.length).toBe(2);
  });

  it('accepts custom gradient background', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({
      text: 'Gradient',
      background: { gradient: { type: 'v', from: '#001020', to: '#000000' } },
      push: false,
    });
    await expect(pixooDisplayText.handler(input, ctx)).resolves.toBeDefined();
  });

  it('accepts style with palette, shadow, outline, scale', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({
      text: 'Styled',
      style: { palette: 'ember', shadow: true, outline: true, scale: 2 },
      push: false,
    });
    const result = await pixooDisplayText.handler(input, ctx);
    expect(result.layout[0]?.scale).toBe(2);
  });

  it('no_device_configured error when push:true and no PIXOO_IP', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({ text: 'Hello', push: true });
    await expect(pixooDisplayText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('outputFiles is absent when PIXOO_OUTPUT_DIR is not set', async () => {
    const ctx = createMockContext();
    const input = pixooDisplayText.input.parse({ text: 'No output dir', push: false });
    const result = await pixooDisplayText.handler(input, ctx);
    expect(result.outputFiles).toBeUndefined();
  });

  it('format() returns a text block containing pushed status', () => {
    const output = {
      pushed: false,
      layout: [
        {
          element: 0 as const,
          type: 'text',
          box: { x: 27, y: 28, w: 10, h: 7 },
          fits: true,
          action: 'none' as const,
          font: 'standard' as const,
          scale: 1,
        },
      ],
    };
    const blocks = pixooDisplayText.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pushed');
    expect(text).toContain('Layout');
  });

  it('format() includes layout entry coordinates', () => {
    const output = {
      pushed: true,
      layout: [
        {
          element: 0 as const,
          type: 'text',
          box: { x: 10, y: 5, w: 20, h: 7 },
          fits: true,
          action: 'none' as const,
          font: 'standard' as const,
          scale: 1,
        },
      ],
      deviceState: fakeDeviceState,
    };
    const blocks = pixooDisplayText.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10');
    expect(text).toContain('5');
  });

  it('format() mentions outputFiles when present', () => {
    const output = {
      pushed: false,
      layout: [],
      outputFiles: ['/tmp/test.png'],
    };
    const blocks = pixooDisplayText.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Saved');
    expect(text).toContain('/tmp/test.png');
  });

  it('scrolling layout preview is non-blank (contains non-background pixels)', async () => {
    // A very long text forces scrolling overflow.
    // Before the fix, frame 0 renders at x=64 (off-canvas) → solid black preview.
    // After the fix, the preview re-renders at x=0 → text is visible.
    const { Canvas: CVS } = await import('@cyanheads/pixoo-toolkit');
    const { drawStyledText } = await import('@/renderer/text-engine.js');

    const ctx = createMockContext();
    const longText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const input = pixooDisplayText.input.parse({ text: longText, push: false });
    const result = await pixooDisplayText.handler(input, ctx);

    // Confirm scrolling was triggered
    expect(result.layout[0]?.action).toBe('scrolling');
    expect(result.previewData).toBeDefined();

    // Build a reference canvas rendered at x=0 to confirm text pixels exist there
    const refCanvas = new CVS(64);
    drawStyledText(refCanvas, longText, 0, 28, {});
    const refHasPixels = Array.from({ length: 64 }, (_, x) => refCanvas.getPixelRgba(x, 28)).some(
      ([r, g, b]) => r > 0 || g > 0 || b > 0,
    );
    // Sanity: text at x=0 should light pixels on the reference canvas
    expect(refHasPixels).toBe(true);

    // The actual preview PNG must be larger than a trivially-blank PNG (which compresses to <200 bytes)
    const pngBytes = Buffer.from(result.previewData!, 'base64');
    expect(pngBytes.length).toBeGreaterThan(500);
  });

  it('invalid_color error has data.reason === "invalid_color" and names a color', async () => {
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({
      text: 'Hello',
      style: { color: 'invalidcolorname' },
      push: false,
    });
    const err = await pixooDisplayText.handler(input, ctx).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.data?.reason).toBe('invalid_color');
    // Message should contain at least one known color name
    expect(err.message).toMatch(/white|black|red|green|blue/);
  });
});
