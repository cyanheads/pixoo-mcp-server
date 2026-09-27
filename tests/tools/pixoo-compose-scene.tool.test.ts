/**
 * @fileoverview Tests for the pixoo_compose_scene tool handler.
 * @module tests/tools/pixoo-compose-scene.tool.test
 */

import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
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
  loadImage,
  measureText,
  type RGB,
  resolveColor,
  savePng,
} from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { ICON_NAMES } from '@/renderer/icons.js';
import { compileEffect, EFFECT_NAMES } from '@/renderer/keyframes.js';
import { buildContactSheet, encodePreviewBlock } from '@/renderer/preview.js';
import { PALETTE_NAMES, PALETTES } from '@/renderer/themes.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import { hashOf, inkColors, inkPixels, inkRows, isInk } from '../helpers/canvas-ink.js';
import {
  errorOutputFiles,
  expectDeviceFailure,
  failDevicePush,
  imageKind,
  isolateTmpdir,
  listFiles,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';
import {
  expectInvalidImage,
  type ImageSources,
  NOT_IMAGE_REASON,
  TRUNCATED_JPEG_REASON,
  UNREACHABLE_URL,
  withServedSources,
  writeImageSources,
} from '../helpers/image-sources.js';
import {
  expectInvalidColor,
  PROTOTYPE_COLOR_INPUTS,
  PROTOTYPE_NAME_CASES,
} from '../helpers/prototype-color-names.js';

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

  it('a twinkling scene renders the same preview on every call', async () => {
    const compose = () =>
      runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [
          { type: 'rect', x: 8, y: 8, w: 16, h: 16, color: '#ffffff', effect: { name: 'twinkle' } },
        ],
        frames: 8,
        push: false,
      });
    const first = await compose();
    const second = await compose();
    expect(first.isError).toBeFalsy();
    expect(second.content).toEqual(first.content);
    expect(second.structuredContent).toEqual(first.structuredContent);
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

  it('the effect amplitude description names every effect amplitude changes', () => {
    const readsAmplitude = EFFECT_NAMES.filter(
      (name) =>
        JSON.stringify(compileEffect(name, { amplitude: 0.1 }, 12)) !==
        JSON.stringify(compileEffect(name, { amplitude: 1 }, 12)),
    );
    const descriptions = new Set<string>();
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const { properties } = node as { properties?: { amplitude?: { description?: string } } };
      if (properties?.amplitude?.description) descriptions.add(properties.amplitude.description);
      for (const child of Object.values(node)) collect(child);
    };
    collect(z.toJSONSchema(pixooComposeScene.input));

    expect(descriptions.size).toBe(1);
    const [description] = descriptions;
    expect(readsAmplitude.filter((name) => !description?.includes(name))).toEqual([]);
    expect(description).not.toMatch(/fade/);
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
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'asset_not_found' } },
      });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'asset_not_found');
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

  describe('https image elements load from memory, never the temp dir', () => {
    let sources: ImageSources;
    let tmp: Awaited<ReturnType<typeof isolateTmpdir>> | undefined;

    beforeAll(async () => {
      sources = await writeImageSources();
    });

    afterEach(() => {
      tmp?.restore();
      tmp = undefined;
    });

    const scene = (source: string): SceneInput => ({
      background: '#000000',
      elements: [{ type: 'image', source }],
      push: false,
    });

    /** SHA-256 of the preview PNG a push: false scene of one image element returns. */
    async function preview(source: string): Promise<string> {
      const ctx = createMockContext({ errors: pixooComposeScene.errors });
      await pixooComposeScene.handler(pixooComposeScene.input.parse(scene(source)), ctx);
      const [block] = getContentBlocks(ctx);
      const png = Buffer.from((block as { data: string }).data, 'base64');
      return createHash('sha256').update(png).digest('hex');
    }

    it('renders an https source while TMPDIR points at a missing directory', async () => {
      tmp = await isolateTmpdir();
      process.env['TMPDIR'] = path.join(tmp.dir, 'missing');
      const result = await withServedSources(sources, () =>
        runToolContract(pixooComposeScene, scene(sources.png.url)),
      );
      expect(result.isError).toBeFalsy();
      expect(result.content.filter((block) => block.type === 'image')).toHaveLength(1);
    });

    it.each(['png', 'jpeg', 'svg'] as const)(
      'an https %s renders byte-identical to the same local file',
      async (kind) => {
        const local = await preview(sources[kind].file);
        const remote = await withServedSources(sources, () => preview(sources[kind].url));
        expect(remote).toBe(local);
      },
    );

    it('writes nothing to the temp dir, whether the download decodes or not', async () => {
      tmp = await isolateTmpdir();
      const { url } = sources.truncatedJpeg;
      const [decoded, undecodable] = await withServedSources(
        sources,
        async () =>
          [
            await runToolContract(pixooComposeScene, scene(sources.png.url)),
            await runToolContract(pixooComposeScene, scene(url)),
          ] as const,
      );
      expect(decoded.isError).toBeFalsy();
      expect(undecodable.isError).toBe(true);
      // Past the URL itself, the failure names no path.
      const { message } = (undecodable.structuredContent as { error: { message: string } }).error;
      expect(message.split(url).join('')).not.toContain('/');
      expect(await listFiles(tmp.dir)).toEqual([]);
    });
  });

  describe('an image or sprite source that exists but does not decode fails as invalid_image', () => {
    let sources: ImageSources;

    beforeAll(async () => {
      sources = await writeImageSources();
    });

    const render = (elements: SceneInput['elements'], push = false) =>
      withServedSources(sources, () =>
        runToolContract(pixooComposeScene, { background: '#000000', elements, push }),
      );

    it.each([
      ['a local non-image', 'notImage', 'file', NOT_IMAGE_REASON],
      ['a local truncated JPEG', 'truncatedJpeg', 'file', TRUNCATED_JPEG_REASON],
      ['an https non-image body', 'notImage', 'url', NOT_IMAGE_REASON],
      ['an https truncated JPEG', 'truncatedJpeg', 'url', TRUNCATED_JPEG_REASON],
    ] as const)(
      '%s as an image source, naming only the source',
      async (_label, name, via, decoderReason) => {
        const source = sources[name][via];
        const result = await render([{ type: 'image', source }]);
        expectInvalidImage(result, pixooComposeScene.errors, source, decoderReason);
        expect(result.structuredContent).toMatchObject({ error: { data: { source } } });
      },
    );

    it.each([
      ['a local non-image', 'notImage', NOT_IMAGE_REASON],
      ['a local truncated JPEG', 'truncatedJpeg', TRUNCATED_JPEG_REASON],
    ] as const)(
      '%s as a sprite path, naming only the path',
      async (_label, name, decoderReason) => {
        const spritePath = sources[name].file;
        const result = await render([{ type: 'sprite', path: spritePath, cols: 4, rows: 4 }]);
        expectInvalidImage(result, pixooComposeScene.errors, spritePath, decoderReason);
        expect(result.structuredContent).toMatchObject({ error: { data: { path: spritePath } } });
      },
    );

    it('one undecodable sprite among valid images and sprites fails the scene before any push', async () => {
      const client = stubDeviceState();
      const result = await render(
        [
          { type: 'image', source: sources.png.file },
          { type: 'image', source: sources.svg.url },
          { type: 'sprite', path: sources.jpeg.file, cols: 4, rows: 4 },
          { type: 'sprite', path: sources.truncatedJpeg.file, cols: 2, rows: 2 },
        ],
        true,
      );
      expectInvalidImage(
        result,
        pixooComposeScene.errors,
        sources.truncatedJpeg.file,
        TRUNCATED_JPEG_REASON,
      );
      expect(client.push).not.toHaveBeenCalled();
    });

    it.each<[string, SceneInput['elements'][number]]>([
      ['an unreachable https image URL', { type: 'image', source: UNREACHABLE_URL }],
      ['a non-https image URL', { type: 'image', source: 'http://images.test/sources/art.png' }],
      [
        'a sprite path given as a URL',
        { type: 'sprite', path: 'https://images.test/sources/art.png', cols: 4, rows: 4 },
      ],
    ])('%s still fails as asset_not_found, with the declared recovery', async (_label, element) => {
      const result = await render([element]);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'asset_not_found' } },
      });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'asset_not_found');
    });

    it('an image URL over the 10 MiB download cap fails as asset_not_found, with the declared recovery', async () => {
      const url = 'https://images.test/sources/huge.png';
      const http = createFetchMock([
        {
          match: url,
          respond: () =>
            new Response(new Uint8Array(sources.png.bytes), {
              headers: { 'content-length': String(11 * 1024 * 1024) },
            }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [{ type: 'image', source: url }],
          push: false,
        });
        expectForwardedRecovery(result, pixooComposeScene.errors, 'asset_not_found');
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message: 'Image response too large (11534336 bytes; limit: 10485760).',
            data: { url, contentLength: 11534336 },
          },
        });
      } finally {
        http.restore();
      }
    });

    it('a sprite path given as a URL says sprite sheets take an absolute local path', async () => {
      const url = 'https://example.com/art.png';
      const result = await render([{ type: 'sprite', path: url, cols: 2, rows: 1 }]);
      const message = `Sprite sheet path "${url}" is a URL; sprite sheets take an absolute local path.`;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message,
          data: { reason: 'asset_not_found', path: url },
        },
      });
      expect(resultText(result)).toContain(message);
      expectForwardedRecovery(result, pixooComposeScene.errors, 'asset_not_found');
      expect(
        pixooComposeScene.errors?.find((entry) => entry.reason === 'asset_not_found')?.recovery,
      ).toContain('sprite sheets take an absolute local path');
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

  describe('image and icon w/h stay within 1–256, sprite scale within 1–64', () => {
    let source: string;

    beforeEach(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'pixoo-compose-bounds-'));
      source = path.join(dir, 'fixture.png');
      await savePng(new Canvas(64).clear([0, 128, 255]), source);
    });

    const element = (type: 'image' | 'icon', dims: { w?: number; h?: number }) =>
      (type === 'image'
        ? { type, source, ...dims }
        : { type, name: 'heart', ...dims }) as SceneInput['elements'][number];

    it.each<['image' | 'icon', 'w' | 'h', number]>([
      ['image', 'w', 0],
      ['image', 'w', -4],
      ['image', 'h', 0],
      ['image', 'h', -4],
      ['icon', 'w', 0],
      ['icon', 'w', -4],
      ['icon', 'h', 0],
      ['icon', 'h', -4],
      ['image', 'w', 257],
      ['image', 'h', 257],
      ['image', 'w', 4000],
      ['icon', 'w', 257],
      ['icon', 'h', 257],
      ['icon', 'h', 40000],
    ])('%s %s: %i fails input validation as InvalidParams', async (type, field, value) => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [element(type, { [field]: value })],
        push: true,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain(`elements.0.${field}`);
      expect(client.push).not.toHaveBeenCalled();
    });

    it.each<['image' | 'icon', number]>([
      ['image', 1],
      ['icon', 1],
      ['image', 256],
      ['icon', 256],
    ])('%s at %i×%i renders', async (type, size) => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [element(type, { w: size, h: size })],
        push: false,
      });
      expect(result.isError).toBeFalsy();
      const { layout } = result.structuredContent as {
        layout: Array<{ type: string; box: { w: number; h: number } }>;
      };
      expect(layout[0]).toMatchObject({ type, box: { w: size, h: size } });
      expect(resultText(result)).toContain(`${type} @ (`);
      expect(resultText(result)).toContain(`${size}×${size}`);
    });

    const sprite = (scale: number): SceneInput['elements'][number] => ({
      type: 'sprite',
      path: source,
      cols: 2,
      rows: 2,
      x: 0,
      y: 0,
      scale,
    });

    it.each([1, 2, 64])('sprite at scale %i renders at cols × scale', async (scale) => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [sprite(scale)],
        push: false,
      });
      expect(result.isError).toBeFalsy();
      const { layout } = result.structuredContent as {
        layout: Array<{ type: string; box: { w: number; h: number } }>;
      };
      expect(layout[0]).toMatchObject({ type: 'sprite', box: { w: 2 * scale, h: 2 * scale } });
      expect(resultText(result)).toContain(`sprite @ (0,0) ${2 * scale}×${2 * scale}`);
    });

    it.each([65, 1000])(
      'sprite scale %i fails input validation as InvalidParams',
      async (scale) => {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [sprite(scale)],
          push: false,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(resultText(result)).toContain('elements.0.scale');
      },
    );

    const grid = (cols: number, rows: number): SceneInput['elements'][number] => ({
      type: 'sprite',
      path: source,
      cols,
      rows,
      x: 0,
      y: 0,
    });

    it.each<[number, number]>([
      [1, 1],
      [64, 1],
      [1, 64],
      [64, 64],
    ])('sprite grid %i × %i renders', async (cols, rows) => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [grid(cols, rows)],
        push: false,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        layout: [{ type: 'sprite', box: { w: cols, h: rows } }],
      });
      expect(resultText(result)).toContain(`sprite @ (0,0) ${cols}×${rows}`);
    });

    it.each<['cols' | 'rows', number]>([
      ['cols', 65],
      ['rows', 65],
      ['cols', 1024],
      ['rows', 2048],
    ])(
      'sprite %s %i fails input validation as InvalidParams, naming the field',
      async (field, value) => {
        const client = stubDeviceState();
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [{ ...grid(4, 4), [field]: value } as SceneInput['elements'][number]],
          push: true,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(resultText(result)).toContain(`elements.0.${field}`);
        expect(client.push).not.toHaveBeenCalled();
      },
    );

    it.each<[string, 'image' | 'icon', number, boolean]>([
      ['an image 256×256 at the origin', 'image', 256, false],
      ['an icon 256×256 at the origin', 'icon', 256, false],
      ['an image filling the panel', 'image', 64, true],
    ])('%s: layout reports whether it fits, on both surfaces', async (_label, type, size, fits) => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [
          { ...element(type, { w: size, h: size }), x: 0, y: 0 } as SceneInput['elements'][number],
        ],
        push: false,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ layout: [{ fits }] });
      expect(resultText(result)).toContain(`fits:${fits}`);
    });
  });

  describe('Object.prototype names are not icons', () => {
    it.each(Object.getOwnPropertyNames(Object.prototype))(
      'icon name "%s" fails as unknown_icon with its recovery',
      async (name) => {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [{ type: 'icon', name }],
          push: false,
        });
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expectForwardedRecovery(result, pixooComposeScene.errors, 'unknown_icon');
        expect(resultText(result)).toContain(`Unknown icon "${name}"`);
      },
    );

    it('every registered icon still renders, in one scene', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: ICON_NAMES.map((name, i) => ({
          type: 'icon' as const,
          name,
          x: (i % 5) * 13,
          y: Math.floor(i / 5) * 13,
        })),
        push: false,
      });
      expect(result.isError).toBeFalsy();
      const { layout } = result.structuredContent as { layout: Array<{ type: string }> };
      expect(layout.map((entry) => entry.type)).toEqual(ICON_NAMES.map(() => 'icon'));
    });
  });

  describe('image element finish', () => {
    const BACKGROUND: RGB = [16, 16, 16];
    const PALETTE = ['#000000', '#ffffff', '#ff8800'];
    const PALETTE_RGB = ['0,0,0', '255,255,255', '255,136,0'];
    /** A 32×32 image in the top-left corner, then a rect over the bottom-right. */
    const scene = (finish?: Record<string, unknown>): SceneInput => ({
      background: '#101010',
      elements: [
        {
          type: 'image',
          source: photo,
          x: 0,
          y: 0,
          w: 32,
          h: 32,
          fit: 'fill',
          ...(finish && { finish }),
        } as SceneInput['elements'][number],
        { type: 'rect', x: 40, y: 40, w: 16, h: 16, color: '#00aaff' },
      ],
    });

    let photo: string;

    beforeAll(async () => {
      photo = (await writeImageSources()).png.file;
    });

    beforeEach(() => {
      // TEST-NET-1 address: never routable. The device client is a fake regardless.
      process.env['PIXOO_IP'] = '192.0.2.1';
      resetServerConfig();
      initPixooService(fakeConfig, fakeStorage);
    });

    /** Render `input` and push it to a fake device; return the result and the pushed frame. */
    async function pushScene(input: SceneInput) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooComposeScene, { ...input, push: true });
      return { result, client, frame: client.push.mock.calls[0]?.[0] as Canvas | undefined };
    }

    /** Distinct `r,g,b` of the pixels in the image's 32×32 box. */
    function imageColors(frame: Canvas): Set<string> {
      const colors = new Set<string>();
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) colors.add(frame.getPixelRgba(x, y).slice(0, 3).join(','));
      }
      return colors;
    }

    it('without finish, the image renders as the loaded image blitted over the background', async () => {
      const { result, frame } = await pushScene(scene());
      expect(result.isError).toBeFalsy();
      const expected = new Canvas(64).clear(BACKGROUND);
      expected.blit(
        await loadImage(photo, { size: 64, x: 0, y: 0, width: 32, height: 32, fit: 'fill' }),
        0,
        0,
      );
      expected.fillRect(40, 40, 16, 16, [0, 170, 255]);
      expect(hashOf(frame!)).toBe(hashOf(expected));
      const preview = result.content.find((block) => block.type === 'image') as { data: string };
      expect(preview.data).toBe(encodePreviewBlock(expected).data);
    });

    it.each(['none', 'bayer4', 'floyd-steinberg'] as const)(
      'finish: { palette } under dither %s draws only palette colors where the image is opaque; other elements are unaffected',
      async (dither) => {
        const plain = await pushScene(scene());
        const { result, frame } = await pushScene(scene({ palette: PALETTE, dither }));
        expect(result.isError).toBeFalsy();

        const colors = imageColors(frame!);
        expect([...colors].every((rgb) => PALETTE_RGB.includes(rgb))).toBe(true);
        expect(colors.size).toBeGreaterThan(1);
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) {
            if (x < 32 && y < 32) continue;
            expect(frame!.getPixelRgba(x, y)).toEqual(plain.frame!.getPixelRgba(x, y));
          }
        }
      },
    );

    it('finish: { colors: 4 } leaves at most 4 colors in the image', async () => {
      const plain = await pushScene(scene());
      expect(imageColors(plain.frame!).size).toBeGreaterThan(4);
      const { result, frame } = await pushScene(scene({ colors: 4 }));
      expect(result.isError).toBeFalsy();
      expect(imageColors(frame!).size).toBeLessThanOrEqual(4);
    });

    it.each(['#zzzzzz', 'not-a-color'])(
      'a palette entry %j fails as invalid_color',
      async (entry) => {
        const { result, client } = await pushScene(scene({ palette: ['#000000', entry] }));
        expectInvalidColor(result, pixooComposeScene.errors, entry);
        expect(client.push).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Record<string, unknown>, string]>([
      ['both colors and palette', { colors: 8, palette: PALETTE }, 'elements.0.finish: '],
      ['neither colors nor palette', {}, 'elements.0.finish: '],
      ['colors 1', { colors: 1 }, 'elements.0.finish.colors: Too small'],
      ['colors 257', { colors: 257 }, 'elements.0.finish.colors: Too big'],
      ['an empty palette', { palette: [] }, 'elements.0.finish.palette: Too small'],
      [
        'a 257-entry palette',
        { palette: Array(257).fill('#000000') },
        'elements.0.finish.palette: Too big',
      ],
    ])('%s fails input validation (-32602) naming finish', async (_label, finish, named) => {
      const { result, client } = await pushScene(scene(finish));
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain(named);
      expect(client.push).not.toHaveBeenCalled();
    });
  });

  describe('rendered pixels, read from the frames the fake device receives', () => {
    const BLACK: RGB = [0, 0, 0];

    beforeEach(() => {
      // TEST-NET-1 address: never routable. The device client is a fake regardless.
      process.env['PIXOO_IP'] = '192.0.2.1';
      resetServerConfig();
      initPixooService(fakeConfig, fakeStorage);
    });

    /** Render `input` through the tool; return the result and every frame pushed. */
    async function renderFrames(input: Omit<SceneInput, 'push'>) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooComposeScene, { ...input, push: true });
      const animation = client.pushAnimation.mock.calls[0]?.[0] as Canvas[] | undefined;
      const frames = animation ?? client.push.mock.calls.map((call) => call[0] as Canvas);
      return { result, frames };
    }

    it.each(['snow', 'arrow-up', 'arrow-down'])(
      'icon "%s" reaches the pushed frame with its stroke-drawn parts',
      async (name) => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'icon', name, x: 0, y: 0, w: 16, h: 16 }],
        });
        expect(result.isError).toBeFalsy();
        const frame = frames[0]!;
        // A stroke through the icon's center: snow's spoke, the arrow's shaft.
        expect(isInk(frame, 8, 8, BLACK)).toBe(true);
        expect(inkPixels(frame, BLACK).length).toBeGreaterThan(20);
      },
    );

    describe('icon palette', () => {
      const heart = { type: 'icon', name: 'heart', x: 0, y: 0, w: 16, h: 16 } as const;

      it.each(PALETTE_NAMES)(
        'palette %s: the top ink row takes `from`, the bottom ink row `to`',
        async (palette) => {
          const { result, frames } = await renderFrames({
            background: '#000000',
            elements: [{ ...heart, palette }],
          });
          expect(result.isError).toBeFalsy();
          const frame = frames[0]!;
          const rows = inkRows(frame, BLACK);
          expect(rows.length).toBeGreaterThan(2);
          expect(inkColors(frame, rows[0], BLACK)).toEqual([resolveColor(PALETTES[palette].from)]);
          expect(inkColors(frame, rows.at(-1), BLACK)).toEqual([
            resolveColor(PALETTES[palette].to),
          ]);
          expect(result.structuredContent).toMatchObject({
            layout: [{ type: 'icon', box: { x: 0, y: 0, w: 16, h: 16 } }],
          });
          expect(resultText(result)).toContain('icon @ (0,0) 16×16');
        },
      );

      it('an icon with a palette differs from the same icon without one', async () => {
        const plain = await renderFrames({ background: '#000000', elements: [heart] });
        const ramped = await renderFrames({
          background: '#000000',
          elements: [{ ...heart, palette: 'ember' }],
        });
        expect(hashOf(ramped.frames[0]!)).not.toBe(hashOf(plain.frames[0]!));
        expect(inkRows(ramped.frames[0]!, BLACK)).toEqual(inkRows(plain.frames[0]!, BLACK));
      });

      it('palette takes precedence over color', async () => {
        const both = await renderFrames({
          background: '#000000',
          elements: [{ ...heart, palette: 'ice', color: '#ff0000' }],
        });
        const paletteOnly = await renderFrames({
          background: '#000000',
          elements: [{ ...heart, palette: 'ice' }],
        });
        expect(hashOf(both.frames[0]!)).toBe(hashOf(paletteOnly.frames[0]!));
      });

      it('a palette does not excuse an invalid color: it still fails as invalid_color', async () => {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [{ ...heart, palette: 'ice', color: 'notacolor' }],
          push: false,
        });
        expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_color');
      });
    });

    describe('keyframed colors interpolate between keyframes', () => {
      const redToBlue = {
        color: [
          [0, 'red'],
          [2, 'blue'],
        ] as Array<[number, string]>,
      };
      const expected: RGB[][] = [[[255, 0, 0]], [[128, 0, 128]], [[0, 0, 255]]];

      it('a pixels element animated red → blue renders red, purple, then blue', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          frames: 3,
          elements: [
            { type: 'pixels', data: [{ x: 5, y: 5, color: 'white' }], animate: redToBlue },
          ],
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ frames: 3 });
        expect(resultText(result)).toContain('**Frames:** 3');
        expect(frames.map((frame) => frame.getPixelRgba(5, 5))).toEqual([
          [255, 0, 0, 255],
          [128, 0, 128, 255],
          [0, 0, 255, 255],
        ]);
      });

      it.each<[string, SceneInput['elements'][number]]>([
        ['text', { type: 'text', text: 'HI', x: 2, y: 2 }],
        ['icon', { type: 'icon', name: 'stop', x: 2, y: 2 }],
        ['rect', { type: 'rect', x: 2, y: 2, w: 8, h: 8 }],
        ['circle', { type: 'circle', cx: 8, cy: 8, radius: 4 }],
        ['line', { type: 'line', x0: 0, y0: 5, x1: 20, y1: 5 }],
        ['sparkline', { type: 'sparkline', x: 2, y: 2, w: 20, h: 8, data: [1, 3, 2, 5] }],
      ])('a %s element animated red → blue renders every frame in its color', async (_type, el) => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          frames: 3,
          elements: [{ ...el, animate: redToBlue }],
        });
        expect(result.isError).toBeFalsy();
        expect(frames.map((frame) => inkColors(frame, undefined, BLACK))).toEqual(expected);
      });

      it.each([1, 2])(
        'a keyframe color past the last of %i frames that is not a color fails as invalid_color',
        async (frames) => {
          const result = await runToolContract(pixooComposeScene, {
            background: '#000000',
            frames,
            push: false,
            elements: [
              {
                type: 'pixels',
                data: [{ x: 5, y: 5, color: 'white' }],
                animate: {
                  color: [
                    [0, 'red'],
                    [5, 'notacolor'],
                  ],
                },
              },
            ],
          });
          expect(result.structuredContent).toMatchObject({
            error: { code: JsonRpcErrorCode.InvalidParams },
          });
          expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_color');
          expect(resultText(result)).toContain('"notacolor"');
        },
      );

      it('an invalid keyframe color fails as invalid_color with its recovery', async () => {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          frames: 3,
          push: false,
          elements: [
            {
              type: 'pixels',
              data: [{ x: 5, y: 5, color: 'white' }],
              animate: {
                color: [
                  [0, 'red'],
                  [2, 'notacolor'],
                ],
              },
            },
          ],
        });
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_color');
      });
    });

    describe('numeric-string keyframes on opacity, dx, and dy read as the same numbers', () => {
      const square = { type: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#ffffff' } as const;

      it.each<[string, Array<[number, number | string]>, number, number[]]>([
        [
          'numbers',
          [
            [0, 0],
            [4, 100],
          ],
          5,
          [0, 64, 128, 191, 255],
        ],
        [
          'hex-looking strings',
          [
            [0, '000'],
            [4, '100'],
          ],
          5,
          [0, 64, 128, 191, 255],
        ],
        [
          'numeric strings',
          [
            [0, '10'],
            [2, '90'],
          ],
          3,
          [26, 128, 230],
        ],
      ])('opacity keyframes as %s ramp frame by frame', async (_label, opacity, frames, reds) => {
        const { result, frames: pushed } = await renderFrames({
          background: '#000000',
          frames,
          elements: [{ ...square, animate: { opacity } }],
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ frames });
        expect(resultText(result)).toContain(`**Frames:** ${frames}`);
        expect(pushed.map((frame) => frame.getPixelRgba(0, 0)[0])).toEqual(reds);
      });

      it.each(['dx', 'dy'] as const)(
        '%s keyframes as numeric strings move the element exactly as numbers do',
        async (prop) => {
          const render = (track: Array<[number, number | string]>) =>
            renderFrames({
              background: '#000000',
              frames: 5,
              elements: [{ ...square, x: 20, y: 20, animate: { [prop]: track } }],
            });
          const numbers = await render([
            [0, -8],
            [4, 8],
          ]);
          const strings = await render([
            [0, '-8'],
            [4, '8'],
          ]);
          expect(strings.result.isError).toBeFalsy();
          expect(new Set(numbers.frames.map(hashOf)).size).toBe(5);
          expect(strings.frames.map(hashOf)).toEqual(numbers.frames.map(hashOf));
        },
      );
    });

    describe('a visible track shows and hides the element on boolean keyframes', () => {
      const square = { type: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#ffffff' } as const;

      it.each<[string, Array<[number, boolean]>, number[]]>([
        [
          'true → false',
          [
            [0, true],
            [4, false],
          ],
          [255, 255, 0, 0, 0],
        ],
        [
          'false → true → false',
          [
            [0, false],
            [2, true],
            [4, false],
          ],
          [0, 255, 255, 0, 0],
        ],
      ])('%s switches at the midpoint between keyframes', async (_label, visible, reds) => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          frames: 5,
          elements: [{ ...square, animate: { visible } }],
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ frames: 5 });
        expect(resultText(result)).toContain('**Frames:** 5');
        expect(frames.map((frame) => frame.getPixelRgba(0, 0)[0])).toEqual(reds);
      });
    });

    describe('line sparkline', () => {
      it('inks exactly its w × h box', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'sparkline', x: 0, y: 0, w: 20, h: 8, data: [1, 2] }],
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          layout: [{ type: 'sparkline', box: { x: 0, y: 0, w: 20, h: 8 }, fits: true }],
        });
        expect(resultText(result)).toContain('sparkline @ (0,0) 20×8 fits:true');
        const frame = frames[0]!;
        expect(isInk(frame, 19, 0, BLACK)).toBe(true);
        expect(isInk(frame, 0, 7, BLACK)).toBe(true);
        expect(isInk(frame, 20, 0, BLACK)).toBe(false);
        expect(isInk(frame, 0, 8, BLACK)).toBe(false);
      });

      it('flush to the bottom-right corner, fits and draws its first and last points', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'sparkline', x: 44, y: 56, w: 20, h: 8, data: [1, 5, 2, 9] }],
        });
        expect(result.structuredContent).toMatchObject({
          layout: [{ type: 'sparkline', box: { x: 44, y: 56, w: 20, h: 8 }, fits: true }],
        });
        expect(resultText(result)).toContain('sparkline @ (44,56) 20×8 fits:true');
        // The lowest value sits on the bottom row, the highest in the top-right corner.
        expect(isInk(frames[0]!, 44, 63, BLACK)).toBe(true);
        expect(isInk(frames[0]!, 63, 56, BLACK)).toBe(true);
      });
    });

    it('the music icon reaches the pushed frame with its beam joining both stems', async () => {
      const { result, frames } = await renderFrames({
        background: '#000000',
        elements: [{ type: 'icon', name: 'music', w: 16, h: 16 }],
      });
      expect(result.structuredContent).toMatchObject({
        layout: [{ type: 'icon', box: { x: 0, y: 0, w: 16, h: 16 }, fits: true }],
      });
      expect(resultText(result)).toContain('icon @ (0,0) 16×16 fits:true');
      const beam = Array.from({ length: 11 }, (_, i) => 2 + i);
      expect(beam.filter((x) => !isInk(frames[0]!, x, 3, BLACK))).toEqual([]);
    });

    describe('blend, stroke width, and anti-aliasing', () => {
      const under = { type: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#640000' } as const;

      it.each<['normal' | 'add' | 'screen' | 'multiply', number]>([
        ['normal', 200],
        ['add', 255],
        ['screen', 222],
        ['multiply', 78],
      ])('a #c80000 rect blended %s over #640000 pushes [%i, 0, 0]', async (blend, red) => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [under, { type: 'rect', x: 4, y: 4, w: 8, h: 8, color: '#c80000', blend }],
        });
        expect(result.isError).toBeFalsy();
        expect(frames[0]!.getPixelRgba(6, 6)).toEqual([red, 0, 0, 255]);
        expect(frames[0]!.getPixelRgba(1, 1)).toEqual([100, 0, 0, 255]);
      });

      it('a line at strokeWidth 3 lights three rows and reports its box on both surfaces', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'line', x0: 2, y0: 10, x1: 20, y1: 10, strokeWidth: 3 }],
        });
        expect(inkRows(frames[0]!, BLACK)).toEqual([9, 10, 11]);
        expect(result.structuredContent).toMatchObject({
          layout: [{ type: 'line', box: { x: 2, y: 9, w: 19, h: 3 }, fits: true }],
        });
        expect(resultText(result)).toContain('line @ (2,9) 19×3 fits:true');
      });

      it('a wide line on the bottom row does not fit, on both surfaces', async () => {
        const { result } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'line', x0: 2, y0: 63, x1: 20, y1: 63, strokeWidth: 3 }],
        });
        expect(result.structuredContent).toMatchObject({
          layout: [{ type: 'line', box: { x: 2, y: 62, w: 19, h: 3 }, fits: false }],
        });
        expect(resultText(result)).toContain('line @ (2,62) 19×3 fits:false');
      });

      it('an outline circle at strokeWidth 3 reports the box of its ring', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [{ type: 'circle', cx: 32, cy: 32, radius: 10, fill: false, strokeWidth: 3 }],
        });
        expect(isInk(frames[0]!, 21, 32, BLACK)).toBe(true);
        expect(isInk(frames[0]!, 43, 32, BLACK)).toBe(true);
        expect(isInk(frames[0]!, 24, 32, BLACK)).toBe(false);
        expect(result.structuredContent).toMatchObject({
          layout: [{ type: 'circle', box: { x: 21, y: 21, w: 23, h: 23 }, fits: true }],
        });
        expect(resultText(result)).toContain('circle @ (21,21) 23×23 fits:true');
      });

      it('a rect border at strokeWidth 2 grows inward and keeps the rect box', async () => {
        const { result, frames } = await renderFrames({
          background: '#000000',
          elements: [
            { type: 'rect', x: 10, y: 10, w: 10, h: 6, borderColor: '#ffffff', strokeWidth: 2 },
          ],
        });
        expect(inkPixels(frames[0]!, BLACK)).toHaveLength(48);
        expect(isInk(frames[0]!, 12, 12, BLACK)).toBe(false);
        expect(resultText(result)).toContain('rect @ (10,10) 10×6 fits:true');
      });

      it('an anti-aliased line shades its edge pixels, at their coverage × opacity', async () => {
        const line = {
          type: 'line',
          x0: 0,
          y0: 0,
          x1: 20,
          y1: 20,
          color: '#ffffff',
          antialias: true,
        } as const;
        const full = await renderFrames({ background: '#000000', elements: [line] });
        const half = await renderFrames({
          background: '#000000',
          elements: [{ ...line, opacity: 50 }],
        });
        expect(full.frames[0]!.getPixelRgba(10, 9)).toEqual([53, 53, 53, 255]);
        expect(half.frames[0]!.getPixelRgba(10, 9)).toEqual([27, 27, 27, 255]);
      });

      it('strokeWidth, antialias, and blend at their defaults render as though omitted', async () => {
        const plain: SceneInput['elements'] = [
          { type: 'line', x0: 2, y0: 3, x1: 40, y1: 20 },
          { type: 'circle', cx: 30, cy: 40, radius: 8, fill: false },
          { type: 'rect', x: 44, y: 4, w: 12, h: 10, color: '#224488', borderColor: '#ffffff' },
          { type: 'text', text: 'OK', x: 2, y: 50 },
        ];
        const defaults: SceneInput['elements'] = [
          { ...plain[0]!, strokeWidth: 1, antialias: false, blend: 'normal' },
          { ...plain[1]!, strokeWidth: 1, antialias: false, blend: 'normal' },
          { ...plain[2]!, strokeWidth: 1, blend: 'normal' },
          { ...plain[3]!, blend: 'normal' },
        ] as SceneInput['elements'];
        const a = await renderFrames({ background: '#000000', elements: plain });
        const b = await renderFrames({ background: '#000000', elements: defaults });
        expect(b.result.isError).toBeFalsy();
        expect(hashOf(b.frames[0]!)).toBe(hashOf(a.frames[0]!));
        expect(b.result.structuredContent).toEqual(a.result.structuredContent);
      });
    });
  });

  describe('blend and stroke fields are validated where they draw', () => {
    /** Run one element through the tool; its input is deliberately untyped. */
    function composeOne(element: unknown) {
      const client = stubDeviceState();
      const result = runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [element as SceneInput['elements'][number]],
        push: true,
      });
      return { client, result };
    }

    it.each<[string, Record<string, unknown>, string]>([
      [
        'strokeWidth on a circle that fills by default',
        { type: 'circle', cx: 10, cy: 10, radius: 4, strokeWidth: 2 },
        'strokeWidth',
      ],
      [
        'strokeWidth on a filled circle',
        { type: 'circle', cx: 10, cy: 10, radius: 4, fill: true, strokeWidth: 1 },
        'strokeWidth',
      ],
      [
        'antialias on a filled circle',
        { type: 'circle', cx: 10, cy: 10, radius: 4, antialias: true },
        'antialias',
      ],
      [
        'antialias: false on a filled circle',
        { type: 'circle', cx: 10, cy: 10, radius: 4, fill: true, antialias: false },
        'antialias',
      ],
      [
        'strokeWidth on a rect without borderColor',
        { type: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffffff', strokeWidth: 2 },
        'strokeWidth',
      ],
      [
        'strokeWidth 0 on a line',
        { type: 'line', x0: 0, y0: 0, x1: 8, y1: 8, strokeWidth: 0 },
        'strokeWidth',
      ],
      [
        'a fractional strokeWidth on a line',
        { type: 'line', x0: 0, y0: 0, x1: 8, y1: 8, strokeWidth: 1.5 },
        'strokeWidth',
      ],
      [
        'an unknown blend mode',
        { type: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffffff', blend: 'overlay' },
        'blend',
      ],
    ])('%s fails -32602 naming the field, before any push', async (_label, element, field) => {
      const { client, result } = composeOne(element);
      const failed = await result;
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(failed)).toContain(`elements.0.${field}`);
      expect(JSON.stringify(failed.structuredContent)).toContain(field);
      expect(client.push).not.toHaveBeenCalled();
    });

    it.each(['normal', 'add', 'screen', 'multiply'] as const)(
      'blend %s is accepted on every element type',
      (blend) => {
        const elements = [
          { type: 'text', text: 'A' },
          { type: 'icon', name: 'heart' },
          { type: 'rect', x: 0, y: 0, w: 2, h: 2 },
          { type: 'circle', cx: 4, cy: 4, radius: 2 },
          { type: 'line', x0: 0, y0: 0, x1: 4, y1: 4 },
          { type: 'progress', x: 0, y: 0, w: 8, h: 2, value: 1, max: 2 },
          { type: 'sparkline', x: 0, y: 0, w: 8, h: 4, data: [1, 2] },
          { type: 'bitmap', x: 0, y: 0, rows: ['1'], palette: ['#000', '#fff'] },
          { type: 'pixels', data: [] },
          { type: 'image', source: '/tmp/a.png' },
          { type: 'sprite', path: '/tmp/a.png', cols: 1, rows: 1 },
        ].map((el) => ({ ...el, blend }));
        const parsed = pixooComposeScene.input.parse({ background: '#000000', elements });
        expect(parsed.elements.map((el) => el.blend)).toEqual(elements.map(() => blend));
      },
    );
  });

  describe('an empty animate track', () => {
    const rect = { type: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ffffff' } as const;

    it.each(['opacity', 'dx', 'dy', 'visible', 'color'])(
      'an empty %s track fails input validation as invalid_arguments, naming the field',
      async (prop) => {
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: [{ ...rect, animate: { [prop]: [] } }],
          push: false,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(JSON.stringify(result.structuredContent)).toContain(`elements.0.animate.${prop}`);
        expect(resultText(result)).toContain(`elements.0.animate.${prop}`);
        expect(resultText(result)).toContain('(reason invalid_arguments)');
      },
    );

    it('names the empty track even beside valid tracks, on a later element', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        frames: 3,
        elements: [
          { ...rect, animate: { opacity: [[0, 50]] } },
          {
            ...rect,
            x: 10,
            animate: {
              dx: [
                [0, 0],
                [2, 4],
              ],
              color: [],
            },
          },
        ],
        push: false,
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain('elements.1.animate.color');
      expect(resultText(result)).not.toContain('invalid_color');
      expect(resultText(result)).not.toContain('elements.0');
      expect(resultText(result)).not.toContain('animate.dx');
    });

    it('a one-keyframe track is still accepted and holds its value', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ ...rect, animate: { opacity: [[0, 50]] } }],
        push: false,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ frames: 1 });
    });
  });

  describe('animate track values by property', () => {
    const rect = { type: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffffff' } as const;

    /** Run one element through the tool without a push; its input is deliberately untyped. */
    function composeOne(element: unknown, frames = 1) {
      return runToolContract(pixooComposeScene, {
        background: '#000000',
        frames,
        elements: [element as SceneInput['elements'][number]],
        push: false,
      });
    }

    it('a boolean color keyframe fails as invalid_color, as any other non-color value does', async () => {
      const result = await composeOne({ ...rect, animate: { color: [[0, true]] } });
      expectForwardedRecovery(result, pixooComposeScene.errors, 'invalid_color');
      expect(resultText(result)).toContain('"true"');
    });

    it('a track under a key no element animates is accepted and leaves the render unchanged', async () => {
      const plain = await composeOne(rect);
      const extra = await composeOne({ ...rect, animate: { scale: [[0, 'anything']] } });
      expect(extra.isError).toBeFalsy();
      expect(extra.structuredContent).toEqual(plain.structuredContent);
      // Text and preview image alike.
      expect(extra.content).toEqual(plain.content);
    });

    /** Assert `result` is a -32602 `invalid_arguments` failure naming `field` on both surfaces. */
    function expectInvalidArguments(result: Awaited<ReturnType<typeof composeOne>>, field: string) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(JSON.stringify(result.structuredContent)).toContain(field);
      expect(resultText(result)).toContain(field);
      expect(resultText(result)).toContain('(reason invalid_arguments)');
    }

    // A string that isn't numeric fails the refinement; a boolean fails both union branches.
    const NOT_NUMERIC = 'Expected a number or a numeric string';
    const RECEIVED_BOOLEAN = 'expected number, received boolean';
    const NOT_BOOLEAN = 'expected boolean';

    it.each<[string, Record<string, unknown>, string, string]>([
      [
        'a word on opacity',
        { ...rect, w: 64, h: 64, opacity: 20, animate: { opacity: [[0, 'half']] } },
        'opacity',
        NOT_NUMERIC,
      ],
      ['a word on dx', { ...rect, animate: { dx: [[0, 'left']] } }, 'dx', NOT_NUMERIC],
      [
        'a word on dy, on text',
        { type: 'text', text: 'HI', animate: { dy: [[0, 'up']] } },
        'dy',
        NOT_NUMERIC,
      ],
      [
        'the string "false" on visible',
        { ...rect, animate: { visible: [[0, 'false']] } },
        'visible',
        NOT_BOOLEAN,
      ],
      [
        'numbers on visible',
        {
          ...rect,
          animate: {
            visible: [
              [0, 1],
              [2, 0],
            ],
          },
        },
        'visible',
        NOT_BOOLEAN,
      ],
      [
        'the string "1" on visible',
        { ...rect, animate: { visible: [[0, '1']] } },
        'visible',
        NOT_BOOLEAN,
      ],
      [
        'a boolean on opacity',
        { ...rect, animate: { opacity: [[0, true]] } },
        'opacity',
        RECEIVED_BOOLEAN,
      ],
      ['a boolean on dx', { ...rect, animate: { dx: [[0, false]] } }, 'dx', RECEIVED_BOOLEAN],
      ['an empty string on dy', { ...rect, animate: { dy: [[0, '']] } }, 'dy', NOT_NUMERIC],
      [
        'a blank string on opacity',
        { ...rect, animate: { opacity: [[0, '  ']] } },
        'opacity',
        NOT_NUMERIC,
      ],
      ['"Infinity" on dx', { ...rect, animate: { dx: [[0, 'Infinity']] } }, 'dx', NOT_NUMERIC],
      ['a color on dy', { ...rect, animate: { dy: [[0, '#ff0000']] } }, 'dy', NOT_NUMERIC],
    ])(
      '%s fails input validation as invalid_arguments, naming the field',
      async (_label, el, prop, message) => {
        const result = await composeOne(el, 3);
        expectInvalidArguments(result, `elements.0.animate.${prop}.0.1`);
        expect(resultText(result)).toContain(message);
      },
    );

    it('names the bad keyframe deep in a later element, beside valid tracks', async () => {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        frames: 5,
        push: false,
        elements: [
          { ...rect, animate: { opacity: [[0, '40']], visible: [[0, true]] } },
          {
            ...rect,
            x: 10,
            animate: {
              dx: [
                [0, 0],
                [2, '4'],
              ],
              dy: [
                [0, 0],
                [2, '-2'],
                [4, 'down'],
              ],
              color: [[0, 'red']],
            },
          },
        ],
      });
      expectInvalidArguments(result, 'elements.1.animate.dy.2.1');
      expect(resultText(result)).not.toContain('elements.0');
      expect(resultText(result)).not.toContain('animate.dx');
      expect(resultText(result)).not.toContain('animate.color');
    });

    it.each<['dx' | 'dy' | 'opacity', string, [string, string], [number, number]]>([
      ['opacity', 'plain', ['40', '80'], [40, 80]],
      ['opacity', 'zero-padded', ['040', '080'], [40, 80]],
      ['opacity', 'space-padded and exponent', [' 40 ', '8e1'], [40, 80]],
      ['opacity', 'decimal', ['40.5', '79.5'], [40.5, 79.5]],
      ['dx', 'signed', ['-8', '+8'], [-8, 8]],
      ['dy', 'space-padded and exponent', [' -4 ', '4e0'], [-4, 4]],
    ])(
      '%s keyframes as %s numeric strings are accepted and render as their numbers',
      async (prop, _label, [from, to], [n0, n1]) => {
        const scene = (a: string | number, b: string | number) =>
          composeOne(
            {
              ...rect,
              x: 20,
              y: 20,
              animate: {
                [prop]: [
                  [0, a],
                  [2, b],
                ],
              },
            },
            3,
          );
        const [strings, numbers] = await Promise.all([scene(from, to), scene(n0, n1)]);
        expect(strings.isError).toBeFalsy();
        expect(strings.structuredContent).toMatchObject({ frames: 3 });
        expect(resultText(strings)).toContain('**Frames:** 3');
        // Same layout, same text, same preview pixels.
        expect(strings.structuredContent).toEqual(numbers.structuredContent);
        expect(strings.content).toEqual(numbers.content);
      },
    );
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

  describe('an Object.prototype name is not a color', () => {
    const square = { type: 'rect', x: 0, y: 0, w: 8, h: 8 } as const;
    const render = (scene: Partial<SceneInput>) =>
      runToolContract(pixooComposeScene, {
        background: '#ffffff',
        elements: [{ ...square, color: 'red' }],
        push: false,
        ...scene,
      });

    it.each(PROTOTYPE_COLOR_INPUTS)('element color %j fails as invalid_color', async (name) => {
      const result = await render({ elements: [{ ...square, color: name }] });
      expectInvalidColor(result, pixooComposeScene.errors, name);
    });

    it.each(PROTOTYPE_NAME_CASES)('background %j fails as invalid_color', async (name) => {
      expectInvalidColor(await render({ background: name }), pixooComposeScene.errors, name);
    });

    it.each(PROTOTYPE_NAME_CASES)('color keyframe %j fails as invalid_color', async (name) => {
      const result = await render({
        frames: 3,
        elements: [
          {
            ...square,
            animate: {
              color: [
                [0, 'red'],
                [2, name],
              ],
            },
          },
        ],
      });
      expectInvalidColor(result, pixooComposeScene.errors, name);
    });

    it('named and hex colors still resolve on those surfaces', async () => {
      const client = stubDeviceState();
      const result = await render({
        background: 'Navy',
        frames: 3,
        push: true,
        elements: [
          { ...square, color: 'ORANGE' },
          { ...square, x: 8, color: '#0f0' },
          {
            ...square,
            x: 16,
            animate: {
              color: [
                [0, 'Red'],
                [2, '#0000ff'],
              ],
            },
          },
        ],
      });
      expect(result.isError).toBeFalsy();
      const frames = client.pushAnimation.mock.calls[0]?.[0] as Canvas[];
      const rgbAt = (frame: number, x: number, y: number) =>
        frames[frame]?.getPixelRgba(x, y).slice(0, 3);
      expect(rgbAt(2, 40, 40)).toEqual([0, 0, 128]);
      expect(rgbAt(2, 0, 0)).toEqual([255, 165, 0]);
      expect(rgbAt(2, 8, 0)).toEqual([0, 255, 0]);
      expect(rgbAt(0, 16, 0)).toEqual([255, 0, 0]);
      expect(rgbAt(2, 16, 0)).toEqual([0, 0, 255]);
    });
  });

  type TextElementInput = Extract<SceneInput['elements'][number], { type: 'text' }>;
  type Entry = {
    action: string;
    box: { x: number; y: number; w: number; h: number };
    fits: boolean;
    font?: string;
    scale?: number;
  };
  const layoutOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { layout: Entry[] }).layout;

  /** Compose `elements` over black and push to a fake device; return the result and the frame. */
  async function pushScene(elements: TextElementInput[]) {
    const client = stubDeviceState();
    const result = await runToolContract(pixooComposeScene, {
      background: '#000000',
      elements,
      push: true,
    });
    expect(result.isError).toBeFalsy();
    expect(client.push).toHaveBeenCalledOnce();
    return { result, frame: client.push.mock.calls[0]?.[0] as Canvas };
  }

  /** The ink the toolkit draws for `text` in `face` at (`x`, `y`), white on an empty canvas. */
  function toolkitInk(text: string, face: BitmapFont, x = 0, y = 0): string[] {
    const canvas = new Canvas(64);
    drawText(canvas, text, x, y, [255, 255, 255], { font: face });
    return inkPixels(canvas);
  }

  describe('printable ASCII in text elements renders exactly as it did under toolkit 0.8.2', () => {
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

    /** Push a scene of `elements`; return each layout entry as a line and the pushed frame's hash. */
    async function pushedFrame(elements: TextElementInput[]) {
      const pushed: Canvas[] = [];
      const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
      vi.spyOn(getPixooService(), 'pushFrame').mockImplementation(async (canvas) => {
        pushed.push(canvas);
        return fakeDeviceState;
      });
      const result = await pixooComposeScene.handler(
        pixooComposeScene.input.parse({ background: '#102030', elements, push: true }),
        createMockContext({ errors: pixooComposeScene.errors }),
      );
      expect(pushed).toHaveLength(1);
      return {
        layout: result.layout.map(
          (e) =>
            `${e.action} ${e.font} @${e.box.x},${e.box.y} ${e.box.w}x${e.box.h} fits:${e.fits}`,
        ),
        pushed: createHash('sha256').update(Buffer.from(pushed[0]!.buffer)).digest('hex'),
      };
    }

    it('standard, flat color, one line every 7 rows', async () => {
      const elements = STANDARD.map((text, i) => ({
        type: 'text' as const,
        text,
        x: 0,
        y: i * 7,
        font: 'standard' as const,
        color: '#ffa500',
      }));
      expect(await pushedFrame(elements)).toEqual({
        layout: [
          'none standard @0,0 60x7 fits:true',
          'none standard @0,7 59x7 fits:true',
          'none standard @0,14 62x7 fits:true',
          'none standard @0,21 63x7 fits:true',
          'none standard @0,28 59x7 fits:true',
          'none standard @0,35 59x7 fits:true',
          'none standard @0,42 59x7 fits:true',
          'none standard @0,49 59x7 fits:true',
          'none standard @0,56 27x7 fits:true',
        ],
        pushed: '51e18ba245467cc0fa8db518c946d54cf7ea99b5bf1a6f474f28508e833cb7fa',
      });
    });

    it('compact, palette ramp, right-aligned', async () => {
      const elements = COMPACT.map((text, i) => ({
        type: 'text' as const,
        text,
        x: 'right' as const,
        y: i * 6 + 1,
        font: 'compact' as const,
        style: { palette: 'claude' as const },
      }));
      expect(await pushedFrame(elements)).toEqual({
        layout: [
          'none compact @2,1 62x5 fits:true',
          'none compact @0,7 64x5 fits:true',
          'none compact @1,13 63x5 fits:true',
          'none compact @0,19 64x5 fits:true',
          'none compact @0,25 64x5 fits:true',
          'none compact @27,31 37x5 fits:true',
        ],
        pushed: 'c897e82922c5ce5bf6077ceca31e1534e4c3db8ea116d805111bf8f3f59d7309',
      });
    });
  });

  describe('the non-ASCII glyphs in standard and compact text elements', () => {
    const FACES = { standard: FONT_5x7, compact: FONT_3x5 } as const;

    it.each([
      ['72°F', 'standard', '72?F'],
      ['72°F', 'compact', '72?F'],
      ['▲3 ▼2', 'standard', '?3 ?2'],
      ['▲3 ▼2', 'compact', '?3 ?2'],
    ] as const)('%s draws its own glyphs in %s, not %s', async (text, font, asQuestionMarks) => {
      const { result, frame } = await pushScene([
        { type: 'text', text, font, x: 0, y: 0, color: '#ffffff' },
      ]);
      const ink = inkPixels(frame, [0, 0, 0]);
      expect(ink).toEqual(toolkitInk(text, FACES[font]));
      expect(ink).not.toEqual(toolkitInk(asQuestionMarks, FACES[font]));
      expect(layoutOf(result)[0]).toMatchObject({ font, fits: true });
    });
  });

  describe('text elements in the numerals font', () => {
    it('render 12:45 as a 58×18 box in the 11×18 face, reported as numerals on both surfaces', async () => {
      const { result, frame } = await pushScene([
        { type: 'text', text: '12:45', font: 'numerals', x: 'center', y: 'center' },
      ]);
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

    it('with font omitted, 12:45 lays out in standard', async () => {
      const { result } = await pushScene([{ type: 'text', text: '12:45' }]);
      expect(layoutOf(result)[0]).toMatchObject({
        font: 'standard',
        box: { x: 0, y: 0, w: measureText('12:45', { font: FONT_5x7 }), h: 7 },
      });
      expect(resultText(result)).toContain('font:standard');
    });

    it('at scale 2, 12:45 (116 px) stays in numerals and reports that it does not fit', async () => {
      const { result } = await pushScene([
        { type: 'text', text: '12:45', font: 'numerals', style: { scale: 2 } },
      ]);
      expect(layoutOf(result)[0]).toMatchObject({
        font: 'numerals',
        fits: false,
        scale: 2,
        box: { x: 0, y: 0, w: 116, h: 36 },
      });
    });

    it('pairs with a standard label: the unit renders beside the numerals, each in its own face', async () => {
      const { result } = await pushScene([
        { type: 'text', text: '72°', font: 'numerals', x: 2, y: 2 },
        { type: 'text', text: 'F', x: 38, y: 2 },
      ]);
      expect(layoutOf(result).map((e) => [e.font, e.box.w, e.box.h])).toEqual([
        ['numerals', 34, 18],
        ['standard', 5, 7],
      ]);
    });

    it.each([
      [0, '72°F', '"F"'],
      [1, 'am', '"a", "m"'],
    ] as const)(
      'element %i text %j in numerals fails -32602 naming %s; nothing is rendered or pushed',
      async (index, text, named) => {
        const client = stubDeviceState();
        const numerals: TextElementInput = { type: 'text', text, font: 'numerals' };
        const label: TextElementInput = { type: 'text', text: 'ok', y: 40 };
        const result = await runToolContract(pixooComposeScene, {
          background: '#000000',
          elements: index === 0 ? [numerals, label] : [label, numerals],
          push: true,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
        expect(resultText(result)).toContain(`elements.${index}.text`);
        expect(resultText(result)).toContain(`Characters not in the numerals font: ${named}.`);
        expect(result.content.some((block) => block.type === 'image')).toBe(false);
        expect(client.push).not.toHaveBeenCalled();
        expect(client.pushAnimation).not.toHaveBeenCalled();
      },
    );

    it('the same text is accepted in standard and compact', async () => {
      const { result } = await pushScene([
        { type: 'text', text: '72°F am', font: 'standard' },
        { type: 'text', text: '72°F am', font: 'compact', y: 10 },
      ]);
      expect(layoutOf(result).map((e) => e.font)).toEqual(['standard', 'compact']);
    });

    it('animates in the numerals face under an effect', async () => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        frames: 4,
        elements: [
          { type: 'text', text: '12', font: 'numerals', x: 2, y: 2, effect: { name: 'float' } },
        ],
        push: true,
      });
      expect(result.isError).toBeFalsy();
      const frames = client.pushAnimation.mock.calls[0]?.[0] as Canvas[];
      expect(frames).toHaveLength(4);
      for (const frame of frames) {
        const rows = inkRows(frame, [0, 0, 0]);
        expect(rows.at(-1)! - rows[0]! + 1).toBe(18);
      }
    });
  });
});
