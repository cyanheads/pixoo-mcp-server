/**
 * @fileoverview A fetch-mock route whose response body trickles in small chunks and
 * records when its source is cancelled. The body is piped under the request's own
 * signal, the way `fetch` ties a response stream to its request: aborting that signal
 * cancels the source mid-download.
 * @module tests/helpers/trickle-body
 */

import type { FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';

/** What the trickling body observed. */
export interface TrickleState {
  cancelled: boolean;
  /** Chunks handed to the reader so far. */
  pulled: number;
}

/**
 * Route `url` to a body that serves `payload` in `chunkBytes` pieces, one per
 * `delayMs`. `onChunk` runs after each chunk is enqueued, with the running count.
 */
export function trickleRoute(
  url: string,
  payload: Uint8Array,
  { chunkBytes = 1024, delayMs = 2, onChunk = (_n: number) => {} } = {},
): { route: FetchMockRoute; state: TrickleState } {
  const state: TrickleState = { cancelled: false, pulled: 0 };
  const route: FetchMockRoute = {
    match: url,
    respond: (request: Request) => {
      let offset = 0;
      const source = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (offset >= payload.byteLength) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            controller.enqueue(payload.slice(offset, offset + chunkBytes));
            offset += chunkBytes;
            state.pulled++;
            onChunk(state.pulled);
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      source.pipeTo(writable, { signal: request.signal }).catch(() => undefined);
      return new Response(readable);
    },
  };
  return { route, state };
}
