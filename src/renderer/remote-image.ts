/**
 * @fileoverview Remote image fetch — downloads an https image to a temp PNG for the
 * toolkit's `loadImage`, which reads from disk only. Shared by the scene renderer's
 * image elements and the pixoo_push_image tool.
 * @module renderer/remote-image
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

/** Wall-clock budget for a remote image fetch, headers through body. */
const FETCH_TIMEOUT_MS = 15_000;

/** Ceiling on a downloaded image before it is decoded. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** True when the string is a URL rather than a local filesystem path. */
export function isRemoteSource(source: string): boolean {
  return source.startsWith('https://') || source.startsWith('http://');
}

/**
 * Fetch an https image and write it to a temp PNG, returning the path. The caller
 * owns the file and must unlink it once `loadImage` has read it.
 *
 * Private and loopback addresses are deliberately reachable: this server drives a
 * LAN device, so a NAS or local web server is a legitimate image host.
 *
 * The download runs under `ctx.signal`: a cancelled request tears the response stream
 * down instead of reading on to the deadline or the byte cap.
 *
 * @throws {McpError} NotFound with `reason: 'asset_not_found'` for a non-https URL,
 *   an unreachable or non-2xx endpoint, or a response over {@link MAX_IMAGE_BYTES}.
 * @throws {McpError} RequestCancelled when `ctx.signal` aborts while the body streams.
 */
export async function fetchRemoteImageToTempPng(source: string, ctx: Context): Promise<string> {
  if (!source.startsWith('https://')) {
    throw notFound(`Only https URLs are supported. Received: "${source}".`, {
      reason: 'asset_not_found',
      url: source,
      recovery: { hint: 'Use an https URL, or pass an absolute local file path instead.' },
    });
  }

  // A throw here after the signal fired still reaches the caller as a cancellation:
  // the handler factory reclassifies any error once the request's signal has aborted.
  const resp = await fetchWithTimeout(source, FETCH_TIMEOUT_MS, ctx, {
    signal: ctx.signal,
  }).catch((err: unknown) => {
    throw notFound(
      `Failed to fetch image from "${source}": ${err instanceof Error ? err.message : String(err)}`,
      {
        reason: 'asset_not_found',
        url: source,
        recovery: { hint: 'Check the URL is reachable and returns an image, then retry.' },
      },
    );
  });

  /** Both size gates fail the same way; only the field naming the measurement differs. */
  const tooLarge = (bytes: number, field: 'byteLength' | 'contentLength') =>
    notFound(`Image response too large (${bytes} bytes; limit: ${MAX_IMAGE_BYTES}).`, {
      reason: 'asset_not_found',
      url: source,
      [field]: bytes,
      recovery: { hint: 'Downscale the image before hosting it, or point at a smaller file.' },
    });

  // content-length is advisory: it bails before the body is read, but the byte
  // count taken while streaming is the gate that actually holds.
  const contentLength = Number(resp.headers.get('content-length') ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    await resp.body?.cancel();
    throw tooLarge(contentLength, 'contentLength');
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = resp.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw tooLarge(received, 'byteLength');
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks, received);

  const { default: sharp } = await import('sharp');
  const tmpPath = path.join(
    os.tmpdir(),
    `pixoo-img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  await sharp(buf).png().toFile(tmpPath);
  return tmpPath;
}
