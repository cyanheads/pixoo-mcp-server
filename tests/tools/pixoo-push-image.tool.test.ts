/**
 * @fileoverview Tests for the pixoo_push_image tool handler.
 * @module tests/tools/pixoo-push-image.tool.test
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Canvas, canvasToPng, loadAnimation, loadImage, savePng } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooPushImage } from '@/mcp-server/tools/definitions/pixoo-push-image.tool.js';
import { buildContactSheet, encodePreviewBlock } from '@/renderer/preview.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import { hashOf, inkColors } from '../helpers/canvas-ink.js';
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
  animatedImage,
  expectInvalidImage,
  type ImageSources,
  NOT_IMAGE_REASON,
  TRUNCATED_JPEG_REASON,
  tiffPyramid,
  UNREACHABLE_URL,
  withServedSources,
  writeImageSources,
} from '../helpers/image-sources.js';
import { expectInvalidColor, PROTOTYPE_NAME_CASES } from '../helpers/prototype-color-names.js';
import { trickleRoute } from '../helpers/trickle-body.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeDeviceState = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

/** Absolute path to a real 64×64 PNG fixture written once before the suite. */
let fixturePath: string;

describe('pixooPushImage', () => {
  beforeEach(async () => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);

    // Build a tiny 64×64 fixture PNG so the handler can loadImage without a real file.
    if (!fixturePath) {
      const canvas = new Canvas(64);
      canvas.clear([0, 128, 255]);
      fixturePath = path.join(os.tmpdir(), `pixoo-test-fixture-${Date.now()}.png`);
      await savePng(canvas, fixturePath);
    }
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

  it('happy path with local fixture — push:false returns pushed:false', async () => {
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: fixturePath,
      push: false,
    });
    const result = await pixooPushImage.handler(input, ctx);

    expect(result.pushed).toBe(false);
    expect(result.deviceState).toBeUndefined();
    // The downsampled result rides content[], never structuredContent.
    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: expect.any(String), mimeType: 'image/png' },
    ]);
    expect(result).not.toHaveProperty('previewData');
  });

  it('push:true calls pushFrame and returns deviceState', async () => {
    await stubPush();
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: fixturePath,
      push: true,
    });
    const result = await pixooPushImage.handler(input, ctx);

    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('asset_not_found error when file does not exist', async () => {
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: '/tmp/pixoo-nonexistent-file-xyz-12345.png',
      push: false,
    });
    await expect(pixooPushImage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'asset_not_found' },
    });
  });

  it('asset_not_found forwards the declared recovery on both surfaces', async () => {
    const result = await runToolContract(pixooPushImage, {
      source: '/tmp/pixoo-nonexistent-file-xyz-12345.png',
      push: false,
    });
    expectForwardedRecovery(result, pixooPushImage.errors, 'asset_not_found');
    expect(result.structuredContent).toMatchObject({
      error: { data: { path: '/tmp/pixoo-nonexistent-file-xyz-12345.png' } },
    });
  });

  it('a file that exists but cannot be read fails as asset_not_found, not invalid_image', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-unreadable-'));
    const source = path.join(dir, 'locked.png');
    await fs.copyFile(fixturePath, source);
    await fs.chmod(source, 0o000);
    try {
      const result = await runToolContract(pixooPushImage, { source, push: false });
      expectForwardedRecovery(result, pixooPushImage.errors, 'asset_not_found');
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { path: source } },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('device failures on push reach both surfaces through the contract', () => {
    it('device_unreachable carries retryable: true', async () => {
      failDevicePush({ ok: false, kind: 'network', message: 'connect EHOSTUNREACH' });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_unreachable', true);
    });

    it.each([
      [503, true],
      [404, false],
    ])('device_http_error (HTTP %i) is declared, retryable: %s', async (status, retryable) => {
      failDevicePush({ ok: false, kind: 'http', status, message: `HTTP ${status}` });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_http_error', retryable);
    });

    it('device_rejected carries no retryable key', async () => {
      failDevicePush({ ok: false, kind: 'device', deviceCode: 1, message: 'error_code 1' });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_rejected', undefined);
    });
  });

  it('a cancelled call tears down its URL download and pushes nothing', async () => {
    const url = 'https://images.test/slow-push.png';
    const controller = new AbortController();
    const { route, state } = trickleRoute(url, new Uint8Array(200 * 1024), {
      onChunk: (n) => n === 3 && controller.abort(),
    });
    const http = createFetchMock([route]);
    const client = stubDeviceState();
    http.install();
    try {
      const ctx = createMockContext({ errors: pixooPushImage.errors, signal: controller.signal });
      await expect(
        pixooPushImage.handler(pixooPushImage.input.parse({ source: url, push: true }), ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThan(10);
      expect(client.push).not.toHaveBeenCalled();
    } finally {
      http.restore();
    }
  });

  describe('https sources load from memory, never the temp dir', () => {
    let sources: ImageSources;
    let tmp: Awaited<ReturnType<typeof isolateTmpdir>> | undefined;

    beforeAll(async () => {
      sources = await writeImageSources();
    });

    afterEach(() => {
      tmp?.restore();
      tmp = undefined;
    });

    /** SHA-256 of the preview PNG a push: false call returns for `source`. */
    async function preview(source: string): Promise<string> {
      const ctx = createMockContext({ errors: pixooPushImage.errors });
      await pixooPushImage.handler(pixooPushImage.input.parse({ source, push: false }), ctx);
      const [block] = getContentBlocks(ctx);
      const png = Buffer.from((block as { data: string }).data, 'base64');
      return createHash('sha256').update(png).digest('hex');
    }

    it('renders an https source while TMPDIR points at a missing directory', async () => {
      tmp = await isolateTmpdir();
      process.env['TMPDIR'] = path.join(tmp.dir, 'missing');
      const result = await withServedSources(sources, () =>
        runToolContract(pixooPushImage, { source: sources.png.url, push: false }),
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
            await runToolContract(pixooPushImage, { source: sources.png.url, push: false }),
            await runToolContract(pixooPushImage, { source: url, push: false }),
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

  describe('animated GIF and WebP sources push as animations', () => {
    const PLACEMENT = { size: 64, fit: 'contain', kernel: 'nearest' } as const;
    const GIF7_DELAYS = [100, 50, 200, 0, 10, 20, 30];

    let dir: string;
    /** Fixture files by name, written once for the block. */
    const files: Record<string, string> = {};
    /** Fixture bytes by name, for serving over https. */
    const bytes: Record<string, Uint8Array> = {};

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-push-animated-'));
      const still = new Uint8Array(canvasToPng(new Canvas(64).clear([0, 128, 255])));
      const gif3 = await animatedImage('gif', [100, 100, 100]);
      const fixtures: Record<string, [string, Uint8Array]> = {
        png: ['still.png', still],
        gif3: ['three.gif', gif3],
        gif7: ['seven.gif', await animatedImage('gif', GIF7_DELAYS)],
        gif100: ['hundred.gif', await animatedImage('gif', Array(100).fill(30))],
        gifZero: ['zero.gif', await animatedImage('gif', [0, 0, 0])],
        gifFast: ['fast.gif', await animatedImage('gif', [10, 0, 0])],
        gifSlow: ['slow.gif', await animatedImage('gif', [5000, 5000])],
        webp: ['anim.webp', await animatedImage('webp', [100, 50, 200, 20])],
        gifOne: ['one.gif', await animatedImage('gif', [70])],
        pngAsGif: ['still.gif', still],
        gifAsPng: ['animated.png', gif3],
        tiff: ['pyramid.tiff', await tiffPyramid()],
      };
      await Promise.all(
        Object.entries(fixtures).map(async ([name, [file, data]]) => {
          files[name] = path.join(dir, file);
          bytes[name] = data;
          await fs.writeFile(files[name]!, data);
        }),
      );
    });

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // TEST-NET-1 address: never routable. The device client is a fake regardless.
      process.env['PIXOO_IP'] = '192.0.2.1';
      resetServerConfig();
      initPixooService(fakeConfig, fakeStorage);
    });

    interface PushOutput {
      frames: number;
      pushed: boolean;
      sourceFrames: number;
      speed?: number;
    }

    /** Push `input` to a fake device; return the result, its output, preview, and the fake. */
    async function pushThrough(input: Record<string, unknown>) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooPushImage, {
        push: true,
        ...input,
      } as z.input<typeof pixooPushImage.input>);
      expect(result.isError).toBeFalsy();
      const images = result.content.filter((block) => block.type === 'image');
      expect(images).toHaveLength(1);
      return {
        result,
        client,
        sc: result.structuredContent as unknown as PushOutput,
        preview: (images[0] as { data: string }).data,
      };
    }

    /** The frames `pushAnimation` received in its one call, and the speed it received. */
    function animationPush(client: ReturnType<typeof stubDeviceState>) {
      expect(client.pushAnimation).toHaveBeenCalledTimes(1);
      expect(client.push).not.toHaveBeenCalled();
      const [frames, speed] = client.pushAnimation.mock.calls[0] as [Canvas[], number];
      return { frames, speed };
    }

    it.each(['file', 'url'] as const)(
      'a 3-frame GIF from a %s pushes through pushAnimation with 3 frames, and the preview tiles all three',
      async (via) => {
        const url = 'https://images.test/animated/three.gif';
        const http = createFetchMock([
          { match: url, respond: () => new Response(new Uint8Array(bytes['gif3']!)) },
        ]);
        http.install();
        try {
          const { client, sc, preview } = await pushThrough({
            source: via === 'file' ? files['gif3'] : url,
          });
          const { frames, speed } = animationPush(client);
          expect(frames).toHaveLength(3);
          expect(speed).toBe(100);
          expect(sc).toMatchObject({ pushed: true, frames: 3, sourceFrames: 3, speed: 100 });

          const expected = await loadAnimation(files['gif3']!, { ...PLACEMENT, maxFrames: 40 });
          expect(frames.map(hashOf)).toEqual(expected.frames.map(hashOf));
          expect(new Set(frames.map(hashOf)).size).toBe(3);
          expect(preview).toBe((await buildContactSheet(expected.frames)).data);
        } finally {
          http.restore();
        }
      },
    );

    it('a 7-frame GIF with delays [100, 50, 200, 0, 10, 20, 30] pushes at 59 ms', async () => {
      const { client, sc } = await pushThrough({ source: files['gif7'] });
      const { frames, speed } = animationPush(client);
      expect(frames).toHaveLength(7);
      expect(speed).toBe(59);
      expect(sc).toMatchObject({ frames: 7, sourceFrames: 7, speed: 59 });
    });

    it('speed: 200 overrides the loop-length speed of the 7-frame GIF', async () => {
      const { client, sc } = await pushThrough({ source: files['gif7'], speed: 200 });
      expect(animationPush(client).speed).toBe(200);
      expect(sc.speed).toBe(200);
    });

    it('a 100-frame GIF at 30 ms per frame pushes 40 frames at 75 ms with sourceFrames: 100', async () => {
      const { client, sc } = await pushThrough({ source: files['gif100'] });
      const { frames, speed } = animationPush(client);
      expect(frames).toHaveLength(40);
      expect(speed).toBe(75);
      expect(sc).toMatchObject({ frames: 40, sourceFrames: 100, speed: 75 });
      // Sampled evenly from frame 0: source frames 0, 2, 5, … — never the first 40.
      const expected = await loadAnimation(files['gif100']!, { ...PLACEMENT, maxFrames: 40 });
      expect(frames.map(hashOf)).toEqual(expected.frames.map(hashOf));
    });

    it('an animated WebP pushes as an animation', async () => {
      const { client, sc } = await pushThrough({ source: files['webp'] });
      const { frames, speed } = animationPush(client);
      expect(frames).toHaveLength(4);
      // 370 ms over 4 frames.
      expect(speed).toBe(93);
      expect(sc).toMatchObject({ frames: 4, sourceFrames: 4, speed: 93 });
    });

    it('a GIF whose delays are all 0 pushes at 150 ms', async () => {
      const { client, sc } = await pushThrough({ source: files['gifZero'] });
      expect(animationPush(client).speed).toBe(150);
      expect(sc.speed).toBe(150);
    });

    it.each([
      ['a 10 ms loop over 3 frames clamps up to 10 ms', 'gifFast', 10],
      ['a 10 s loop over 2 frames clamps down to 2000 ms', 'gifSlow', 2000],
    ])('%s', async (_label, name, expected) => {
      const { client, sc } = await pushThrough({ source: files[name] });
      expect(animationPush(client).speed).toBe(expected);
      expect(sc.speed).toBe(expected);
    });

    it('an animated GIF saved under a .png name pushes as an animation', async () => {
      const { client, sc } = await pushThrough({ source: files['gifAsPng'] });
      expect(animationPush(client).frames).toHaveLength(3);
      expect(sc).toMatchObject({ frames: 3, sourceFrames: 3, speed: 100 });
    });

    it.each([
      ['a still PNG', () => files['png']!],
      ['a single-frame GIF', () => files['gifOne']!],
      ['a PNG saved under a .gif name', () => files['pngAsGif']!],
      ['a multi-page TIFF whose pages differ in size', () => files['tiff']!],
    ])(
      '%s pushes through pushFrame with the preview loadImage gives it, frames: 1, sourceFrames: 1, no speed',
      async (_label, source) => {
        const { client, sc, preview } = await pushThrough({ source: source() });
        expect(client.push).toHaveBeenCalledTimes(1);
        expect(client.pushAnimation).not.toHaveBeenCalled();
        const expected = await loadImage(source(), PLACEMENT);
        expect(hashOf(client.push.mock.calls[0]![0] as Canvas)).toBe(hashOf(expected));
        expect(preview).toBe(encodePreviewBlock(expected).data);
        expect(sc).toMatchObject({ frames: 1, sourceFrames: 1 });
        expect(sc).not.toHaveProperty('speed');
      },
    );

    it('a still ignores speed', async () => {
      const { client, sc } = await pushThrough({ source: files['png'], speed: 200 });
      expect(client.push).toHaveBeenCalledTimes(1);
      expect(client.pushAnimation).not.toHaveBeenCalled();
      expect(sc).not.toHaveProperty('speed');
    });

    describe('saved files', () => {
      afterEach(() => {
        delete process.env['PIXOO_OUTPUT_DIR'];
        resetServerConfig();
      });

      it.each([
        ['an animated source', 'gif3', 'gif'],
        ['a still', 'pngAsGif', 'png'],
      ] as const)('outputFiles holds a %s as a %s', async (_label, name, kind) => {
        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-push-animated-out-'));
        process.env['PIXOO_OUTPUT_DIR'] = outDir;
        resetServerConfig();
        try {
          const result = await runToolContract(pixooPushImage, {
            source: files[name]!,
            push: false,
          });
          const { outputFiles } = result.structuredContent as { outputFiles: string[] };
          expect(outputFiles).toHaveLength(1);
          expect(outputFiles[0]!.endsWith(`.${kind}`)).toBe(true);
          expect(await imageKind(outputFiles[0]!)).toBe(kind);
          expect(await listFiles(outDir)).toEqual(outputFiles);
        } finally {
          await fs.rm(outDir, { recursive: true, force: true });
        }
      });

      it('a failed pushAnimation keeps the GIF', async () => {
        const tmp = await isolateTmpdir();
        try {
          failDevicePush({ ok: false, kind: 'network', message: 'EHOSTUNREACH' });
          const result = await runToolContract(pixooPushImage, {
            source: files['gif3']!,
            push: true,
          });
          expectDeviceFailure(result, pixooPushImage.errors, 'device_unreachable', true);
          const kept = errorOutputFiles(result) as string[];
          expect(kept).toHaveLength(1);
          expect(await imageKind(kept[0]!)).toBe('gif');
          expect(kept[0]!.startsWith(tmp.dir)).toBe(true);
        } finally {
          tmp.restore();
          await fs.rm(tmp.dir, { recursive: true, force: true });
        }
      });
    });

    it.each([9, 2001, 12.5])('speed %s fails input validation as InvalidParams', async (speed) => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooPushImage, {
        source: files['gif3']!,
        speed,
      } as z.input<typeof pixooPushImage.input>);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain('speed');
      expect(client.pushAnimation).not.toHaveBeenCalled();
    });

    it.each([10, 2000])('speed %i is accepted', async (speed) => {
      const { client, sc } = await pushThrough({ source: files['gif3'], speed });
      expect(animationPush(client).speed).toBe(speed);
      expect(sc.speed).toBe(speed);
    });

    it('format() renders frames, sourceFrames, and speed', () => {
      const animated = pixooPushImage.format!({
        pushed: true,
        frames: 40,
        sourceFrames: 100,
        speed: 75,
      });
      const text = (animated[0] as { text: string }).text;
      expect(text).toContain('**Frames:** 40 of 100 source frames');
      expect(text).toContain('**Speed:** 75 ms per frame');

      const still = (
        pixooPushImage.format!({ pushed: false, frames: 1, sourceFrames: 1 })[0] as {
          text: string;
        }
      ).text;
      expect(still).toContain('**Frames:** 1 of 1 source frame');
      expect(still).not.toContain('Speed');
    });
  });

  describe('a source that exists but does not decode fails as invalid_image', () => {
    let sources: ImageSources;

    beforeAll(async () => {
      sources = await writeImageSources();
    });

    it.each([
      ['a local non-image', 'notImage', 'file', NOT_IMAGE_REASON],
      ['a local truncated JPEG', 'truncatedJpeg', 'file', TRUNCATED_JPEG_REASON],
      ['an https non-image body', 'notImage', 'url', NOT_IMAGE_REASON],
      ['an https truncated JPEG', 'truncatedJpeg', 'url', TRUNCATED_JPEG_REASON],
    ] as const)('%s, naming only the source', async (_label, name, via, decoderReason) => {
      const source = sources[name][via];
      const result = await withServedSources(sources, () =>
        runToolContract(pixooPushImage, { source, push: false }),
      );
      expectInvalidImage(result, pixooPushImage.errors, source, decoderReason);
      expect(result.structuredContent).toMatchObject({ error: { data: { source } } });
    });

    it('fails before anything is pushed', async () => {
      const client = stubDeviceState();
      const result = await runToolContract(pixooPushImage, {
        source: sources.notImage.file,
        push: true,
      });
      expect(result.isError).toBe(true);
      expect(client.push).not.toHaveBeenCalled();
    });

    it.each([
      ['an unreachable https URL', UNREACHABLE_URL],
      ['a non-https URL', 'http://images.test/sources/art.png'],
    ])('%s still fails as asset_not_found, with the declared recovery', async (_label, source) => {
      const result = await withServedSources(sources, () =>
        runToolContract(pixooPushImage, { source, push: false }),
      );
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'asset_not_found', url: source },
        },
      });
      expectForwardedRecovery(result, pixooPushImage.errors, 'asset_not_found');
    });

    it('a URL over the 10 MiB download cap fails as asset_not_found, with the declared recovery', async () => {
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
        const result = await runToolContract(pixooPushImage, { source: url, push: false });
        expectForwardedRecovery(result, pixooPushImage.errors, 'asset_not_found');
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
  });

  describe('finish reduces the image to a palette', () => {
    const PLACEMENT = { size: 64, fit: 'contain', kernel: 'nearest' } as const;
    const PALETTE = ['#000000', '#ffffff', '#ff8800'];
    const PALETTE_RGB = ['0,0,0', '255,255,255', '255,136,0'];

    let dir: string;
    /** A 96×96 noise PNG: thousands of colors. */
    let photo: string;
    /** A 64×32 gradient PNG, letterboxed under contain: its top and bottom 16 rows stay transparent. */
    let banner: string;
    /** A 4-frame animated WebP, 64 colors per frame, each frame its own blue level. */
    let animated: string;

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-push-finish-'));
      photo = (await writeImageSources()).png.file;
      const gradient = Buffer.alloc(64 * 32 * 3);
      for (let p = 0; p < 64 * 32; p++) {
        gradient[p * 3] = (p % 64) * 4;
        gradient[p * 3 + 1] = Math.floor(p / 64) * 8;
        gradient[p * 3 + 2] = 128;
      }
      banner = path.join(dir, 'banner.png');
      await sharp(gradient, { raw: { width: 64, height: 32, channels: 3 } })
        .png()
        .toFile(banner);
      animated = path.join(dir, 'animated.webp');
      await fs.writeFile(animated, await animatedImage('webp', [100, 100, 100, 100]));
    });

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // TEST-NET-1 address: never routable. The device client is a fake regardless.
      process.env['PIXOO_IP'] = '192.0.2.1';
      resetServerConfig();
      initPixooService(fakeConfig, fakeStorage);
    });

    /** Push `input`; return the result, the fake device, and the preview's base64. */
    async function pushWith(input: Record<string, unknown>) {
      const client = stubDeviceState();
      const result = await runToolContract(pixooPushImage, {
        push: true,
        ...input,
      } as z.input<typeof pixooPushImage.input>);
      const image = result.content.find((block) => block.type === 'image') as
        | { data: string }
        | undefined;
      return { result, client, preview: image?.data };
    }

    /** Distinct RGB of every visible pixel across `frames`, as `r,g,b`. */
    const colorsOf = (...frames: Canvas[]) =>
      new Set(frames.flatMap((frame) => inkColors(frame).map((rgb) => rgb.join(','))));

    /** Indices of every alpha-0 pixel. */
    const transparentPixels = (canvas: Canvas) =>
      Array.from({ length: canvas.width * canvas.height }, (_, p) => p).filter(
        (p) => canvas.buffer[p * 4 + 3] === 0,
      );

    it('finish: { colors: 8 } pushes a frame with at most 8 distinct opaque colors, and the preview is that frame', async () => {
      expect(colorsOf(await loadImage(photo, PLACEMENT)).size).toBeGreaterThan(8);

      const { result, client, preview } = await pushWith({ source: photo, finish: { colors: 8 } });
      expect(result.isError).toBeFalsy();
      expect(client.push).toHaveBeenCalledTimes(1);
      const frame = client.push.mock.calls[0]![0] as Canvas;
      expect(colorsOf(frame).size).toBeLessThanOrEqual(8);
      expect(colorsOf(frame).size).toBeGreaterThan(1);
      expect(preview).toBe(encodePreviewBlock(frame).data);
    });

    it.each(['none', 'bayer4', 'floyd-steinberg'] as const)(
      'finish: { palette: [#000000, #ffffff, #ff8800] } under dither %s: every opaque pixel is a palette color, every transparent pixel stays transparent',
      async (dither) => {
        const { result, client, preview } = await pushWith({
          source: banner,
          finish: { palette: PALETTE, dither },
        });
        expect(result.isError).toBeFalsy();
        const frame = client.push.mock.calls[0]![0] as Canvas;
        expect([...colorsOf(frame)].every((rgb) => PALETTE_RGB.includes(rgb))).toBe(true);
        const unfinished = await loadImage(banner, PLACEMENT);
        expect(transparentPixels(unfinished)).toHaveLength(64 * 32);
        expect(transparentPixels(frame)).toEqual(transparentPixels(unfinished));
        expect(preview).toBe(encodePreviewBlock(frame).data);
      },
    );

    it('an animated source with finish: { colors: 4 } pushes frames whose opaque pixels together hold at most 4 colors', async () => {
      const unfinished = await loadAnimation(animated, { ...PLACEMENT, maxFrames: 40 });
      expect(colorsOf(...unfinished.frames).size).toBeGreaterThan(4);

      const { result, client, preview } = await pushWith({
        source: animated,
        finish: { colors: 4 },
      });
      expect(result.isError).toBeFalsy();
      const [frames] = client.pushAnimation.mock.calls[0] as [Canvas[], number];
      expect(frames).toHaveLength(4);
      expect(colorsOf(...frames).size).toBeLessThanOrEqual(4);
      expect(preview).toBe((await buildContactSheet(frames)).data);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['both colors and palette', { colors: 8, palette: PALETTE }, 'finish: Unrecognized key'],
      ['neither colors nor palette', {}, 'finish: colors: '],
      ['only a dither', { dither: 'bayer4' }, 'finish: colors: '],
      ['colors 1', { colors: 1 }, 'finish.colors: Too small'],
      ['colors 257', { colors: 257 }, 'finish.colors: Too big'],
      ['colors 8.5', { colors: 8.5 }, 'finish: colors: Invalid input: expected int'],
      ['an empty palette', { palette: [] }, 'finish.palette: Too small'],
      ['a 257-entry palette', { palette: Array(257).fill('#000000') }, 'finish.palette: Too big'],
      ['an unknown dither', { colors: 8, dither: 'sierra' }, 'finish: dither: Invalid option'],
    ])('%s fails input validation (-32602) naming finish', async (_label, finish, named) => {
      const { result, client } = await pushWith({ source: photo, finish });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(resultText(result)).toContain(named);
      expect(client.push).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>]>([
      ['colors 2', { colors: 2 }],
      ['colors 256', { colors: 256 }],
      ['a 1-entry palette', { palette: ['orange'] }],
      ['a 256-entry palette', { palette: Array(256).fill('#123456') }],
    ])('%s is accepted', async (_label, finish) => {
      const { result, client } = await pushWith({ source: photo, finish });
      expect(result.isError).toBeFalsy();
      expect(client.push).toHaveBeenCalledTimes(1);
    });

    it('invalid_color is declared as InvalidParams', () => {
      const declared = pixooPushImage.errors?.find((entry) => entry.reason === 'invalid_color');
      expect(declared?.code).toBe(JsonRpcErrorCode.InvalidParams);
    });

    it.each(['#zzzzzz', 'not-a-color', ...PROTOTYPE_NAME_CASES])(
      'a palette entry %j fails as invalid_color before anything is pushed',
      async (entry) => {
        const { result, client } = await pushWith({
          source: photo,
          finish: { palette: ['#000000', entry] },
        });
        expectInvalidColor(result, pixooPushImage.errors, entry);
        expect(resultText(result)).toContain('finish.palette');
        expect(client.push).not.toHaveBeenCalled();
      },
    );
  });

  it('format() returns text block containing Pushed status', () => {
    const output = { pushed: false, frames: 1, sourceFrames: 1 };
    const blocks = pixooPushImage.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pushed');
  });

  it('format() mentions Saved when outputFiles present', () => {
    const output = { pushed: false, frames: 1, sourceFrames: 1, outputFiles: ['/tmp/out.png'] };
    const blocks = pixooPushImage.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Saved');
    expect(text).toContain('/tmp/out.png');
  });
});
