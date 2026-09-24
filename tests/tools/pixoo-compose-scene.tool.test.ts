/**
 * @fileoverview Tests for the pixoo_compose_scene tool handler.
 * @module tests/tools/pixoo-compose-scene.tool.test
 */

import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Canvas, savePng } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { buildContactSheet, encodePreviewBlock } from '@/renderer/preview.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import {
  errorOutputFiles,
  expectDeviceFailure,
  failDevicePush,
  imageKind,
  listFiles,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';

type SceneInput = z.input<typeof pixooComposeScene.input>;

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeDeviceState = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

describe('pixooComposeScene', () => {
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

  async function stubPush() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushFrame').mockResolvedValue(fakeDeviceState);
  }

  async function stubPushAnimation() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushAnimation').mockResolvedValue(fakeDeviceState);
  }

  it('static scene with push:true calls pushFrame and returns deviceState', async () => {
    await stubPush();
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      frames: 1,
      push: true,
    });
    const result = await pixooComposeScene.handler(input, ctx);
    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('static scene with push:false — returns layout[] and frames:1', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#001020',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      frames: 1,
      push: false,
    });
    const result = await pixooComposeScene.handler(input, ctx);

    expect(result.pushed).toBe(false);
    expect(result.frames).toBe(1);
    expect(Array.isArray(result.layout)).toBe(true);
    expect(result.layout.length).toBeGreaterThan(0);
    expect(result.deviceState).toBeUndefined();
    // The rendered scene rides content[], never structuredContent.
    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: expect.any(String), mimeType: 'image/png' },
    ]);
    expect(result).not.toHaveProperty('previewData');
  });

  it('layout entry has required fields (element, type, box, fits, action)', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 5, color: '#ff0000' }],
      frames: 1,
      push: false,
    });
    const result = await pixooComposeScene.handler(input, ctx);
    const entry = result.layout[0]!;

    expect(entry).toHaveProperty('element');
    expect(entry).toHaveProperty('type');
    expect(entry).toHaveProperty('box');
    expect(entry.box).toMatchObject({ x: expect.any(Number), y: expect.any(Number), w: 10, h: 5 });
    expect(entry).toHaveProperty('fits');
    expect(entry).toHaveProperty('action');
  });

  it('animation path (frames > 1) — returns frames count and image content block', async () => {
    await stubPushAnimation();
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: { theme: 'midnight' },
      elements: [
        {
          type: 'text',
          text: 'LOOP',
          x: 0,
          y: 0,
          effect: { name: 'float', amplitude: 2 },
        },
      ],
      frames: 4,
      speed: 150,
      push: true,
    });
    const result = await pixooComposeScene.handler(input, ctx);

    expect(result.frames).toBe(4);
    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('animation preview tiles every frame instead of showing the middle one', async () => {
    const client = stubDeviceState();
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    await pixooComposeScene.handler(
      pixooComposeScene.input.parse({
        background: '#000000',
        elements: [{ type: 'text', text: 'HI', effect: { name: 'float', amplitude: 3 } }],
        frames: 4,
        push: true,
      }),
      ctx,
    );
    const frames = client.pushAnimation.mock.calls[0]?.[0] as Canvas[];
    const [preview] = getContentBlocks(ctx) as Array<{ data: string }>;
    for (const frame of frames) expect(preview!.data).not.toBe(encodePreviewBlock(frame).data);
    expect(preview!.data).toBe((await buildContactSheet(frames)).data);
  });

  it('static preview is the single frame at 512px', async () => {
    const client = stubDeviceState();
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    await pixooComposeScene.handler(
      pixooComposeScene.input.parse({
        background: '#000000',
        elements: [{ type: 'text', text: 'HI' }],
        push: true,
      }),
      ctx,
    );
    const frame = client.push.mock.calls[0]?.[0] as Canvas;
    const [preview] = getContentBlocks(ctx) as Array<{ data: string }>;
    expect(preview!.data).toBe(encodePreviewBlock(frame).data);
  });

  it('no_device_configured error when push:true and no PIXOO_IP', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      push: true,
    });
    await expect(pixooComposeScene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('gradient background resolves without throw', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: { gradient: { type: 'v', from: '#001020', to: '#000000' } },
      elements: [],
      push: false,
    });
    await expect(pixooComposeScene.handler(input, ctx)).resolves.toMatchObject({ frames: 1 });
  });

  it('format() returns text block containing Pushed and Layout', () => {
    const output = {
      pushed: false,
      frames: 1,
      layout: [
        {
          element: 0 as const,
          type: 'rect',
          box: { x: 0, y: 0, w: 10, h: 5 },
          fits: true,
          action: 'none' as const,
        },
      ],
    };
    const blocks = pixooComposeScene.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pushed');
    expect(text).toContain('Frames');
    expect(text).toContain('Layout');
  });

  it('invalid_color: data.reason === "invalid_color" and message names a color', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'Hi', color: 'notacolor' }],
      frames: 1,
      push: false,
    });
    await expect(Promise.resolve(pixooComposeScene.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_color' },
      message: expect.stringMatching(/white|black|red|green|blue/),
    });
  });

  it.each([
    ['relative', 'relative/scene.png'],
    ['traversal', '/tmp/../etc/scene.png'],
  ])('invalid_output_path: a %s output path is rejected', async (_label, output) => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ffffff' }],
      frames: 1,
      push: false,
      output,
    });
    await expect(Promise.resolve(pixooComposeScene.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_output_path' },
    });
  });

  it('unknown_icon: data.reason === "unknown_icon"', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'icon', name: 'nonexistent_icon_xyz' }],
      frames: 1,
      push: false,
    });
    await expect(Promise.resolve(pixooComposeScene.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'unknown_icon' },
    });
  });

  describe('device failures on push reach both surfaces through the contract', () => {
    const staticScene: SceneInput = {
      background: '#000000',
      elements: [{ type: 'text', text: 'HI' }],
      push: true,
    };
    const animatedScene: SceneInput = {
      ...staticScene,
      elements: [{ type: 'text', text: 'HI', effect: { name: 'float' } }],
      frames: 3,
    };

    it.each([
      ['static', staticScene],
      ['animated', animatedScene],
    ])('device_unreachable carries retryable: true (%s scene)', async (_label, scene) => {
      failDevicePush({ ok: false, kind: 'network', message: 'connect EHOSTUNREACH' });
      const result = await runToolContract(pixooComposeScene, scene);
      expectDeviceFailure(result, pixooComposeScene.errors, 'device_unreachable', true);
    });

    it.each([
      [503, true],
      [404, false],
    ])('device_http_error (HTTP %i) is declared, retryable: %s', async (status, retryable) => {
      failDevicePush({ ok: false, kind: 'http', status, message: `HTTP ${status}` });
      const result = await runToolContract(pixooComposeScene, animatedScene);
      expectDeviceFailure(result, pixooComposeScene.errors, 'device_http_error', retryable);
    });

    it('device_rejected carries no retryable key', async () => {
      failDevicePush({ ok: false, kind: 'device', deviceCode: 1, message: 'error_code 1' });
      const result = await runToolContract(pixooComposeScene, staticScene);
      expectDeviceFailure(result, pixooComposeScene.errors, 'device_rejected', undefined);
    });
  });

  describe('asset_not_found for a missing local asset', () => {
    it.each<[string, SceneInput['elements'][number]]>([
      ['image', { type: 'image', source: '/nonexistent-pixoo-image.png' }],
      ['sprite', { type: 'sprite', path: '/nonexistent-pixoo-sprite.png', cols: 4, rows: 4 }],
    ])('a missing %s path fails as NotFound on both surfaces', async (_kind, element) => {
      const result = await runToolContract(pixooComposeScene, {
        push: false,
        background: '#000000',
        elements: [element],
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'asset_not_found', recovery: { hint: expect.any(String) } },
        },
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('/nonexistent-pixoo-');
      expect(text).toContain('Recovery: ');
      expect(text.trimEnd().slice(-'(reason asset_not_found)'.length)).toBe(
        '(reason asset_not_found)',
      );
    });

    it('fails before anything is pushed', async () => {
      const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
      const pushFrame = vi.spyOn(getPixooService(), 'pushFrame');
      const result = await runToolContract(pixooComposeScene, {
        push: true,
        background: '#000000',
        elements: [{ type: 'image', source: '/nonexistent-pixoo-image.png' }],
      });
      expect(result.isError).toBe(true);
      expect(pushFrame).not.toHaveBeenCalled();
    });
  });

  describe('image elements fit PIXOO_SIZE', () => {
    it.each([16, 32])('size %i: the pushed frame holds the whole image', async (size) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'pixoo-compose-size-'));
      const source = path.join(dir, 'quadrants.png');
      const art = new Canvas(64);
      art.fillRect(0, 0, 64, 32, [255, 0, 0]);
      art.fillRect(32, 32, 32, 32, [255, 255, 0]); // bottom-right quadrant
      await savePng(art, source);

      resetServerConfig();
      process.env['PIXOO_SIZE'] = String(size);
      const client = stubDeviceState();
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ type: 'image', source }],
        push: true,
      });

      expect(result.isError).toBeFalsy();
      const frame = client.push.mock.calls[0]?.[0] as Canvas;
      expect(frame.width).toBe(size);
      expect(frame.getPixelRgba(size * 0.75, size * 0.75)).toEqual([255, 255, 0, 255]);
      expect(frame.getPixelRgba(size * 0.25, size * 0.75)).toEqual([0, 0, 0, 255]);
      const { layout } = result.structuredContent as {
        layout: Array<{ type: string; box: { w: number; h: number } }>;
      };
      expect(layout[0]).toMatchObject({ type: 'image', box: { w: size, h: size } });
      expect(resultText(result)).toContain(`image @ (0,0) ${size}×${size}`);
    });
  });

  describe('saved files: explicit output vs. PIXOO_OUTPUT_DIR', () => {
    let outDir: string;
    let target: string;

    beforeEach(async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'pixoo-compose-output-'));
      outDir = path.join(root, 'auto');
      target = path.join(root, 'explicit.png');
    });

    afterEach(() => {
      delete process.env['PIXOO_OUTPUT_DIR'];
      resetServerConfig();
    });

    async function render(input: Partial<SceneInput>) {
      const ctx = createMockContext({ errors: pixooComposeScene.errors });
      return pixooComposeScene.handler(
        pixooComposeScene.input.parse({
          background: '#000000',
          elements: [{ type: 'text', text: 'HI' }],
          push: false,
          ...input,
        }),
        ctx,
      );
    }

    function useOutputDir() {
      process.env['PIXOO_OUTPUT_DIR'] = outDir;
      resetServerConfig();
    }

    it.each([
      ['static', 1],
      ['animated', 3],
    ])('an explicit output replaces the auto-save (%s scene)', async (_label, frames) => {
      useOutputDir();
      const result = await render({ output: target, frames });
      expect(result.outputFiles).toEqual([target]);
      expect(await listFiles(outDir)).toEqual([]);
      expect(await imageKind(target)).toBe('png');
    });

    it('with only PIXOO_OUTPUT_DIR, the auto-save runs', async () => {
      useOutputDir();
      const result = await render({});
      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles?.[0]?.startsWith(outDir)).toBe(true);
      expect(await listFiles(outDir)).toEqual(result.outputFiles);
    });

    it('with only an explicit output, just that file is written', async () => {
      const result = await render({ output: target });
      expect(result.outputFiles).toEqual([target]);
    });

    it('with neither, nothing is written', async () => {
      expect((await render({})).outputFiles).toBeUndefined();
    });

    it('a failed push names the explicit output rather than writing another copy', async () => {
      useOutputDir();
      failDevicePush({ ok: false, kind: 'network', message: 'connect EHOSTUNREACH' });
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ type: 'text', text: 'HI' }],
        push: true,
        output: target,
      });
      expectDeviceFailure(result, pixooComposeScene.errors, 'device_unreachable', true);
      expect(errorOutputFiles(result)).toEqual([target]);
      expect(await listFiles(outDir)).toEqual([]);
    });
  });

  describe('forwards the declared recovery on both surfaces', () => {
    it('invalid_output_path', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [],
        push: false,
        output: 'relative/scene.png',
      });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_output_path');
    });

    it('invalid_color', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ type: 'text', text: 'Hi', color: 'notacolor' }],
        push: false,
      });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_color');
    });

    it('unknown_icon', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ type: 'icon', name: 'nonexistent_icon_xyz' }],
        push: false,
      });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'unknown_icon');
    });
  });
});
