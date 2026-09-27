/**
 * @fileoverview Image-source fixtures, each on disk and served over a mocked https fetch:
 * decodable PNG, JPEG, and SVG files, plus sources that exist but do not decode (a text
 * file, a truncated JPEG). Used to assert how a tool loads an image source, and how it
 * fails to. Also encodes animated GIF/WebP and multi-page TIFF bytes on demand.
 * @module tests/helpers/image-sources
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type runToolContract } from '@cyanheads/mcp-ts-core/testing';
import sharp from 'sharp';
import { expect } from 'vitest';
import { expectForwardedRecovery } from './expect-forwarded-recovery.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** One fixture: the same bytes as a local file and at an https URL. */
export interface ImageSource {
  bytes: Uint8Array;
  file: string;
  url: string;
}

export interface ImageSources {
  jpeg: ImageSource;
  /** A text file saved with a `.png` name. */
  notImage: ImageSource;
  png: ImageSource;
  /** A 16×16 vector, so rendering it at its intrinsic size and at 64 px differ. */
  svg: ImageSource;
  /** The first half of {@link ImageSources.jpeg}: the header reads, the scan data ends early. */
  truncatedJpeg: ImageSource;
}

/** An https URL that answers with a network failure, as an unreachable host does. */
export const UNREACHABLE_URL = 'https://unreachable.images.test/photo.png';

/** The phrase every `invalid_image` recovery hint carries. */
export const INVALID_IMAGE_FORMATS = 'complete PNG, JPEG, GIF, WebP, AVIF, TIFF, or SVG image';

/** The decoder's reason for {@link ImageSources.notImage}. */
export const NOT_IMAGE_REASON = /unsupported image format/;

/**
 * The decoder's reason for {@link ImageSources.truncatedJpeg}. libvips keeps one error
 * buffer for every thread, so while other images decode concurrently sharp can report
 * the generic failOn message in place of the JPEG loader's own.
 */
export const TRUNCATED_JPEG_REASON =
  /premature end of JPEG image|Warning treated as error due to failOn setting/;

/** Deterministic noise, so the JPEG's scan data outlasts its first half. */
function noise(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i >> 5) * 11) & 255;
  return raw;
}

/**
 * An animated GIF or WebP written by sharp: one 8×8 frame per entry of `delays`, shown
 * for that many milliseconds. Frame k holds 64 colors — red across, green down, and a
 * blue level of its own — so every frame differs from the others and a palette built
 * from one frame misses colors the rest hold. sharp's WebP writer stores 0 and 10 ms as
 * 100 ms; its GIF writer keeps every delay, 0 included.
 */
export async function animatedImage(
  format: 'gif' | 'webp',
  delays: readonly number[],
): Promise<Uint8Array> {
  const side = 8;
  const raw = Buffer.alloc(side * side * 4 * delays.length);
  for (let k = 0; k < delays.length; k++) {
    for (let p = 0; p < side * side; p++) {
      const i = (k * side * side + p) * 4;
      raw[i] = (p % side) * 32;
      raw[i + 1] = Math.floor(p / side) * 32;
      raw[i + 2] = (k * 53) & 255;
      raw[i + 3] = 255;
    }
  }
  const image = sharp(raw, {
    raw: { width: side, height: side * delays.length, channels: 4, pageHeight: side },
  });
  const encoded =
    format === 'gif'
      ? image.gif({ delay: [...delays], loop: 0 })
      : image.webp({ lossless: true, delay: [...delays], loop: 0 });
  return new Uint8Array(await encoded.toBuffer());
}

/**
 * A tiled TIFF pyramid: three pages of 64×64, 32×32, and 16×16. The pages differ in
 * size, so it decodes only as a still, from its first page.
 */
export async function tiffPyramid(): Promise<Uint8Array> {
  const bytes = await sharp(noise(64, 64), { raw: { width: 64, height: 64, channels: 3 } })
    .tiff({ pyramid: true, tile: true, tileWidth: 16, tileHeight: 16, compression: 'lzw' })
    .toBuffer();
  return new Uint8Array(bytes);
}

/** Write every fixture to a fresh directory under the OS temp dir. */
export async function writeImageSources(): Promise<ImageSources> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-image-sources-'));
  const raw = { raw: { width: 96, height: 96, channels: 3 as const } };
  const jpeg = await sharp(noise(96, 96), raw).jpeg({ quality: 90 }).toBuffer();

  const contents: Record<keyof ImageSources, [string, Uint8Array]> = {
    png: ['art.png', await sharp(noise(96, 96), raw).png().toBuffer()],
    jpeg: ['photo.jpg', jpeg],
    svg: [
      'mark.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#ff8800"/><path d="M2 14 L14 2" stroke="#00aaff" stroke-width="1.5"/></svg>',
      ),
    ],
    notImage: ['bad.png', Buffer.from('this is not an image\n')],
    truncatedJpeg: ['truncated.jpg', jpeg.subarray(0, Math.floor(jpeg.byteLength / 2))],
  };

  const entries = await Promise.all(
    Object.entries(contents).map(async ([key, [name, bytes]]) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, bytes);
      return [key, { bytes, file, url: `https://images.test/sources/${name}` }] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as ImageSources;
}

/**
 * Run `fn` with `fetch` answering every fixture URL with its bytes and
 * {@link UNREACHABLE_URL} with a network failure. Any other URL fails the fetch loudly.
 */
export async function withServedSources<T>(
  sources: ImageSources,
  fn: () => Promise<T>,
): Promise<T> {
  const http = createFetchMock([
    ...Object.values(sources).map(({ url, bytes }) => ({
      match: url,
      respond: () => new Response(new Uint8Array(bytes)),
    })),
    {
      match: UNREACHABLE_URL,
      respond: () => {
        throw new TypeError('fetch failed');
      },
    },
  ]);
  http.install();
  try {
    return await fn();
  } finally {
    http.restore();
  }
}

/**
 * Assert `result` failed as `invalid_image`: declared `InvalidParams` (-32602) on the
 * tool, the declared recovery on both surfaces, and a message naming `source` as passed
 * with the decoder's reason (matching `decoderReason`) and no other path.
 */
export function expectInvalidImage(
  result: ToolResult,
  errors: ReadonlyArray<{ reason: string; code: number; recovery: string }> | undefined,
  source: string,
  decoderReason: RegExp,
): void {
  const declared = errors?.find((entry) => entry.reason === 'invalid_image');
  expect(declared?.code).toBe(JsonRpcErrorCode.InvalidParams);
  expect(declared?.code).toBe(-32602);
  expect(declared?.recovery).toContain(INVALID_IMAGE_FORMATS);

  expectForwardedRecovery(result, errors, 'invalid_image');
  const error = (result.structuredContent as { error: { code: number; message: string } }).error;
  expect(error.code).toBe(-32602);
  expectNamesOnly(error.message, source, decoderReason);
}

/**
 * Assert a decode-failure `message` names `source` in quotes, then the decoder's reason,
 * and that no other path appears anywhere in it.
 */
export function expectNamesOnly(message: string, source: string, decoderReason: RegExp): void {
  expect(message).toContain(`"${source}" could not be decoded: `);
  const rest = message.split(source).join('');
  expect(rest).toMatch(decoderReason);
  expect(rest).not.toContain('/');
}
