/**
 * @fileoverview Remote image fetch — downloads an https image's encoded bytes into
 * memory for the toolkit's image loaders. Shared by the scene renderer's image elements
 * and the pixoo_push_image tool.
 * @module renderer/remote-image
 */

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
 * Fetch an https image and return its bytes as served, undecoded. Nothing is written to
 * disk: the caller passes the bytes to the toolkit's loader, where a body that is not an image
 * fails to decode.
 *
 * Private and loopback addresses are deliberately reachable: this server drives a
 * LAN device, so a NAS or local web server is a legitimate image host.
 *
 * The download runs under `ctx.signal`: a cancelled request tears the response stream
 * down instead of reading on to the deadline or the byte cap.
 *
 * @throws {McpError} NotFound with `reason: 'asset_not_found'` for a non-https URL,
 *   an unreachable or non-2xx endpoint, or a response over {@link MAX_IMAGE_BYTES}. The
 *   message names the failure; the recovery is the calling tool's declared one.
 * @throws {McpError} RequestCancelled when `ctx.signal` aborts while the body streams.
 * @throws {McpError} Timeout when the body outlasts {@link FETCH_TIMEOUT_MS}, or when the
 *   `ctx.signal` abort is a caller-side deadline (a `TimeoutError` reason). A tool handler
 *   still answers the deadline as RequestCancelled: the handler factory settles any throw
 *   after the request's signal fired as a cancellation.
 */
export async function fetchRemoteImageBytes(source: string, ctx: Context): Promise<Uint8Array> {
  if (!source.startsWith('https://')) {
    throw notFound(`Only https URLs are supported. Received: "${source}".`, {
      reason: 'asset_not_found',
      url: source,
      ...ctx.recoveryFor('asset_not_found'),
    });
  }

  // A throw here after the signal fired still reaches the caller as a cancellation:
  // the handler factory reclassifies any error once the request's signal has aborted.
  const resp = await fetchWithTimeout(source, FETCH_TIMEOUT_MS, ctx, {
    signal: ctx.signal,
  }).catch((err: unknown) => {
    throw notFound(
      `Failed to fetch image from "${source}": ${err instanceof Error ? err.message : String(err)}`,
      { reason: 'asset_not_found', url: source, ...ctx.recoveryFor('asset_not_found') },
    );
  });

  /** Both size gates fail the same way; only the field naming the measurement differs. */
  const tooLarge = (bytes: number, field: 'byteLength' | 'contentLength') =>
    notFound(`Image response too large (${bytes} bytes; limit: ${MAX_IMAGE_BYTES}).`, {
      reason: 'asset_not_found',
      url: source,
      [field]: bytes,
      ...ctx.recoveryFor('asset_not_found'),
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
  return Buffer.concat(chunks, received);
}
