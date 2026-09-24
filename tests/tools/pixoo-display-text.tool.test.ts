/**
 * @fileoverview Tests for the pixoo_display_text tool.
 * @module tests/tools/pixoo-display-text.tool.test
 */

import { createHash } from 'node:crypto';
import type { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import type { Canvas } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import {
  expectDeviceFailure,
  failDevicePush,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';

type DisplayInput = z.input<typeof pixooDisplayText.input>;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

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
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
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
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
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
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({ text: 'Hello', push: true });
    const result = await pixooDisplayText.handler(input, ctx);

    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('applies theme background when theme is set', async () => {
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
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
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({
      text: ['Line 1', 'Line 2'],
      push: false,
    });
    const result = await pixooDisplayText.handler(input, ctx);
    // Multi-line: one layout entry per line
    expect(result.layout.length).toBe(2);
  });

  it('accepts custom gradient background', async () => {
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({
      text: 'Gradient',
      background: { gradient: { type: 'v', from: '#001020', to: '#000000' } },
      push: false,
    });
    await expect(pixooDisplayText.handler(input, ctx)).resolves.toBeDefined();
  });

  it('accepts style with palette, shadow, outline, scale', async () => {
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
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
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({ text: 'No output dir', push: false });
    const result = await pixooDisplayText.handler(input, ctx);
    expect(result.outputFiles).toBeUndefined();
  });

  it('format() returns a text block containing pushed status and frame count', () => {
    const output = {
      pushed: false,
      frames: 20,
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
    expect(text).toContain('**Pushed:** No | **Frames:** 20');
    expect(text).toContain('Layout');
  });

  it('format() includes layout entry coordinates', () => {
    const output = {
      pushed: true,
      frames: 1,
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
      frames: 1,
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

    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const longText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const input = pixooDisplayText.input.parse({ text: longText, push: false });
    const result = await pixooDisplayText.handler(input, ctx);

    // Confirm scrolling was triggered
    expect(result.layout[0]?.action).toBe('scrolling');
    const [preview] = getContentBlocks(ctx);
    expect(preview).toMatchObject({ type: 'image', mimeType: 'image/png' });

    // Build a reference canvas rendered at x=0 to confirm text pixels exist there
    const refCanvas = new CVS(64);
    drawStyledText(refCanvas, longText, 0, 28, {});
    const refHasPixels = Array.from({ length: 64 }, (_, x) => refCanvas.getPixelRgba(x, 28)).some(
      ([r, g, b]) => r > 0 || g > 0 || b > 0,
    );
    // Sanity: text at x=0 should light pixels on the reference canvas
    expect(refHasPixels).toBe(true);

    // The actual preview PNG must be larger than a trivially-blank PNG (which compresses to <200 bytes)
    const pngBytes = Buffer.from((preview as { data: string }).data, 'base64');
    expect(pngBytes.length).toBeGreaterThan(500);
  });

  it('invalid_color error has data.reason === "invalid_color" and names a color', async () => {
    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const input = pixooDisplayText.input.parse({
      text: 'Hello',
      style: { color: 'invalidcolorname' },
      push: false,
    });
    // Message should contain at least one known color name
    await expect(Promise.resolve(pixooDisplayText.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_color' },
      message: expect.stringMatching(/white|black|red|green|blue/),
    });
  });

  describe('device failures on push reach both surfaces through the contract', () => {
    it('device_unreachable carries retryable: true', async () => {
      failDevicePush({ ok: false, kind: 'network', message: 'connect EHOSTUNREACH' });
      const result = await runToolContract(pixooDisplayText, { text: 'hi', push: true });
      expectDeviceFailure(result, pixooDisplayText.errors, 'device_unreachable', true);
    });

    it('device_unreachable from a timeout carries retryable: true', async () => {
      failDevicePush({ ok: false, kind: 'timeout', message: 'Request timed out' });
      const result = await runToolContract(pixooDisplayText, { text: 'hi', push: true });
      expectDeviceFailure(result, pixooDisplayText.errors, 'device_unreachable', true);
    });

    it.each([
      [503, true],
      [404, false],
    ])('device_http_error (HTTP %i) is declared, retryable: %s', async (status, retryable) => {
      failDevicePush({ ok: false, kind: 'http', status, message: `HTTP ${status}` });
      const result = await runToolContract(pixooDisplayText, { text: 'hi', push: true });
      expectDeviceFailure(result, pixooDisplayText.errors, 'device_http_error', retryable);
    });

    it('device_rejected carries no retryable key', async () => {
      failDevicePush({ ok: false, kind: 'device', deviceCode: 1, message: 'error_code 1' });
      const result = await runToolContract(pixooDisplayText, { text: 'hi', push: true });
      expectDeviceFailure(result, pixooDisplayText.errors, 'device_rejected', undefined);
    });
  });

  describe('static output is pinned byte for byte', () => {
    /** Render with the push stubbed; hash the preview PNG and the frame handed to the device. */
    async function renderHashes(input: DisplayInput) {
      const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
      const pushed: Canvas[] = [];
      vi.spyOn(getPixooService(), 'pushFrame').mockImplementation(async (canvas) => {
        pushed.push(canvas);
        return fakeDeviceState;
      });
      const ctx = createMockContext({ errors: pixooDisplayText.errors });
      const result = await pixooDisplayText.handler(
        pixooDisplayText.input.parse({ ...input, push: true }),
        ctx,
      );
      const [preview] = getContentBlocks(ctx) as Array<{ data: string }>;
      expect(pushed).toHaveLength(1);
      return {
        layout: result.layout.map((e) => `${e.action} ${e.font} @${e.box.x},${e.box.y}`),
        preview: sha256(preview!.data),
        pushed: sha256(Buffer.from(pushed[0]!.buffer)),
      };
    }

    it('single line that fits', async () => {
      expect(await renderHashes({ text: 'Hello', theme: 'ember' })).toMatchInlineSnapshot(`
        {
          "layout": [
            "none standard @19,28",
          ],
          "preview": "9a6bd3a457bf7750eb4d884adc264f81e262bbdbf6b16e85d7d733ae22b32a31",
          "pushed": "cc20b0a20b4f4fa3d5e6be0b00935720268c526f72472582027ae57fd5cc47bc",
        }
      `);
    });

    it('single line shrunk to the compact font', async () => {
      expect(
        await renderHashes({ text: 'HELLO WORLD!', style: { palette: 'ice', shadow: true } }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "shrunk-to-compact compact @9,29",
          ],
          "preview": "040c1742a9d03d6a4f1bf1e9d1425c5cce987e17c55f3c67b06ce52bc7ea1b61",
          "pushed": "478ca10e40cf4e5efe2220ee96c54f3b6cd77ca64262893d0603ead2f1bf23bc",
        }
      `);
    });

    it('single line that overflows (auto-fit scroll action, drawn at x=0)', async () => {
      expect(
        await renderHashes({ text: 'SCROLLING TICKER TEXT THAT OVERFLOWS' }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "scrolling standard @-74,28",
          ],
          "preview": "76492a3db134d31773ffb9aa7505cbe9f04c5fe49dea20b409e2448747f596b1",
          "pushed": "a1cf08cbdc1aeea89ec2493c94943f0819cfcdcc1148dc82615d3548ccc449e5",
        }
      `);
    });

    it('multi-line, centered by default', async () => {
      expect(
        await renderHashes({ text: ['AB', 'CDEFGH'], style: { palette: 'claude' } }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "none standard @26,24",
            "none standard @14,32",
          ],
          "preview": "a7920a926f06a86cf546d59d61f43ec8d3c9fbdcc3b313c0763e264a27ecf8a1",
          "pushed": "2f0a03652fabeb9e0579aaef6275273a669e5ef3f847ea497f678cc809da0e43",
        }
      `);
    });

    it('multi-line with position.x left, compact font, bottom', async () => {
      expect(
        await renderHashes({
          text: ['AB', 'CDEFGH', 'IJK'],
          font: 'compact',
          position: { x: 'left', y: 'bottom' },
          background: '#102030',
        }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "none compact @0,46",
            "none compact @0,52",
            "none compact @0,58",
          ],
          "preview": "27010058b6d660747984084eb7cf0b5c396e0cae18fa491df3b10687b41797e1",
          "pushed": "653237422df360bfa0b3d52b34d5dafa78af3190dcfae690a345757fe7581133",
        }
      `);
    });

    it('multi-line with numeric position.x and scale 2', async () => {
      expect(
        await renderHashes({
          text: ['GO', 'NOW'],
          position: { x: 3, y: 4 },
          style: { scale: 2, outline: true },
        }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "none standard @3,4",
            "none standard @3,19",
          ],
          "preview": "c00ee10624ba943b8a74b7b53b64e77505f63b1fb172d4ec26f5998a2615c15a",
          "pushed": "d46ac674af20f4a498e93aa59f1456ab68cf87305cf5694f8dda34c5714147df",
        }
      `);
    });
  });

  it('invalid_color forwards the declared recovery on both surfaces', async () => {
    const result = await runToolContract(pixooDisplayText, {
      text: 'Hello',
      style: { color: 'invalidcolorname' },
      push: false,
    });
    expectForwardedRecovery(result, pixooDisplayText.errors, 'invalid_color');
  });

  describe('brightness notice', () => {
    const failBrightness = (client: ReturnType<typeof stubDeviceState>) =>
      client.setBrightness.mockResolvedValue({
        ok: false,
        kind: 'http',
        status: 500,
        message: 'HTTP 500',
      });

    it('a failed brightness set is a notice, and the push still lands', async () => {
      const client = stubDeviceState();
      failBrightness(client);
      const result = await runToolContract(pixooDisplayText, {
        text: 'hi',
        brightness: 40,
        push: true,
      });
      expect(result.structuredContent).toMatchObject({
        pushed: true,
        notice: 'Brightness set to 40 failed (http): HTTP 500. Render and push will continue.',
      });
      expect(client.push).toHaveBeenCalledOnce();
    });

    it('composes with a visibility problem into one notice', async () => {
      const client = stubDeviceState({ screenOn: false });
      failBrightness(client);
      const result = await runToolContract(pixooDisplayText, {
        text: 'hi',
        brightness: 40,
        push: true,
      });
      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toMatch(/^Brightness set to 40 failed \(http\): HTTP 500\./);
      expect(notice).toMatch(/screen is off/);
      expect(resultText(result)).toContain(notice);
    });
  });

  describe('effect', () => {
    const LONG = 'SCROLLING TICKER TEXT THAT OVERFLOWS';
    const frameHash = (frame: Canvas) => sha256(Buffer.from(frame.buffer));

    /** Push through the real service to a fake device; return what the device received. */
    async function pushed(input: DisplayInput) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooDisplayText, { ...input, push: true });
      expect(result.isError).toBeFalsy();
      const animation = client.pushAnimation.mock.calls[0]?.[0] as Canvas[] | undefined;
      const single = client.push.mock.calls[0]?.[0] as Canvas | undefined;
      return {
        result,
        animated: animation !== undefined,
        frames: animation ?? (single ? [single] : []),
        sc: result.structuredContent as {
          frames?: number;
          layout: Array<{ action: string; box: { x: number; w: number } }>;
        },
      };
    }

    /** x of every lit pixel in `frame` (black background), optionally within rows [from, to). */
    function litColumns(frame: Canvas, rows: [number, number] = [0, frame.height]): number[] {
      const xs: number[] = [];
      for (let y = rows[0]; y < rows[1]; y++) {
        for (let x = 0; x < frame.width; x++) {
          const [r, g, b] = frame.getPixelRgba(x, y);
          if (r || g || b) xs.push(x);
        }
      }
      return xs;
    }

    it('scroll animates text that fits: 2+ frames pushed as an animation, reported as frames', async () => {
      const { result, animated, frames, sc } = await pushed({ text: 'Hi', effect: 'scroll' });
      expect(animated).toBe(true);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames.length).toBeLessThanOrEqual(40);
      expect(new Set(frames.map(frameHash)).size).toBeGreaterThan(frames.length / 2);
      expect(sc.frames).toBe(frames.length);
      expect(sc.layout[0]?.action).toBe('scrolling');
      expect(resultText(result)).toContain(`**Frames:** ${frames.length}`);
    });

    it('scroll runs one whole cycle of long text inside the 40-frame cap', async () => {
      const { frames } = await pushed({ text: LONG, effect: 'scroll' });
      expect(frames).toHaveLength(40);
      // Enters from past the right edge…
      expect(litColumns(frames[0]!)).toEqual([]);
      expect(Math.min(...litColumns(frames[1]!))).toBeGreaterThan(48);
      // …and by the last frame its tail has scrolled out to the left edge.
      expect(Math.max(...litColumns(frames[39]!), -1)).toBeLessThan(16);
    });

    it('auto leaves text that fits as one frame, byte-identical to no effect', async () => {
      const plain = await pushed({ text: 'Hello', theme: 'ember' });
      const auto = await pushed({ text: 'Hello', theme: 'ember', effect: 'auto' });
      expect(auto.animated).toBe(false);
      expect(auto.sc.frames).toBe(1);
      expect(frameHash(auto.frames[0]!)).toBe(frameHash(plain.frames[0]!));
    });

    it('auto keeps text that fits once shrunk to the compact font static', async () => {
      const { animated, sc } = await pushed({ text: 'HELLO WORLD!', effect: 'auto' });
      expect(animated).toBe(false);
      expect(sc.layout[0]?.action).toBe('shrunk-to-compact');
    });

    it('auto scrolls text that overflows', async () => {
      const { animated, frames, sc } = await pushed({ text: LONG, effect: 'auto' });
      expect(animated).toBe(true);
      expect(frames).toHaveLength(40);
      expect(sc.frames).toBe(40);
      expect(sc.layout[0]?.action).toBe('scrolling');
    });

    it.each(['float', 'pulse'] as const)('%s renders 20 frames that differ', async (effect) => {
      const { animated, frames, sc } = await pushed({ text: 'Hello', theme: 'ember', effect });
      expect(animated).toBe(true);
      expect(frames).toHaveLength(20);
      expect(sc.frames).toBe(20);
      expect(new Set(frames.map(frameHash)).size).toBeGreaterThan(1);
    });

    it.each([
      ['single line', 'Hello'],
      ['multi-line', ['AB', 'CDEFGH']],
    ] as const)('none renders byte-identical to omitting effect (%s)', async (_label, text) => {
      const plain = await pushed({ text: [...text] as string[] });
      const none = await pushed({ text: [...text] as string[], effect: 'none' });
      expect(none.animated).toBe(false);
      expect(frameHash(none.frames[0]!)).toBe(frameHash(plain.frames[0]!));
    });

    it('multi-line scroll moves every line together, keeping the alignment', async () => {
      const { frames } = await pushed({ text: ['AB', 'CDEFGH'], align: 'left', effect: 'scroll' });
      expect(frames.length).toBeGreaterThanOrEqual(2);
      let compared = 0;
      for (const frame of frames) {
        // Rows of the two standard-font lines, stacked and centered vertically.
        const top = litColumns(frame, [24, 31]);
        const bottom = litColumns(frame, [32, 39]);
        if (top.length > 0 && bottom.length > 0 && Math.min(...top, ...bottom) > 0) {
          expect(Math.min(...top)).toBe(Math.min(...bottom));
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(5);
    });

    it('push: false returns the frame count and a tiled preview, pushing nothing', async () => {
      const client = stubDeviceState();
      const ctx = createMockContext({ errors: pixooDisplayText.errors });
      const result = await pixooDisplayText.handler(
        pixooDisplayText.input.parse({ text: 'Hi', effect: 'float', push: false }),
        ctx,
      );
      expect(result).toMatchObject({ pushed: false, frames: 20 });
      expect(client.push).not.toHaveBeenCalled();
      expect(client.pushAnimation).not.toHaveBeenCalled();
      const [preview] = getContentBlocks(ctx) as Array<{ data: string }>;
      // A single frame previews at 512px; a grid of 20 frames does not.
      expect(Buffer.from(preview!.data, 'base64').readUInt32BE(16)).not.toBe(512);
    });
  });

  describe('font on single-line text', () => {
    // 5×7 overflows 64px; 3×5 fits — auto-fit shrinks it when no font is given.
    const SHRINKABLE = 'HELLO WORLD!';

    /** Push to a fake device; return the result and every frame the device received. */
    async function render(input: DisplayInput) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooDisplayText, { ...input, push: true });
      expect(result.isError).toBeFalsy();
      const animation = client.pushAnimation.mock.calls[0]?.[0] as Canvas[] | undefined;
      const single = client.push.mock.calls[0]?.[0] as Canvas | undefined;
      const sc = result.structuredContent as {
        frames: number;
        layout: Array<{ action: string; font?: string; box: { h: number } }>;
      };
      return { result, sc, frames: animation ?? (single ? [single] : []) };
    }

    /** Height of the lit band in a frame on a black background; 0 when nothing is lit. */
    function litHeight(frame: Canvas): number {
      const rows: number[] = [];
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const [r, g, b] = frame.getPixelRgba(x, y);
          if (r || g || b) {
            rows.push(y);
            break;
          }
        }
      }
      return rows.length === 0 ? 0 : Math.max(...rows) - Math.min(...rows) + 1;
    }

    it('compact on text that fits renders in the compact font, on both surfaces', async () => {
      const { result, sc, frames } = await render({ text: 'HI', font: 'compact' });
      expect(sc.layout[0]).toMatchObject({ font: 'compact', action: 'none', box: { h: 5 } });
      expect(resultText(result)).toContain('font:compact');
      expect(litHeight(frames[0]!)).toBe(5);
    });

    it('standard on text that only fits compact overflows in 5×7 instead of shrinking', async () => {
      const { result, sc, frames } = await render({ text: SHRINKABLE, font: 'standard' });
      expect(sc.layout[0]).toMatchObject({ font: 'standard', action: 'scrolling', box: { h: 7 } });
      expect(resultText(result)).toContain('action:scrolling font:standard');
      expect(litHeight(frames[0]!)).toBe(7);
    });

    it('omitting font still shrinks the same text to compact', async () => {
      const { sc } = await render({ text: SHRINKABLE });
      expect(sc.layout[0]).toMatchObject({ font: 'compact', action: 'shrunk-to-compact' });
    });

    it('effect auto scrolls standard-font text that overflows, every frame in 5×7', async () => {
      const { sc, frames } = await render({ text: SHRINKABLE, font: 'standard', effect: 'auto' });
      expect(frames.length).toBeGreaterThan(1);
      expect(sc.frames).toBe(frames.length);
      expect(sc.layout[0]).toMatchObject({ font: 'standard', action: 'scrolling' });
      const heights = frames.map(litHeight).filter((h) => h > 0);
      expect(heights.length).toBeGreaterThan(frames.length / 2);
      expect(new Set(heights)).toEqual(new Set([7]));
    });

    it('effect float animates compact-font text in the compact font', async () => {
      const { sc, frames } = await render({ text: 'HI', font: 'compact', effect: 'float' });
      expect(frames).toHaveLength(20);
      expect(sc.layout[0]).toMatchObject({ font: 'compact' });
      expect(new Set(frames.map(litHeight))).toEqual(new Set([5]));
    });

    it('standard on text that fits in 5×7 is byte-identical to omitting font', async () => {
      const plain = await render({ text: 'Hello', theme: 'ember' });
      const explicit = await render({ text: 'Hello', theme: 'ember', font: 'standard' });
      expect(Buffer.from(explicit.frames[0]!.buffer)).toEqual(Buffer.from(plain.frames[0]!.buffer));
      expect(explicit.sc.layout).toEqual(plain.sc.layout);
    });
  });

  describe('align', () => {
    async function layoutFor(input: DisplayInput) {
      const ctx = createMockContext({ errors: pixooDisplayText.errors });
      const result = await pixooDisplayText.handler(
        pixooDisplayText.input.parse({ ...input, push: false }),
        ctx,
      );
      return result.layout.map((entry) => entry.box);
    }
    const LINES = ['AB', 'CDEFGH', 'IJK'];

    it('right gives every line the same right edge', async () => {
      const boxes = await layoutFor({ text: LINES, align: 'right' });
      expect(new Set(boxes.map((b) => b.x + b.w)).size).toBe(1);
      expect(new Set(boxes.map((b) => b.x)).size).toBe(3);
    });

    it('left gives every line the same left edge', async () => {
      const boxes = await layoutFor({ text: LINES, align: 'left' });
      expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    });

    it('center centers each line within the widest line', async () => {
      const [a, b, c] = await layoutFor({ text: LINES, align: 'center' });
      expect(a!.x - b!.x).toBe(Math.floor((b!.w - a!.w) / 2));
      expect(c!.x - b!.x).toBe(Math.floor((b!.w - c!.w) / 2));
    });

    it('position.x places the aligned block', async () => {
      const right = await layoutFor({ text: LINES, align: 'right', position: { x: 'right' } });
      expect(right.map((b) => b.x + b.w)).toEqual([64, 64, 64]);
      const left = await layoutFor({ text: LINES, align: 'right', position: { x: 2 } });
      expect(Math.min(...left.map((b) => b.x))).toBe(2);
    });

    it('the pushed pixels follow the layout: right-aligned lines end on the same column', async () => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooDisplayText, {
        text: ['AB', 'CDEFGH'],
        align: 'right',
        push: true,
      });
      const frame = client.push.mock.calls[0]?.[0] as Canvas;
      const [top, bottom] = (result.structuredContent as { layout: Array<{ box: { y: number } }> })
        .layout;
      const lastLit = (y: number) => {
        let max = -1;
        for (let row = y; row < y + 7; row++) {
          for (let x = 0; x < 64; x++) {
            const [r, g, bl] = frame.getPixelRgba(x, row);
            if (r || g || bl) max = Math.max(max, x);
          }
        }
        return max;
      };
      expect(lastLit(top!.box.y)).toBeGreaterThan(0);
      expect(lastLit(top!.box.y)).toBe(lastLit(bottom!.box.y));
    });
  });
});
