/**
 * @fileoverview Tests for the one-shot GIF host: routed-address bind, the single GET,
 * 404s that leave it open, and every failure ending with the listener closed. Every
 * listener here binds 127.0.0.1 — the address the OS routes to a device at 127.0.0.1.
 * @module tests/services/pixoo/gif-host.test
 */

import { createServer, type Server, connect as tcpConnect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GifHost, openGifHost, routedAddress } from '@/services/pixoo/gif-host.js';

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4]);
/** Large enough to fill the loopback socket buffers of a client that stops reading. */
const BIG = new Uint8Array(32 * 1024 * 1024);

const hosts: GifHost[] = [];
const blockers: Server[] = [];

async function open(gif: Uint8Array, opts: Partial<Parameters<typeof openGifHost>[1]> = {}) {
  const host = await openGifHost(gif, {
    deviceIp: '127.0.0.1',
    signal: new AbortController().signal,
    ...opts,
  });
  hosts.push(host);
  return host;
}

/** Whether a TCP connection to 127.0.0.1:`port` is accepted. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Track whether a promise has settled, without letting a rejection go unhandled. */
function track(promise: Promise<void>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** Let pending I/O callbacks and microtasks run. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Open a raw connection, send a GET for `url`, and hand back the socket. */
function rawGet(url: string) {
  const { pathname, port } = new URL(url);
  const socket = tcpConnect(Number(port), '127.0.0.1');
  socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  socket.on('error', () => {});
  return socket;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.close();
  for (const server of blockers.splice(0)) server.close();
});

describe('routedAddress', () => {
  it('resolves the local address the OS routes to the device', async () => {
    expect(await routedAddress('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('openGifHost', () => {
  it('binds the routed address and serves one GET at a random 128-bit path', async () => {
    const host = await open(GIF);
    expect(host.address).toBe('127.0.0.1');
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.gif$/);

    const served = host.served();
    const res = await fetch(host.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GIF);
    await expect(served).resolves.toBeUndefined();
    expect(await accepts(portOf(host.url))).toBe(false);
  });

  it('draws a fresh path for every host', async () => {
    const first = await open(GIF);
    const second = await open(GIF);
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname);
  });

  it('answers a wrong path or method with 404 and stays open for the real GET', async () => {
    const host = await open(GIF);
    const served = track(host.served());
    const origin = new URL(host.url).origin;

    expect((await fetch(`${origin}/${'0'.repeat(32)}.gif`)).status).toBe(404);
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(host.url, { method: 'POST' })).status).toBe(404);
    expect((await fetch(host.url, { method: 'HEAD' })).status).toBe(404);
    expect(served.settled).toBe(false);
    expect(await accepts(portOf(host.url))).toBe(true);

    const res = await fetch(host.url);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GIF);
  });

  it('refuses a second GET after a completed download', async () => {
    const host = await open(GIF);
    const served = host.served();
    await (await fetch(host.url)).arrayBuffer();
    await served;
    await expect(fetch(host.url)).rejects.toThrow();
  });

  it('fails gif_serve_failed when the device never requests the GIF within 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = await open(GIF);
    const served = host.served();
    const state = track(served);

    vi.advanceTimersByTime(9_999);
    await flush();
    expect(state.settled).toBe(false);
    vi.advanceTimersByTime(1);

    const error = (await served.catch((err: unknown) => err)) as McpError;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'gif_serve_failed' },
    });
    expect(error.message).toMatch(
      /did not request the GIF at http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.gif within 10 s/,
    );
    expect(error.data).not.toHaveProperty('retryable');
    expect(await accepts(portOf(host.url))).toBe(false);
  });

  it('fails gif_serve_failed when the transfer stalls for 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = await open(BIG);
    const served = host.served();
    const state = track(served);

    // A client that stops reading: the socket buffers fill and the transfer stops moving.
    const socket = rawGet(host.url);
    await new Promise((resolve) => socket.once('readable', resolve));
    await sleep(300);

    vi.advanceTimersByTime(9_999);
    await flush();
    expect(state.settled).toBe(false);
    vi.advanceTimersByTime(1);

    const error = (await served.catch((err: unknown) => err)) as McpError;
    expect(error).toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(error.message).toMatch(/stalled for 10 s/);
    expect(await accepts(portOf(host.url))).toBe(false);
    socket.destroy();
  });

  it('fails gif_serve_failed when the device drops the connection mid-transfer', async () => {
    const host = await open(BIG);
    const served = host.served();
    const socket = rawGet(host.url);
    socket.once('data', () => socket.destroy());

    const error = (await served.catch((err: unknown) => err)) as McpError;
    expect(error).toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(error.message).toMatch(/dropped the connection/);
    expect(await accepts(portOf(host.url))).toBe(false);
  });

  it('closes and fails gif_serve_failed when the request is cancelled', async () => {
    const controller = new AbortController();
    const host = await open(GIF, { signal: controller.signal });
    const served = host.served();
    controller.abort();

    await expect(served).rejects.toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(await accepts(portOf(host.url))).toBe(false);
  });

  it('fails gif_serve_failed without staying open when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const servePort = await freePort();

    await expect(open(GIF, { signal: controller.signal, servePort })).rejects.toMatchObject({
      data: { reason: 'gif_serve_failed' },
    });
    expect(await accepts(servePort)).toBe(false);
  });

  it('advertises PIXOO_SERVE_HOST and PIXOO_SERVE_PORT while binding the routed address', async () => {
    const host = await open(GIF, { serveHost: 'pixoo-host.lan', servePort: 8765 });
    expect(host.address).toBe('127.0.0.1');
    expect(host.url).toMatch(/^http:\/\/pixoo-host\.lan:8765\/[0-9a-f]{32}\.gif$/);

    const served = host.served();
    const res = await fetch(`http://127.0.0.1:8765${new URL(host.url).pathname}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GIF);
    await served;
  });

  it('fails gif_serve_failed when the port is already in use', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as { port: number };

    await expect(open(GIF, { servePort: port })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'gif_serve_failed' },
    });
  });

  it('fails gif_serve_failed and closes when the URL runs past 255 bytes', async () => {
    const servePort = await freePort();
    // http://<host>:<port>/<32 hex>.gif is 45 bytes plus the host and the port digits.
    const hostLength = 255 - 45 - String(servePort).length;

    const fits = await open(GIF, { serveHost: 'h'.repeat(hostLength), servePort });
    expect(new TextEncoder().encode(fits.url).length).toBe(255);
    fits.close();

    const error = (await open(GIF, { serveHost: 'h'.repeat(hostLength + 1), servePort }).catch(
      (err: unknown) => err,
    )) as McpError;
    expect(error).toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(error.message).toMatch(/256 bytes.*at most 255/);
    expect(await accepts(servePort)).toBe(false);
  });
});
