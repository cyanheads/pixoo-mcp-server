/**
 * @fileoverview Tests for the shared remote-image fetch helper.
 * @module tests/renderer/remote-image.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { fetchRemoteImageBytes, isRemoteSource } from '@/renderer/remote-image.js';
import { isolateTmpdir, listFiles } from '../helpers/device-failure.js';
import { trickleRoute } from '../helpers/trickle-body.js';

/** A 1×1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('isRemoteSource', () => {
  it('distinguishes URLs from local paths', () => {
    expect(isRemoteSource('https://example.test/a.png')).toBe(true);
    expect(isRemoteSource('http://example.test/a.png')).toBe(true);
    expect(isRemoteSource('/tmp/a.png')).toBe(false);
    expect(isRemoteSource('./a.png')).toBe(false);
  });

  it('reads the scheme case-insensitively', () => {
    expect(isRemoteSource('HTTPS://example.test/a.png')).toBe(true);
    expect(isRemoteSource('Http://example.test/a.png')).toBe(true);
  });
});

describe('fetchRemoteImageBytes with an uppercase scheme', () => {
  it('fetches an HTTPS:// URL as an https one', async () => {
    const http = createFetchMock([
      {
        match: (request) => request.url === 'https://images.test/pixel.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), { headers: { 'content-type': 'image/png' } }),
      },
    ]);
    http.install();
    try {
      const bytes = await fetchRemoteImageBytes(
        'HTTPS://images.test/pixel.png',
        createMockContext(),
      );
      expect(Buffer.from(bytes).equals(PNG_1X1)).toBe(true);
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

describe('fetchRemoteImageBytes', () => {
  it('returns the fetched image bytes', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/pixel.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), { headers: { 'content-type': 'image/png' } }),
      },
    ]);
    http.install();
    try {
      const bytes = await fetchRemoteImageBytes(
        'https://images.test/pixel.png',
        createMockContext(),
      );
      expect(Buffer.from(bytes).equals(PNG_1X1)).toBe(true);
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('returns a body that is not an image unchanged, leaving decoding to the loader', async () => {
    const page = '<!doctype html><title>Not Found</title>';
    const http = createFetchMock([
      { match: 'https://images.test/page.png', respond: () => new Response(page) },
    ]);
    http.install();
    try {
      const bytes = await fetchRemoteImageBytes(
        'https://images.test/page.png',
        createMockContext(),
      );
      expect(Buffer.from(bytes).toString('utf8')).toBe(page);
    } finally {
      http.restore();
    }
  });

  it('writes nothing to the temp dir', async () => {
    const tmp = await isolateTmpdir();
    const http = createFetchMock([
      { match: 'https://images.test/pixel.png', respond: () => new Response(PNG_1X1) },
    ]);
    http.install();
    try {
      await fetchRemoteImageBytes('https://images.test/pixel.png', createMockContext());
      expect(await listFiles(tmp.dir)).toEqual([]);
    } finally {
      http.restore();
      tmp.restore();
    }
  });

  it('rejects a non-https URL as asset_not_found before any network call', async () => {
    const http = createFetchMock();
    http.install();
    try {
      await expect(
        fetchRemoteImageBytes('http://images.test/pixel.png', createMockContext()),
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
        fetchRemoteImageBytes('https://images.test/missing.png', createMockContext()),
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
      const bytes = await fetchRemoteImageBytes(
        'https://images.test/chunked.png',
        createMockContext(),
      );
      expect(Buffer.from(bytes).equals(PNG_1X1)).toBe(true);
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
        fetchRemoteImageBytes('https://images.test/endless.png', createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'asset_not_found',
          url: 'https://images.test/endless.png',
          byteLength: expect.any(Number),
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
          fetchRemoteImageBytes(URL_, createMockContext({ signal: controller.signal })),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(state.cancelled).toBe(true);
        // Torn down at the abort, not carried through the other ~197 chunks.
        expect(state.pulled).toBeLessThan(10);
      } finally {
        http.restore();
      }
    });

    it('a caller-side deadline mid-download is a Timeout, and still cancels the body stream', async () => {
      const controller = new AbortController();
      const { route, state } = trickleRoute(URL_, new Uint8Array(200 * 1024), {
        onChunk: (n) =>
          n === 3 && controller.abort(new DOMException('Caller deadline', 'TimeoutError')),
      });
      const http = createFetchMock([route]);
      http.install();
      try {
        await expect(
          fetchRemoteImageBytes(URL_, createMockContext({ signal: controller.signal })),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { errorSource: 'FetchSignalTimeout' },
        });
        expect(state.cancelled).toBe(true);
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
          fetchRemoteImageBytes(URL_, createMockContext({ signal: controller.signal })),
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
        const bytes = await fetchRemoteImageBytes(
          URL_,
          createMockContext({ signal: new AbortController().signal }),
        );
        expect(Buffer.from(bytes).equals(PNG_1X1)).toBe(true);
        expect(state.pulled).toBe(Math.ceil(PNG_1X1.byteLength / 16));
        expect(state.cancelled).toBe(false);
      } finally {
        http.restore();
      }
    });
  });

  describe('every failure is an asset_not_found that leaves the recovery to the calling tool', () => {
    const oversized = () => {
      let pulled = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulled++ === 12) controller.close();
              else controller.enqueue(new Uint8Array(1024 * 1024));
            },
          },
          { highWaterMark: 0 },
        ),
      );
    };

    it.each([
      [
        'a non-https URL',
        'http://images.test/pixel.png',
        () => new Response(PNG_1X1),
        /^Only https URLs are supported\. Received: "http:\/\/images\.test\/pixel\.png"\.$/,
      ],
      [
        'an unreachable host',
        'https://images.test/down.png',
        (): Response => {
          throw new TypeError('fetch failed');
        },
        /^Failed to fetch image from "https:\/\/images\.test\/down\.png": /,
      ],
      [
        'a non-2xx answer',
        'https://images.test/missing.png',
        () => new Response('nope', { status: 404 }),
        /^Failed to fetch image from "https:\/\/images\.test\/missing\.png": /,
      ],
      [
        'a declared content-length over the ceiling',
        'https://images.test/huge.png',
        () =>
          new Response(new Uint8Array(PNG_1X1), {
            headers: { 'content-length': String(11 * 1024 * 1024) },
          }),
        /^Image response too large \(11534336 bytes; limit: 10485760\)\.$/,
      ],
      [
        'a streamed body over the ceiling',
        'https://images.test/endless.png',
        oversized,
        /^Image response too large \(\d+ bytes; limit: 10485760\)\.$/,
      ],
    ] as const)('%s', async (_label, url, respond, message) => {
      const http = createFetchMock([{ match: url, respond }]);
      http.install();
      try {
        const err = await fetchRemoteImageBytes(url, createMockContext()).then(
          () => expect.fail('fetchRemoteImageBytes resolved'),
          (e: unknown) => e as { code: number; message: string; data: object },
        );
        expect(err.code).toBe(JsonRpcErrorCode.NotFound);
        expect(err.data).toMatchObject({ reason: 'asset_not_found', url });
        expect(err.data).not.toHaveProperty('recovery');
        expect(err.message).toMatch(message);
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
        fetchRemoteImageBytes('https://images.test/huge.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
    } finally {
      http.restore();
    }
  });
});
