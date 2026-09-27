/**
 * @fileoverview One-shot HTTP host for the animation GIF a Pixoo downloads and loops
 * (`Device/PlayTFGif`). It binds only the local address the OS routes to the device,
 * serves one GET at a random 128-bit path, then closes — as it does on a 10 s wait with
 * no request or no transfer progress, a dropped connection, or `ctx.signal` abort.
 * Plain `node:http`, since MCPB and npx installs run under Node.
 * @module services/pixoo/gif-host
 */

import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type ServerResponse } from 'node:http';
import { type AddressInfo, isIPv6 } from 'node:net';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/** How long the host waits for the request, and then for each step of the transfer. */
const WAIT_MS = 10_000;

/** Longest `Device/PlayTFGif` FileName the device answers; a longer one reboots it. */
const MAX_URL_BYTES = 255;

/** Write size; each drained chunk counts as transfer progress. */
const CHUNK_BYTES = 64 * 1024;

export interface GifHostOptions {
  /** PIXOO_IP — the listener binds the local address routed to it. */
  deviceIp: string;
  /** PIXOO_SERVE_HOST — advertised in the URL in place of the bound address. */
  serveHost?: string | undefined;
  /** PIXOO_SERVE_PORT — a fixed port; a free one when unset. */
  servePort?: number | undefined;
  /** Closes the listener and fails the wait when aborted. */
  signal: AbortSignal;
}

export interface GifHost {
  /** The local address the listener is bound to. */
  readonly address: string;
  /** Close the listener and drop any connection. Safe to call more than once. */
  close(): void;
  /**
   * Start the 10 s wait for the device's GET, if it has not arrived yet. Resolves once
   * the whole file has been handed to the OS; rejects `gif_serve_failed` on a timeout,
   * a stall, a dropped connection, or abort. The listener is closed either way.
   */
  served(): Promise<void>;
  /** The URL the device fetches. */
  readonly url: string;
}

const gifServeFailed = (message: string, cause?: unknown) =>
  serviceUnavailable(message, { reason: 'gif_serve_failed' }, { cause });

/**
 * The local address the OS routes to `deviceIp`. Connecting a UDP socket picks the
 * route and source address without sending a packet.
 */
export async function routedAddress(deviceIp: string): Promise<string> {
  const socket = createSocket(isIPv6(deviceIp) ? 'udp6' : 'udp4');
  try {
    await new Promise<void>((resolve, reject) =>
      socket.connect(80, deviceIp, (err?: Error) => (err ? reject(err) : resolve())),
    );
    return socket.address().address;
  } finally {
    socket.close();
  }
}

/** Listen for the device's download of `gif`. Fails `gif_serve_failed` before any device command is sent. */
export async function openGifHost(gif: Uint8Array, opts: GifHostOptions): Promise<GifHost> {
  const address = await routedAddress(opts.deviceIp).catch((err: Error) => {
    throw gifServeFailed(`No local address routes to ${opts.deviceIp}: ${err.message}`, err);
  });
  const path = `/${randomBytes(16).toString('hex')}.gif`;
  const outcome = Promise.withResolvers<void>();
  outcome.promise.catch(() => {});
  let url = '';
  let claimed = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const server = createServer((req, res) => {
    if (claimed || req.method !== 'GET' || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    claimed = true;
    send(res);
  });

  const close = () => {
    closed = true;
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections();
  };
  const fail = (message: string) => {
    close();
    outcome.reject(gifServeFailed(message));
  };
  const onAbort = () => fail(`The request was cancelled before the device downloaded ${url}.`);
  /** (Re)start the wait; the device has WAIT_MS to request the file, then to move each chunk. */
  const wait = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        fail(
          claimed
            ? `The device's download of ${url} stalled for ${WAIT_MS / 1000} s.`
            : `The device did not request the GIF at ${url} within ${WAIT_MS / 1000} s.`,
        ),
      WAIT_MS,
    );
    timer.unref();
  };

  function send(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': gif.byteLength,
      Connection: 'close',
    });
    res.on('finish', () => {
      close();
      outcome.resolve();
    });
    res.on('close', () => {
      if (!res.writableFinished) fail(`The device dropped the connection mid-download of ${url}.`);
    });
    let offset = 0;
    const pump = () => {
      wait();
      while (offset < gif.byteLength) {
        const chunk = gif.subarray(offset, offset + CHUNK_BYTES);
        offset += chunk.byteLength;
        if (!res.write(chunk)) return;
      }
      res.end();
    };
    res.on('drain', pump);
    pump();
  }

  const port = opts.servePort ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, address, resolve);
  }).catch((err: Error) => {
    close();
    throw gifServeFailed(`Could not listen on ${address}:${port} for the GIF: ${err.message}`, err);
  });
  server.unref();

  const host = opts.serveHost ?? address;
  url = `http://${isIPv6(host) ? `[${host}]` : host}:${(server.address() as AddressInfo).port}${path}`;
  const urlBytes = new TextEncoder().encode(url).length;
  if (urlBytes > MAX_URL_BYTES) {
    close();
    throw gifServeFailed(
      `The GIF URL ${url} is ${urlBytes} bytes; Device/PlayTFGif accepts at most ${MAX_URL_BYTES}. Shorten PIXOO_SERVE_HOST.`,
    );
  }
  if (opts.signal.aborted) {
    close();
    throw gifServeFailed('The request was cancelled before the GIF was played.');
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });

  return {
    address,
    url,
    close,
    served() {
      if (!claimed) wait();
      return outcome.promise;
    },
  };
}
