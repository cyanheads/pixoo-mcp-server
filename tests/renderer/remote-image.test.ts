/**
 * @fileoverview Tests for the shared remote-image fetch helper.
 * @module tests/renderer/remote-image.test
 */

import * as fs from 'node:fs/promises';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemoteImageToTempPng, isRemoteSource } from '@/renderer/remote-image.js';
import { trickleRoute } from '../helpers/trickle-body.js';

/** 1×1 transparent PNG, the smallest payload sharp will re-encode. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const written: string[] = [];

afterEach(async () => {
  await Promise.all(written.splice(0).map((p) => fs.unlink(p).catch(() => undefined)));
});

describe('isRemoteSource', () => {
  it('distinguishes URLs from local paths', () => {
    expect(isRemoteSource('https://example.test/a.png')).toBe(true);
    expect(isRemoteSource('http://example.test/a.png')).toBe(true);
    expect(isRemoteSource('/tmp/a.png')).toBe(false);
    expect(isRemoteSource('./a.png')).toBe(false);
  });
});

describe('fetchRemoteImageToTempPng', () => {
  it('writes the fetched image to a temp PNG', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/pixel.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), { headers: { 'content-type': 'image/png' } }),
      },
    ]);
    http.install();
    try {
      const tmpPath = await fetchRemoteImageToTempPng(
        'https://images.test/pixel.png',
        createMockContext(),
      );
      written.push(tmpPath);
      expect(tmpPath.endsWith('.png')).toBe(true);
      await expect(fs.access(tmpPath)).resolves.toBeUndefined();
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('rejects a non-https URL as asset_not_found before any network call', async () => {
    const http = createFetchMock();
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('http://images.test/pixel.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });

  it('maps an upstream failure to asset_not_found', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/missing.png',
        respond: () => new Response('nope', { status: 404 }),
      },
    ]);
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('https://images.test/missing.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
    } finally {
      http.restore();
    }
  });

  it('loads an under-cap body that arrives in chunks with no content-length', async () => {
    const half = Math.ceil(PNG_1X1.byteLength / 2);
    const http = createFetchMock([
      {
        match: 'https://images.test/chunked.png',
        respond: () => {
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(PNG_1X1.subarray(0, half)));
                controller.enqueue(new Uint8Array(PNG_1X1.subarray(half)));
                controller.close();
              },
            }),
          );
          expect(response.headers.get('content-length')).toBeNull();
          return response;
        },
      },
    ]);
    http.install();
    try {
      const tmpPath = await fetchRemoteImageToTempPng(
        'https://images.test/chunked.png',
        createMockContext(),
      );
      written.push(tmpPath);
      await expect(fs.access(tmpPath)).resolves.toBeUndefined();
    } finally {
      http.restore();
    }
  });

  it('tears down an oversized body mid-stream when no content-length is declared', async () => {
    const CHUNK_BYTES = 1024 * 1024;
    const AVAILABLE_CHUNKS = 30;
    const chunk = new Uint8Array(CHUNK_BYTES);
    let pulled = 0;
    let cancelled = false;
    const http = createFetchMock([
      {
        match: 'https://images.test/endless.png',
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (pulled === AVAILABLE_CHUNKS) {
                    controller.close();
                    return;
                  }
                  pulled++;
                  controller.enqueue(chunk.slice());
                },
                cancel() {
                  cancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      },
    ]);
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('https://images.test/endless.png', createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'asset_not_found',
          url: 'https://images.test/endless.png',
          byteLength: expect.any(Number),
          recovery: { hint: expect.any(String) },
        },
      });
      expect(cancelled).toBe(true);
      // The cap is 10 MiB: the 11th chunk crosses it. Allow a chunk or two of
      // read-ahead through the fetch wrapper, but nowhere near the full 30.
      expect(pulled).toBeGreaterThanOrEqual(11);
      expect(pulled).toBeLessThanOrEqual(13);
    } finally {
      http.restore();
    }
  });

  describe('caller cancellation', () => {
    const URL_ = 'https://images.test/slow.png';

    it('aborting the request signal mid-download cancels the body stream', async () => {
      const controller = new AbortController();
      const { route, state } = trickleRoute(URL_, new Uint8Array(200 * 1024), {
        onChunk: (n) => n === 3 && controller.abort(),
      });
      const http = createFetchMock([route]);
      http.install();
      try {
        await expect(
          fetchRemoteImageToTempPng(URL_, createMockContext({ signal: controller.signal })),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(state.cancelled).toBe(true);
        // Torn down at the abort, not carried through the other ~197 chunks.
        expect(state.pulled).toBeLessThan(10);
      } finally {
        http.restore();
      }
    });

    it('a signal already aborted stops the fetch before any body is read', async () => {
      const controller = new AbortController();
      controller.abort();
      const { route, state } = trickleRoute(URL_, new Uint8Array(200 * 1024));
      const http = createFetchMock([route]);
      http.install();
      try {
        await expect(
          fetchRemoteImageToTempPng(URL_, createMockContext({ signal: controller.signal })),
        ).rejects.toThrow();
        expect(state.pulled).toBe(0);
      } finally {
        http.restore();
      }
    });

    it('an uncancelled trickled download completes exactly as before', async () => {
      const { route, state } = trickleRoute(URL_, new Uint8Array(PNG_1X1), { chunkBytes: 16 });
      const http = createFetchMock([route]);
      http.install();
      try {
        const tmpPath = await fetchRemoteImageToTempPng(
          URL_,
          createMockContext({ signal: new AbortController().signal }),
        );
        written.push(tmpPath);
        await expect(fs.access(tmpPath)).resolves.toBeUndefined();
        expect(state.pulled).toBe(Math.ceil(PNG_1X1.byteLength / 16));
        expect(state.cancelled).toBe(false);
      } finally {
        http.restore();
      }
    });
  });

  it('rejects a response that declares more than the byte ceiling', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/huge.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), {
            headers: { 'content-length': String(11 * 1024 * 1024) },
          }),
      },
    ]);
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('https://images.test/huge.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
    } finally {
      http.restore();
    }
  });
});
