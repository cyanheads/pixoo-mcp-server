/**
 * @fileoverview Tests for the pixoo_display_text tool.
 * @module tests/tools/pixoo-display-text.tool.test
 */

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import {
  type BitmapFont,
  Canvas,
  drawText,
  FONT_3x5,
  FONT_5x7,
  FONT_DIGITS_11x18,
  measureText,
  resolveColor,
} from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { PALETTES } from '@/renderer/themes.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import { inkColors, inkPixels, inkRows } from '../helpers/canvas-ink.js';
import {
  expectDeviceFailure,
  failDevicePush,
  listFiles,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';
import {
  expectInvalidColor,
  PROTOTYPE_COLOR_INPUTS,
  PROTOTYPE_NAME_CASES,
} from '../helpers/prototype-color-names.js';

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

  describe('outputFiles under PIXOO_OUTPUT_DIR are absolute', () => {
    /** The working directory the server runs from, as the process reports it. */
    let cwd: string;
    let previousCwd: string;

    beforeEach(async () => {
      cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixoo-display-output-')));
      previousCwd = process.cwd();
      process.chdir(cwd);
    });

    afterEach(async () => {
      process.chdir(previousCwd);
      delete process.env['PIXOO_OUTPUT_DIR'];
      resetServerConfig();
      await rm(cwd, { recursive: true, force: true });
    });

    /** Render `HI` with push: false under PIXOO_OUTPUT_DIR=`dir`; return the saved paths. */
    async function renderInto(dir: string) {
      process.env['PIXOO_OUTPUT_DIR'] = dir;
      resetServerConfig();
      const result = await runToolContract(pixooDisplayText, { text: 'HI', push: false });
      expect(result.isError).toBeFalsy();
      const { outputFiles } = result.structuredContent as { outputFiles: string[] };
      expect(outputFiles).toHaveLength(1);
      expect(resultText(result)).toContain(`**Saved:** ${outputFiles[0]}`);
      return outputFiles;
    }

    it('PIXOO_OUTPUT_DIR=previews saves under <working directory>/previews and reports that path', async () => {
      const outputFiles = await renderInto('previews');
      const [file] = outputFiles as [string];
      expect(path.isAbsolute(file)).toBe(true);
      expect(path.dirname(file)).toBe(path.join(cwd, 'previews'));
      expect(path.basename(file)).toMatch(/^display-text-\d+\.png$/);
      expect(await listFiles(path.join(cwd, 'previews'))).toEqual(outputFiles);
    });

    it('an absolute PIXOO_OUTPUT_DIR saves where it always has, traversal and trailing slash included', async () => {
      const outputFiles = await renderInto(`${cwd}/a/../out/`);
      const [file] = outputFiles as [string];
      expect(file).toBe(path.join(cwd, 'out', path.basename(file)));
      expect(await listFiles(path.join(cwd, 'out'))).toEqual(outputFiles);
    });
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

  it('overflowing layout preview is non-blank (contains non-background pixels)', async () => {
    // A very long text overflows the panel even in the compact font; the static
    // frame draws it from x=0 so the preview shows legible text.
    const { Canvas: CVS } = await import('@cyanheads/pixoo-toolkit');
    const { drawStyledText } = await import('@/renderer/text-engine.js');

    const ctx = createMockContext({ errors: pixooDisplayText.errors });
    const longText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const input = pixooDisplayText.input.parse({ text: longText, push: false });
    const result = await pixooDisplayText.handler(input, ctx);

    // One static frame: nothing scrolls, the line runs off the right edge.
    expect(result).toMatchObject({ frames: 1, layout: [{ action: 'none', fits: false }] });
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

    it('single line that overflows (static, drawn at x=0)', async () => {
      expect(
        await renderHashes({ text: 'SCROLLING TICKER TEXT THAT OVERFLOWS' }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "none standard @0,28",
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

    it('numerals font in an explicit color with a shadow', async () => {
      expect(
        await renderHashes({
          text: '12:45',
          font: 'numerals',
          style: { color: '#44ccff', shadow: true },
        }),
      ).toMatchInlineSnapshot(`
        {
          "layout": [
            "none numerals @3,23",
          ],
          "preview": "b514f4ceffa38ef664a473448454724269d59e2f6ff45a2e220b7055eb4324e8",
          "pushed": "3c479396b15b17c92c8779fe9bedd7e119032eae9c1e95a448c95f7385259952",
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

    it('composes after the fallback-character notice, then the visibility problem', async () => {
      const client = stubDeviceState({ screenOn: false });
      failBrightness(client);
      const result = await runToolContract(pixooDisplayText, {
        text: '20 €',
        brightness: 40,
        push: true,
      });
      const notice = [
        'Not in the standard and compact fonts, so drawn as "?": element 0 "€" (U+20AC). Those fonts draw printable ASCII plus ° ← ↑ → ↓ ▲ ▼ ♥ · … only.',
        'Brightness set to 40 failed (http): HTTP 500. Render and push will continue.',
        'Pushed, but the render may not be visible: the screen is off (pixoo_control_device with screen: "on").',
      ].join(' ');
      expect(result.structuredContent).toMatchObject({ pushed: true, notice });
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
      expect(sc.layout[0]).toMatchObject({ font: 'standard', action: 'none', box: { h: 7 } });
      expect(resultText(result)).toContain('fits:false action:none font:standard');
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

  describe('an Object.prototype name is not a color', () => {
    it.each(PROTOTYPE_COLOR_INPUTS)('style.color %j fails as invalid_color', async (name) => {
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        style: { color: name },
        push: false,
      });
      expectInvalidColor(result, pixooDisplayText.errors, name);
    });

    it.each(PROTOTYPE_NAME_CASES)('background %j fails as invalid_color', async (name) => {
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        background: name,
        push: false,
      });
      expectInvalidColor(result, pixooDisplayText.errors, name);
    });

    it('named and hex colors still resolve on those surfaces', async () => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        style: { color: 'Orange' },
        background: '#00f',
        push: true,
      });
      expect(result.isError).toBeFalsy();
      const frame = client.push.mock.calls[0]?.[0] as Canvas;
      expect(frame.getPixelRgba(0, 0).slice(0, 3)).toEqual([0, 0, 255]);
      expect(inkColors(frame, undefined, [0, 0, 255])).toEqual([[255, 165, 0]]);
    });
  });

  describe('printable ASCII renders exactly as it did under toolkit 0.8.2', () => {
    // Printable ASCII (32–126), split into lines that fit 64 px in each font. The
    // expected hashes and boxes were recorded from this server on @cyanheads/pixoo-toolkit
    // 0.8.2, before the non-ASCII glyphs were added to both fonts.
    const STANDARD = [
      ' !"#$%&\'()*+,',
      '-./01234567',
      '89:;<=>?@ABC',
      'DEFGHIJKLMN',
      'OPQRSTUVWX',
      'YZ[\\]^_`abc',
      'defghijklmn',
      'opqrstuvwx',
      'yz{|}~',
    ];
    const COMPACT = [
      ' !"#$%&\'()*+,-./01',
      '23456789:;<=>?@AB',
      'CDEFGHIJKLMNOPQR',
      'STUVWXYZ[\\]^_`abc',
      'defghijklmnopqrst',
      'uvwxyz{|}~',
    ];

    /** Push `input`; return each layout entry as a line and the hash of the pushed frame. */
    async function pushedFrame(input: DisplayInput) {
      const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
      const pushed: Canvas[] = [];
      vi.spyOn(getPixooService(), 'pushFrame').mockImplementation(async (canvas) => {
        pushed.push(canvas);
        return fakeDeviceState;
      });
      const result = await pixooDisplayText.handler(
        pixooDisplayText.input.parse({ ...input, push: true }),
        createMockContext({ errors: pixooDisplayText.errors }),
      );
      expect(pushed).toHaveLength(1);
      return {
        layout: result.layout.map(
          (e) =>
            `${e.action} ${e.font} @${e.box.x},${e.box.y} ${e.box.w}x${e.box.h} fits:${e.fits}`,
        ),
        pushed: sha256(Buffer.from(pushed[0]!.buffer)),
      };
    }

    const styled = { theme: 'midnight', style: { palette: 'ice', shadow: true } } as const;

    it('standard, first five lines, with a palette ramp and shadow over a theme', async () => {
      expect(
        await pushedFrame({ text: STANDARD.slice(0, 5), font: 'standard', ...styled }),
      ).toEqual({
        layout: [
          'none standard @2,12 60x7 fits:true',
          'none standard @2,20 59x7 fits:true',
          'none standard @1,28 62x7 fits:true',
          'none standard @0,36 63x7 fits:true',
          'none standard @2,44 59x7 fits:true',
        ],
        pushed: '4782a1dab1e6f18674fe294c8403dfb369854304e1595676ec86d38b2acc18ce',
      });
    });

    it('standard, last four lines, with a palette ramp and shadow over a theme', async () => {
      expect(await pushedFrame({ text: STANDARD.slice(5), font: 'standard', ...styled })).toEqual({
        layout: [
          'none standard @2,16 59x7 fits:true',
          'none standard @2,24 59x7 fits:true',
          'none standard @2,32 59x7 fits:true',
          'none standard @18,40 27x7 fits:true',
        ],
        pushed: 'a32b8bac2ce460f4729e5895e792bd0c520d91003bbb00a99d2b1c668ff13ccb',
      });
    });

    it('compact, every line, flat white at the top-left', async () => {
      expect(
        await pushedFrame({ text: COMPACT, font: 'compact', position: { x: 'left', y: 'top' } }),
      ).toEqual({
        layout: [
          'none compact @0,0 62x5 fits:true',
          'none compact @0,6 64x5 fits:true',
          'none compact @0,12 63x5 fits:true',
          'none compact @0,18 64x5 fits:true',
          'none compact @0,24 64x5 fits:true',
          'none compact @0,30 37x5 fits:true',
        ],
        pushed: '07c0b98e7696378576da5f26e19cdcfde40b89c1d626da0a8b424a0a7460bc53',
      });
    });
  });

  /** The ink the toolkit draws for `text` in `face` at (`x`, `y`), white on an empty canvas. */
  function toolkitInk(text: string, face: BitmapFont, x = 0, y = 0): string[] {
    const canvas = new Canvas(64);
    drawText(canvas, text, x, y, [255, 255, 255], { font: face });
    return inkPixels(canvas);
  }

  /** Push `input` to a fake device; return the result and the single frame it received. */
  async function pushOne(input: DisplayInput) {
    const client = stubDeviceState();
    const result = await runToolContract(pixooDisplayText, { ...input, push: true });
    expect(result.isError).toBeFalsy();
    expect(client.push).toHaveBeenCalledOnce();
    return { result, frame: client.push.mock.calls[0]?.[0] as Canvas };
  }

  type Entry = {
    action: string;
    box: { x: number; y: number; w: number; h: number };
    fits: boolean;
    font?: string;
    scale?: number;
  };
  const layoutOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { layout: Entry[] }).layout;

  describe('the non-ASCII glyphs in standard and compact', () => {
    const FACES = { standard: FONT_5x7, compact: FONT_3x5 } as const;

    it.each([
      ['72°F', 'standard', '72?F'],
      ['72°F', 'compact', '72?F'],
      ['▲3 ▼2', 'standard', '?3 ?2'],
      ['▲3 ▼2', 'compact', '?3 ?2'],
    ] as const)('%s draws its own glyphs in %s, not %s', async (text, font, asQuestionMarks) => {
      const white = { position: { x: 0, y: 0 }, style: { color: '#ffffff' } } as const;
      const { result, frame } = await pushOne({ text, font, ...white });
      const ink = inkPixels(frame, [0, 0, 0]);
      expect(ink).toEqual(toolkitInk(text, FACES[font]));
      expect(ink).not.toEqual(toolkitInk(asQuestionMarks, FACES[font]));
      expect(layoutOf(result)[0]).toMatchObject({ font, fits: true });
    });

    it.each(['standard', 'compact'] as const)(
      'each of ° ← ↑ → ↓ ▲ ▼ ♥ · … draws its own glyph in %s',
      async (font) => {
        const symbols = '°←↑→↓▲▼♥·…';
        const white = { position: { x: 0, y: 0 }, style: { color: '#ffffff' } } as const;
        for (const ch of symbols) {
          const { frame } = await pushOne({ text: ch, font, ...white });
          const ink = inkPixels(frame, [0, 0, 0]);
          expect(ink, ch).toEqual(toolkitInk(ch, FACES[font]));
          expect(ink, ch).not.toEqual(toolkitInk('?', FACES[font]));
        }
      },
    );
  });

  describe('the numerals font', () => {
    it('renders 12:45 as a 58×18 box in the 11×18 face, reported as numerals on both surfaces', async () => {
      const { result, frame } = await pushOne({ text: '12:45', font: 'numerals' });
      expect(layoutOf(result)).toEqual([
        {
          element: 0,
          type: 'text',
          box: { x: 3, y: 23, w: 58, h: 18 },
          fits: true,
          action: 'none',
          font: 'numerals',
          scale: 1,
        },
      ]);
      expect(resultText(result)).toContain(
        '[0] text @ (3,23) 58×18 fits:true action:none font:numerals scale:1',
      );
      expect(inkPixels(frame, [0, 0, 0])).toEqual(toolkitInk('12:45', FONT_DIGITS_11x18, 3, 23));
    });

    it('with font omitted, 12:45 still lays out in standard', async () => {
      const { result } = await pushOne({ text: '12:45' });
      expect(layoutOf(result)[0]).toMatchObject({
        font: 'standard',
        action: 'none',
        box: { w: measureText('12:45', { font: FONT_5x7 }), h: 7 },
      });
      expect(resultText(result)).toContain('font:standard');
    });

    it('auto-fit never picks numerals: digits too wide for 5×7 shrink to compact', async () => {
      const digits = '0123456789012';
      expect(measureText(digits, { font: FONT_5x7 })).toBeGreaterThan(64);
      const { result } = await pushOne({ text: digits });
      expect(layoutOf(result)[0]).toMatchObject({ font: 'compact', action: 'shrunk-to-compact' });
    });

    it('at scale 2, 12:45 (116 px) on a 64-px panel overflows statically and stays in numerals', async () => {
      const { result } = await pushOne({ text: '12:45', font: 'numerals', style: { scale: 2 } });
      expect(layoutOf(result)[0]).toMatchObject({
        font: 'numerals',
        action: 'none',
        fits: false,
        scale: 2,
        box: { x: 0, w: 116, h: 36 },
      });
      expect(resultText(result)).toContain('116×36 fits:false action:none font:numerals');
    });

    it('effect auto scrolls overflowing numerals, every frame in the 11×18 face', async () => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooDisplayText, {
        text: '12:45',
        font: 'numerals',
        style: { scale: 2 },
        effect: 'auto',
        push: true,
      });
      const frames = client.pushAnimation.mock.calls[0]?.[0] as Canvas[];
      expect(frames.length).toBeGreaterThan(1);
      expect(layoutOf(result)[0]).toMatchObject({ font: 'numerals', action: 'scrolling' });
      const heights = frames.map((f) => {
        const rows = inkRows(f, [0, 0, 0]);
        return rows.length === 0 ? 0 : rows.at(-1)! - rows[0]! + 1;
      });
      expect(Math.max(...heights)).toBe(36);
    });

    it('stacks multi-line numerals 19 px apart, each line in numerals', async () => {
      const { result } = await pushOne({ text: ['12', '45'], font: 'numerals' });
      expect(layoutOf(result)).toMatchObject([
        { font: 'numerals', box: { x: 19, y: 13, w: 26, h: 18 }, fits: true },
        { font: 'numerals', box: { x: 19, y: 32, w: 26, h: 18 }, fits: true },
      ]);
    });

    it('palette, shadow, and scale apply unchanged', async () => {
      const { frame } = await pushOne({
        text: '1',
        font: 'numerals',
        style: { palette: 'ember', shadow: true, scale: 2 },
      });
      const rows = inkRows(frame, [0, 0, 0]);
      // The 36 rows of the glyph at scale 2 (y 14–49), then one row of shadow below.
      expect([rows[0], rows.at(-1)]).toEqual([14, 50]);
      const { from, to } = PALETTES.ember;
      expect(inkColors(frame, 14, [0, 0, 0])).toEqual([resolveColor(from)]);
      expect(inkColors(frame, 49, [0, 0, 0])).toContainEqual(resolveColor(to));
      expect(inkColors(frame, 50, [0, 0, 0])).toEqual([[20, 15, 10]]);
    });

    it('outline applies unchanged: a black rim one pixel around the glyph', async () => {
      const bg = resolveColor('#203040');
      const { frame } = await pushOne({
        text: '1',
        font: 'numerals',
        background: '#203040',
        style: { color: '#ffffff', outline: true },
      });
      // The glyph sits at y 23–40; the rim adds one row above and below.
      const rows = inkRows(frame, bg);
      expect([rows[0], rows.at(-1)]).toEqual([22, 41]);
      expect(inkColors(frame, 22, bg)).toEqual([[0, 0, 0]]);
      expect(inkColors(frame, 30, bg)).toEqual(
        expect.arrayContaining([
          [0, 0, 0],
          [255, 255, 255],
        ]),
      );
    });

    it.each([
      ['72°F', '"F"'],
      ['am', '"a", "m"'],
      [['12', 'am'], '"a", "m"'],
      ['9 ♥ 7×', '"♥", "×"'],
    ] as const)(
      '%j in numerals fails -32602 naming %s; nothing is rendered or pushed',
      async (text, named) => {
        const client = stubDeviceState();
        const result = await runToolContract(pixooDisplayText, {
          text: typeof text === 'string' ? text : [...text],
          font: 'numerals',
          push: true,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
        expect(resultText(result)).toContain(`Characters not in the numerals font: ${named}.`);
        expect(JSON.stringify(result.structuredContent)).toContain('text');
        expect(result.content.some((block) => block.type === 'image')).toBe(false);
        expect(client.push).not.toHaveBeenCalled();
        expect(client.pushAnimation).not.toHaveBeenCalled();
      },
    );

    it('the input root stays strict: an undeclared argument is still rejected by name', async () => {
      const result = await runToolContract(pixooDisplayText, {
        text: '12',
        font: 'numerals',
        push: false,
        fontSize: 18,
      } as DisplayInput);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain('fontSize');
    });

    it('every character the face holds is accepted', async () => {
      const { result } = await pushOne({ text: ['0123', '4567', '89 :'], font: 'numerals' });
      expect(layoutOf(result)).toHaveLength(3);
      const symbols = await pushOne({ text: '.-+/%°?', font: 'numerals' });
      expect(layoutOf(symbols.result)[0]).toMatchObject({ font: 'numerals' });
    });

    it('the same characters are accepted in standard and compact', async () => {
      for (const font of ['standard', 'compact'] as const) {
        const { result } = await pushOne({ text: '72°F am', font });
        expect(layoutOf(result)[0]).toMatchObject({ font });
      }
    });

    it('€ in numerals still fails -32602 with its message, and no fallback notice', async () => {
      const result = await runToolContract(pixooDisplayText, {
        text: '20 €',
        font: 'numerals',
        push: false,
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain(
        'Characters not in the numerals font: "€". It draws 0–9, space, and : . - + / % ° ? only. Set units and labels in the standard or compact font, or use pixoo_compose_scene to place a numerals text element beside a standard or compact label.',
      );
      expect(resultText(result)).not.toContain('drawn as "?"');
    });
  });

  describe('characters the standard and compact fonts draw as ?', () => {
    type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
    const fallbackNotice = (named: string) =>
      `Not in the standard and compact fonts, so drawn as "?": ${named}. Those fonts draw printable ASCII plus ° ← ↑ → ↓ ▲ ▼ ♥ · … only.`;
    const render = (input: Omit<DisplayInput, 'push'>) =>
      runToolContract(pixooDisplayText, { ...input, push: false });
    const previewOf = (result: ToolResult) =>
      result.content.flatMap((block) => (block.type === 'image' ? [block.data] : []));

    it.each<[string, Omit<DisplayInput, 'push'>, Omit<DisplayInput, 'push'>]>([
      ['"20 €"', { text: '20 €' }, { text: '20 ?' }],
      ['["A€", "B"]', { text: ['A€', 'B'] }, { text: ['A?', 'B'] }],
      [
        '"9 ♥ 7×" in compact',
        { text: '9 ♥ 7×', font: 'compact' },
        { text: '9 ♥ 7?', font: 'compact' },
      ],
    ])('the preview of %s is byte-identical to its ? spelling', async (_label, input, spelled) => {
      const [drawn, fallback] = await Promise.all([render(input), render(spelled)]);
      expect(previewOf(drawn)).toHaveLength(1);
      expect(previewOf(drawn)).toEqual(previewOf(fallback));
    });

    it('"20 €" names € (U+20AC) at element 0 on both surfaces', async () => {
      const result = await render({ text: '20 €' });
      expect(result.isError).toBeFalsy();
      const notice = fallbackNotice('element 0 "€" (U+20AC)');
      expect(result.structuredContent).toMatchObject({ pushed: false, notice });
      expect(resultText(result)).toContain(notice);
    });

    it.each<[string, DisplayInput['text'], string]>([
      ['only the line holding it', ['A€', 'B'], 'element 0 "€" (U+20AC)'],
      [
        'each character once, in first-appearance order',
        '€€×',
        'element 0 "€" (U+20AC), "×" (U+00D7)',
      ],
      ['the invisible variation selector after ♥', '♥️', 'element 0 "️" (U+FE0F)'],
      ['a newline inside one string', 'a\nb', 'element 0 "\\n" (U+000A)'],
      ['a no-break space', '20 C', 'element 0 " " (U+00A0)'],
      ['a character outside the Basic Multilingual Plane', '1😀2', 'element 0 "😀" (U+1F600)'],
      [
        'every flagged line by index, deduplicated per line',
        ['1€', 'ok', '2×€'],
        'element 0 "€" (U+20AC); element 2 "×" (U+00D7), "€" (U+20AC)',
      ],
    ])('names %s', async (_label, text, named) => {
      const result = await render({ text });
      const notice = fallbackNotice(named);
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expect(resultText(result)).toContain(notice);
    });

    it.each<[string, Omit<DisplayInput, 'push'>, string]>([
      ['a scroll effect', { text: '20 €', effect: 'scroll' }, 'standard'],
      ['a pulse effect', { text: '20 €', effect: 'pulse' }, 'standard'],
      ['the compact font', { text: '20 €', font: 'compact' }, 'compact'],
      ['auto-fit shrinking to compact', { text: '20 € 0123456789' }, 'compact'],
    ])('names them under %s', async (_label, input, font) => {
      const result = await render(input);
      expect(layoutOf(result)[0]).toMatchObject({ font });
      expect((result.structuredContent as { notice?: string }).notice).toBe(
        fallbackNotice('element 0 "€" (U+20AC)'),
      );
    });

    const ascii = String.fromCharCode(...Array.from({ length: 95 }, (_, i) => 32 + i));

    it.each<[string, DisplayInput['text']]>([
      ['72°F ▲3', '72°F ▲3'],
      ['printable ASCII', ascii],
      ['the ten added symbols', '°←↑→↓▲▼♥·…'],
    ])('%s produces no notice key on either surface', async (_label, text) => {
      const result = await render({ text });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(resultText(result)).not.toContain('drawn as "?"');
    });
  });

  describe('layout fits: the placed box lies wholly on the panel, all four edges', () => {
    /** Run `input` on a `size`-pixel panel without a push. */
    async function layoutOn(size: number, input: DisplayInput) {
      process.env['PIXOO_SIZE'] = String(size);
      resetServerConfig();
      const result = await runToolContract(pixooDisplayText, { ...input, push: false });
      expect(result.isError).toBeFalsy();
      return { result, layout: layoutOf(result) };
    }

    it('PIXOO_SIZE 16: "1" at scale 3 is 21 px tall on a 16-px panel — fits: false', async () => {
      const { result, layout } = await layoutOn(16, { text: '1', style: { scale: 3 } });
      expect(layout[0]).toMatchObject({ box: { x: 3, y: -3, w: 9, h: 21 }, fits: false });
      expect(resultText(result)).toContain('(3,-3) 9×21 fits:false');
    });

    it('PIXOO_SIZE 16: an 18-px numeral that fits the width still overflows the height', async () => {
      const { layout } = await layoutOn(16, { text: '1', font: 'numerals' });
      expect(layout[0]).toMatchObject({
        font: 'numerals',
        action: 'none',
        box: { x: 1, y: -1, w: 13, h: 18 },
        fits: false,
      });
    });

    // "Hi" is 9×7 in 5×7.
    it.each([
      ['off the left edge', false, { x: -1, y: 0 }],
      ['off the right edge', false, { x: 56, y: 0 }],
      ['off the top edge', false, { x: 0, y: -1 }],
      ['off the bottom edge', false, { x: 0, y: 58 }],
      ['flush with the right and bottom edges', true, { x: 55, y: 57 }],
      ['flush with the left and top edges', true, { x: 0, y: 0 }],
    ] as const)('single line %s: fits %s', async (_label, fits, position) => {
      const { result, layout } = await layoutOn(64, { text: 'Hi', position });
      expect(layout[0]).toMatchObject({ box: { ...position, w: 9, h: 7 }, action: 'none', fits });
      expect(resultText(result)).toContain(`fits:${fits}`);
    });

    it('multi-line: a line above the top edge does not fit; the line below it does', async () => {
      const { layout } = await layoutOn(64, { text: ['AB', 'CD'], position: { y: -4 } });
      expect(layout.map((e) => [e.box.y, e.fits])).toEqual([
        [-4, false],
        [4, true],
      ]);
    });

    it('multi-line: lines left of the panel do not fit', async () => {
      const { layout } = await layoutOn(64, { text: ['AB', 'CD'], position: { x: -1 } });
      expect(layout.map((e) => [e.box.x, e.fits])).toEqual([
        [-1, false],
        [-1, false],
      ]);
    });

    it('multi-line: a stack taller than the panel reports its outer lines as not fitting', async () => {
      const { layout } = await layoutOn(16, { text: ['1', '2', '3'] });
      expect(layout.map((e) => [e.box.y, e.fits])).toEqual([
        [-4, false],
        [4, true],
        [12, false],
      ]);
    });

    it('a line wider than the panel reports the box its static frame draws, from x = 0', async () => {
      const text = 'SCROLLING TICKER TEXT THAT OVERFLOWS';
      const { result, frame } = await pushOne({ text, style: { color: '#ffffff' } });
      const [entry] = layoutOf(result);
      expect(entry).toMatchObject({ action: 'none', box: { x: 0, y: 28, h: 7 }, fits: false });
      expect(resultText(result)).toContain(`(0,28) ${entry!.box.w}×7 fits:false action:none`);
      expect(inkPixels(frame, [0, 0, 0])).toEqual(toolkitInk(text, FONT_5x7, 0, 28));
    });

    it.each([
      [16, { text: '1', style: { scale: 3 } }, { type: 'text', text: '1', style: { scale: 3 } }],
      [64, { text: 'Hi', position: { x: 60, y: 2 } }, { type: 'text', text: 'Hi', x: 60, y: 2 }],
      [64, { text: 'Hi', position: { x: 2, y: -2 } }, { type: 'text', text: 'Hi', x: 2, y: -2 }],
      [
        64,
        { text: '12:45', font: 'numerals', position: { x: 'center', y: 'bottom' } },
        { type: 'text', text: '12:45', font: 'numerals', x: 'center', y: 'bottom' },
      ],
    ] as const)(
      'on a %i-px panel, %j reports the box and fits pixoo_compose_scene reports',
      async (size, display, element) => {
        const { layout } = await layoutOn(size, display as DisplayInput);
        const scene = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [
            {
              ...element,
              x: 'x' in element ? element.x : 'center',
              y: 'y' in element ? element.y : 'center',
            } as z.input<typeof pixooComposeScene.input>['elements'][number],
          ],
          push: false,
        });
        const [sceneEntry] = layoutOf(scene);
        expect(sceneEntry).toMatchObject({ box: layout[0]!.box, fits: layout[0]!.fits });
      },
    );
  });

  describe('layout action: scrolling only when the returned frames scroll', () => {
    const LONG = 'SCROLLING TICKER TEXT THAT OVERFLOWS';
    const LONG_W = measureText(LONG, { font: FONT_5x7 });

    /** Render without a push; return the result, its layout, and the content[] text. */
    async function layoutFor(input: DisplayInput) {
      const result = await runToolContract(pixooDisplayText, { ...input, push: false });
      expect(result.isError).toBeFalsy();
      return { result, layout: layoutOf(result), text: resultText(result) };
    }

    it('multi-line with a line wider than the panel, no effect: every line none', async () => {
      const { result, layout, text } = await layoutFor({ text: ['AB', LONG] });
      expect((result.structuredContent as { frames: number }).frames).toBe(1);
      expect(layout.map((e) => [e.action, e.fits])).toEqual([
        ['none', true],
        ['none', false],
      ]);
      expect(text).toContain(`${LONG_W}×7 fits:false action:none`);
      expect(text).not.toContain('action:scrolling');
    });

    it.each([
      ['scroll', ['AB', 'CD']],
      ['auto', ['AB', LONG]],
    ] as const)('multi-line under effect %s: every line scrolling', async (effect, lines) => {
      const { layout, text } = await layoutFor({ text: [...lines], effect });
      expect(layout.map((e) => e.action)).toEqual(['scrolling', 'scrolling']);
      expect(text.match(/action:scrolling/g)).toHaveLength(2);
    });

    it('multi-line under effect auto that fits: every line none, one frame', async () => {
      const { result, layout } = await layoutFor({ text: ['AB', 'CD'], effect: 'auto' });
      expect((result.structuredContent as { frames: number }).frames).toBe(1);
      expect(layout.map((e) => e.action)).toEqual(['none', 'none']);
    });

    it('tools/list advertises action as none, shrunk-to-compact, scrolling and element as a number', () => {
      const item = z.toJSONSchema(pixooDisplayText.output) as unknown as {
        properties: { layout: { items: { properties: Record<string, Record<string, unknown>> } } };
      };
      const { action, element } = item.properties.layout.items.properties;
      expect(action?.['enum']).toEqual(['none', 'shrunk-to-compact', 'scrolling']);
      expect(element?.['type']).toBe('number');
      expect(JSON.stringify(element)).not.toContain('background');
    });

    it.each([
      ['omitted', undefined, 1],
      ['none', 'none', 1],
      ['float', 'float', 20],
      ['pulse', 'pulse', 20],
    ] as const)(
      'a single line wider than the panel, effect %s, does not scroll: none, fits false, box.x 0',
      async (_label, effect, frames) => {
        const { result, layout, text } = await layoutFor({ text: LONG, ...(effect && { effect }) });
        expect((result.structuredContent as { frames: number }).frames).toBe(frames);
        expect(layout).toEqual([
          {
            element: 0,
            type: 'text',
            box: { x: 0, y: 28, w: LONG_W, h: 7 },
            fits: false,
            action: 'none',
            font: 'standard',
            scale: 1,
          },
        ]);
        expect(text).toContain(
          `[0] text @ (0,28) ${LONG_W}×7 fits:false action:none font:standard scale:1`,
        );
      },
    );

    it.each(['auto', 'scroll'] as const)(
      'a single line wider than the panel, effect %s, scrolls: scrolling, fits false, box.x 0',
      async (effect) => {
        const { result, layout, text } = await layoutFor({ text: LONG, effect });
        expect((result.structuredContent as { frames: number }).frames).toBe(40);
        expect(layout).toEqual([
          {
            element: 0,
            type: 'text',
            box: { x: 0, y: 28, w: LONG_W, h: 7 },
            fits: false,
            action: 'scrolling',
            font: 'standard',
            scale: 1,
          },
        ]);
        expect(text).toContain(
          `[0] text @ (0,28) ${LONG_W}×7 fits:false action:scrolling font:standard scale:1`,
        );
      },
    );

    it.each([
      ['HELLO WORLD!', undefined, 'shrunk-to-compact'],
      ['Hi', 'scroll', 'scrolling'],
      ['Hi', undefined, 'none'],
    ] as const)('%s with effect %s reports %s on both surfaces', async (line, effect, action) => {
      const { layout, text } = await layoutFor({ text: line, ...(effect && { effect }) });
      expect(layout[0]?.action).toBe(action);
      expect(text).toContain(`action:${action}`);
    });
  });
});
