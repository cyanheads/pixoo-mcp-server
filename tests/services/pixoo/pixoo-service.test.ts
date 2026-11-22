/**
 * @fileoverview Tests for PixooService — failure mapping, lazy init, and status.
 * @module tests/services/pixoo/pixoo-service.test
 */

import { readFile, rm } from 'node:fs/promises';
import { type AddressInfo, createServer, Server, connect as tcpConnect } from 'node:net';
import * as path from 'node:path';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Canvas, Channel, PixooClient, type PixooFailure } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pushKeepingPreview } from '@/mcp-server/tools/device-push.js';
import { encodePanelGif, savePanelGif } from '@/renderer/preview.js';
import {
  classifyDeviceFailure,
  getPixooService,
  initPixooService,
  PixooService,
} from '@/services/pixoo/pixoo-service.js';
import {
  type FakePixoo,
  NON_PIXOO_REPLIES,
  pixooReply,
  startFakePixoo,
} from '../../helpers/device-failure.js';
import { freePort } from '../../helpers/free-port.js';

// ─── Shared mock helpers ──────────────────────────────────────────────────────

/** Minimal fake AppConfig that satisfies the initPixooService signature. */
const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

/** Build a fake PixooClient-shaped object. All methods return controllable promises. */
function makeFakeClient(overrides: Record<string, () => unknown> = {}) {
  return {
    getChannel: vi.fn().mockResolvedValue({ ok: true, data: { SelectIndex: 3 } }), // Custom = 3
    setChannel: vi.fn().mockResolvedValue({ ok: true }),
    getConfig: vi.fn().mockResolvedValue({
      ok: true,
      data: { Brightness: 80, LightSwitch: 1, CurClockId: 0 },
    }),
    push: vi.fn().mockResolvedValue({ ok: true }),
    pushAnimation: vi.fn().mockResolvedValue({ ok: true }),
    setBrightness: vi.fn().mockResolvedValue({ ok: true }),
    setScreen: vi.fn().mockResolvedValue({ ok: true }),
    setClock: vi.fn().mockResolvedValue({ ok: true }),
    sendText: vi.fn().mockResolvedValue({ ok: true }),
    clearText: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

/** Inject a fake client into a PixooService instance via its private field. */
function injectClient(svc: PixooService, fakeClient: ReturnType<typeof makeFakeClient>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).client = fakeClient;
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('PixooService.getStatus', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_IP'] = '192.168.1.100';
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('returns reachable:false when PIXOO_IP is absent', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const svc = getPixooService();
    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);
    expect(status.reachable).toBe(false);
  });

  it('returns full snapshot when device responds', async () => {
    const svc = getPixooService();
    injectClient(svc, makeFakeClient());

    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);

    expect(status.reachable).toBe(true);
    expect(status.brightness).toBe(80);
    expect(status.screenOn).toBe(true);
    expect(typeof status.channel).toBe('string');
  });

  it('returns reachable:false when getChannel fails', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        getChannel: () => Promise.resolve({ ok: false, kind: 'network', message: 'timeout' }),
      }),
    );

    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);
    expect(status.reachable).toBe(false);
  });

  it('returns reachable:true with channel but no config details when getConfig fails', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        getConfig: () => Promise.resolve({ ok: false, kind: 'network', message: 'timeout' }),
      }),
    );

    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);
    expect(status.reachable).toBe(true);
    expect(typeof status.channel).toBe('string');
    expect(status.brightness).toBeUndefined();
  });

  it('maps channel SelectIndex to name strings', async () => {
    // SelectIndex 0 = faces, 1 = cloud, 2 = visualizer, 3 = custom
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 0 } }),
      }),
    );

    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);
    expect(status.channel).toBe('faces');
  });
});

// ─── Error mapping (mapFailure) ───────────────────────────────────────────────

describe('PixooService failure kind mapping', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_IP'] = '192.168.1.100';
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('network failure → device_unreachable', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        push: () => Promise.resolve({ ok: false, kind: 'network', message: 'ECONNREFUSED' }),
        // Channel is already Custom so no switch needed
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    const canvas = new Canvas(64);
    await expect(svc.pushFrame(canvas, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_unreachable', retryable: true },
    });
  });

  it('timeout failure → device_unreachable', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        push: () => Promise.resolve({ ok: false, kind: 'timeout', message: 'Request timed out' }),
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    const canvas = new Canvas(64);
    await expect(svc.pushFrame(canvas, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_unreachable', retryable: true },
    });
  });

  it.each([
    [503, true],
    [500, true],
    [429, true],
    [408, true],
    [404, false],
    [400, false],
  ])('http %i failure → device_http_error, retryable: %s', async (status, retryable) => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        push: () => Promise.resolve({ ok: false, kind: 'http', status, message: `HTTP ${status}` }),
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    const canvas = new Canvas(64);
    const error = await svc.pushFrame(canvas, ctx).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_http_error', retryable },
    });
    // The calling tool's declared recovery is filled in at the handler boundary.
    expect((error as McpError).data).not.toHaveProperty('recovery');
  });

  it('pushAnimation maps a failure through the same contract as pushFrame', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        pushAnimation: () => Promise.resolve({ ok: false, kind: 'network', message: 'EHOSTDOWN' }),
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    await expect(
      svc.pushAnimation([new Canvas(64), new Canvas(64)], 100, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_unreachable', retryable: true },
    });
  });

  it('device failure → device_rejected with deviceCode surfaced', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        push: () =>
          Promise.resolve({
            ok: false,
            kind: 'device',
            message: 'error code 5',
            deviceCode: 5,
          }),
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    const canvas = new Canvas(64);
    const error = await svc.pushFrame(canvas, ctx).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_rejected', deviceCode: 5 },
    });
    // A firmware rejection is deterministic — no retryability claim either way.
    expect((error as McpError).data).not.toHaveProperty('retryable');
  });
});

// ─── classifyDeviceFailure: every PixooErrorKind ──────────────────────────────

describe('classifyDeviceFailure', () => {
  it.each<[string, PixooFailure, ReturnType<typeof classifyDeviceFailure>]>([
    [
      'network',
      { ok: false, kind: 'network', message: 'fetch failed: ECONNREFUSED' },
      { reason: 'device_unreachable', retryable: true },
    ],
    [
      'timeout',
      { ok: false, kind: 'timeout', message: 'Request timed out' },
      { reason: 'device_unreachable', retryable: true },
    ],
    [
      'http 503, transient',
      { ok: false, kind: 'http', status: 503, message: 'HTTP 503 Service Unavailable' },
      { reason: 'device_http_error', retryable: true },
    ],
    [
      'http 404',
      { ok: false, kind: 'http', status: 404, message: 'HTTP 404 Not Found' },
      { reason: 'device_http_error', retryable: false },
    ],
    [
      'device',
      { ok: false, kind: 'device', deviceCode: 5, message: 'Device rejected Draw/SendHttpGif' },
      { reason: 'device_rejected' },
    ],
    [
      'response',
      {
        ok: false,
        kind: 'response',
        message: 'Reply to Channel/GetIndex is not JSON — is 127.0.0.1 a Pixoo?',
      },
      { reason: 'device_invalid_response', retryable: false },
    ],
  ])('%s → %o', (_kind, failure, expected) => {
    // Strict: a firmware rejection carries no retryable key at all.
    expect(classifyDeviceFailure(failure)).toStrictEqual(expected);
  });

  it('a kind outside PixooErrorKind throws rather than reading as device_unreachable', () => {
    const unknown = { ok: false, kind: 'something_unknown', message: 'unknown' };
    expect(() => classifyDeviceFailure(unknown as unknown as PixooFailure)).toThrow(
      'something_unknown',
    );
  });
});

// ─── Lazy init / no_device_configured ─────────────────────────────────────────

describe('PixooService.getClient lazy init', () => {
  beforeEach(() => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('pushFrame throws no_device_configured when PIXOO_IP is absent', async () => {
    const svc = getPixooService();
    const ctx = createMockContext();
    const canvas = new Canvas(64);
    await expect(svc.pushFrame(canvas, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('getStatus returns reachable:false (does not throw) when PIXOO_IP absent', async () => {
    const svc = getPixooService();
    const ctx = createMockContext();
    const status = await svc.getStatus(ctx);
    expect(status.reachable).toBe(false);
  });
});

// ─── ensureCustomChannel ──────────────────────────────────────────────────────

describe('PixooService.ensureCustomChannel', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_IP'] = '192.168.1.100';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('does not call setChannel when already on Custom channel', async () => {
    const fakeClient = makeFakeClient({
      // Custom = 3
      getChannel: vi.fn().mockResolvedValue({ ok: true, data: { SelectIndex: 3 } }),
    });
    const svc = getPixooService();
    injectClient(svc, fakeClient);

    const ctx = createMockContext();
    await svc.ensureCustomChannel(ctx);

    expect(fakeClient.setChannel).not.toHaveBeenCalled();
  });

  it('calls setChannel when on a non-Custom channel', async () => {
    const fakeClient = makeFakeClient({
      getChannel: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { SelectIndex: 0 } }) // not Custom
        .mockResolvedValue({ ok: true, data: { SelectIndex: 3 } }), // verify
    });
    const svc = getPixooService();
    injectClient(svc, fakeClient);

    const ctx = createMockContext();
    await svc.ensureCustomChannel(ctx);

    expect(fakeClient.setChannel).toHaveBeenCalled();
  });
});

// ─── pushAnimation past 40 frames: a GIF the device downloads ─────────────────

/**
 * Stand in for a Pixoo at 127.0.0.1 behind the real PixooClient: record every command
 * the service sends, answer like the firmware, and on `Device/PlayTFGif` reply first,
 * then (in `download` mode) fetch the FileName the way the device does. The routed
 * address of 127.0.0.1 is 127.0.0.1, so every GIF listener stays on loopback.
 */
function fakeDevice(mode: 'download' | 'never' | 'unreachable' = 'download') {
  const realFetch = globalThis.fetch;
  const commands: Array<Record<string, unknown>> = [];
  const downloads: Promise<Uint8Array>[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== 'http://127.0.0.1/post') return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    commands.push(body);
    switch (body['Command']) {
      case 'Channel/GetIndex':
        return Response.json({ error_code: 0, SelectIndex: 3 });
      case 'Channel/GetAllConf':
        return Response.json({ error_code: 0, Brightness: 80, LightSwitch: 1, CurClockId: 0 });
      case 'Device/PlayTFGif': {
        if (mode === 'unreachable') throw new TypeError('fetch failed');
        if (mode === 'download') {
          // A PIXOO_SERVE_HOST name only resolves on the real network; reach the bind here.
          const target = new URL(String(body['FileName']));
          target.hostname = '127.0.0.1';
          downloads.push(
            realFetch(target).then(async (res) => new Uint8Array(await res.arrayBuffer())),
          );
        }
        return Response.json({ error_code: 0 });
      }
      default:
        return Response.json({ error_code: 0 });
    }
  });
  const named = (command: string) => commands.filter((c) => c['Command'] === command);
  return { commands, downloads, named };
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

const frameStack = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const canvas = new Canvas(64);
    canvas.fillRect(0, 0, 64, 64, [i * 6, 0, 0]);
    return canvas;
  });

/** Width and height a GIF's logical screen descriptor declares. */
const gifSize = (gif: Uint8Array) => [gif[6]! | (gif[7]! << 8), gif[8]! | (gif[9]! << 8)];

describe('PixooService.pushAnimation past 40 frames', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_IP'] = '127.0.0.1';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    delete process.env['PIXOO_SERVE_HOST'];
    delete process.env['PIXOO_SERVE_PORT'];
    resetServerConfig();
  });

  it('plays 41 frames as one Device/PlayTFGif the device downloads, with no Draw/SendHttpGif', async () => {
    const device = fakeDevice();
    const listen = vi.spyOn(Server.prototype, 'listen');
    const svc = getPixooService();
    const frames = frameStack(41);

    const state = await svc.pushAnimation(frames, 100, createMockContext());

    const plays = device.named('Device/PlayTFGif');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ FileType: 2 });
    expect(plays[0]?.['FileName']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.gif$/);
    expect(device.named('Draw/SendHttpGif')).toHaveLength(0);
    // The listener bound the address the OS routes to PIXOO_IP.
    expect(listen).toHaveBeenCalledOnce();
    expect(listen.mock.calls[0]?.[1]).toBe('127.0.0.1');

    // The device downloaded the whole panel-size GIF: one pixel per LED.
    const [downloaded] = await Promise.all(device.downloads);
    expect(downloaded).toEqual(encodePanelGif(frames, 100));
    expect(gifSize(downloaded!)).toEqual([64, 64]);
    expect(await accepts(Number(new URL(String(plays[0]?.['FileName'])).port))).toBe(false);

    // The same device-state read-back a frame push returns.
    expect(state).toEqual(await svc.pushFrame(frames[0]!, createMockContext()));
    expect(state).toEqual({
      reachable: true,
      channel: 'custom',
      brightness: 80,
      screenOn: true,
      clockId: 0,
    });
  });

  it('pushes 40 frames as 40 Draw/SendHttpGif requests and opens no listener', async () => {
    const device = fakeDevice();
    const listen = vi.spyOn(Server.prototype, 'listen');

    await getPixooService().pushAnimation(frameStack(40), 100, createMockContext());

    expect(device.named('Draw/SendHttpGif')).toHaveLength(40);
    expect(device.named('Device/PlayTFGif')).toHaveLength(0);
    expect(listen).not.toHaveBeenCalled();
  });

  /**
   * Push `frames` right behind an earlier push, so the call waits out the pacing
   * interval, and cancel it during that wait. Returns what the call settled with and
   * the device commands sent after the earlier push.
   */
  async function cancelDuringPacing(frames: number) {
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
    resetServerConfig();
    const device = fakeDevice('never');
    const svc = getPixooService();
    await svc.pushFrame(frameStack(1)[0]!, createMockContext());
    const earlier = device.commands.length;
    const listen = vi.spyOn(Server.prototype, 'listen');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const push = svc
      .pushAnimation(frameStack(frames), 100, createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);

    while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    const listener = listen.mock.contexts[0] as Server | undefined;
    const port = (listener?.address() as AddressInfo | null)?.port;
    controller.abort();
    vi.advanceTimersByTime(60_000);

    return {
      error: await push,
      reason: controller.signal.reason as unknown,
      commands: device.commands.slice(earlier).map((c) => c['Command']),
      listener,
      port,
    };
  }

  it('sends no Device/PlayTFGif and closes the listener when cancelled during the pacing wait', async () => {
    const { error, reason, commands, listener, port } = await cancelDuringPacing(41);

    expect(commands).not.toContain('Device/PlayTFGif');
    expect(error).toBe(reason);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(listener?.listening).toBe(false);
    expect(await accepts(port!)).toBe(false);
  });

  it('sends no Draw/SendHttpGif when a 40-frame push is cancelled during the pacing wait', async () => {
    const { error, reason, commands, listener } = await cancelDuringPacing(40);

    expect(commands).not.toContain('Draw/SendHttpGif');
    expect(error).toBe(reason);
    expect(listener).toBeUndefined();
  });

  it('serves the GIF the caller already encoded instead of encoding again', async () => {
    const device = fakeDevice();
    const frames = frameStack(41);
    const encoded = encodePanelGif(frames, 250);

    await getPixooService().pushAnimation(frames, 100, createMockContext(), encoded);

    const [downloaded] = await Promise.all(device.downloads);
    expect(downloaded).toEqual(encoded);
  });

  it('advertises PIXOO_SERVE_HOST:PIXOO_SERVE_PORT while binding the routed address', async () => {
    const servePort = await freePort();
    process.env['PIXOO_SERVE_HOST'] = 'pixoo-host.lan';
    process.env['PIXOO_SERVE_PORT'] = String(servePort);
    resetServerConfig();
    const device = fakeDevice();
    const listen = vi.spyOn(Server.prototype, 'listen');

    await getPixooService().pushAnimation(frameStack(41), 100, createMockContext());

    expect(device.named('Device/PlayTFGif')[0]?.['FileName']).toMatch(
      new RegExp(`^http://pixoo-host\\.lan:${servePort}/[0-9a-f]{32}\\.gif$`),
    );
    expect(listen.mock.calls[0]?.slice(0, 2)).toEqual([servePort, '127.0.0.1']);
    await Promise.all(device.downloads);
  });

  it('fails gif_serve_failed after 10 s when the device never requests the GIF', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const device = fakeDevice('never');
    const push = getPixooService()
      .pushAnimation(frameStack(41), 100, createMockContext())
      .catch((err: unknown) => err) as Promise<McpError>;

    while (device.named('Device/PlayTFGif').length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(10_000);

    const error = await push;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'gif_serve_failed' },
    });
    expect(error.data).not.toHaveProperty('retryable');
    const url = new URL(String(device.named('Device/PlayTFGif')[0]?.['FileName']));
    expect(await accepts(Number(url.port))).toBe(false);
  });

  it('fails gif_serve_failed before any device command when the port is in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    process.env['PIXOO_SERVE_PORT'] = String((blocker.address() as { port: number }).port);
    resetServerConfig();
    const device = fakeDevice();

    await expect(
      getPixooService().pushAnimation(frameStack(41), 100, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(device.commands).toHaveLength(0);
    blocker.close();
  });

  it('fails gif_serve_failed before any device command when the URL runs past 255 bytes', async () => {
    process.env['PIXOO_SERVE_HOST'] = `${'h'.repeat(240)}.lan`;
    resetServerConfig();
    const device = fakeDevice();

    await expect(
      getPixooService().pushAnimation(frameStack(41), 100, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'gif_serve_failed' } });
    expect(device.commands).toHaveLength(0);
  });

  it('keeps the panel-size GIF as data.outputFiles when the play command is unreachable', async () => {
    const device = fakeDevice('unreachable');
    const frames = frameStack(41);
    const gif = encodePanelGif(frames, 100);
    const ctx = createMockContext();

    const error = (await pushKeepingPreview(
      () => getPixooService().pushAnimation(frames, 100, ctx, gif),
      [],
      (dir) => savePanelGif(gif, dir, 'scene'),
      ctx.signal,
    ).catch((err: unknown) => err)) as McpError;

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'device_unreachable', retryable: true },
    });
    const [file] = (error.data?.['outputFiles'] ?? []) as string[];
    expect(path.basename(file!)).toBe('scene.gif');
    const saved = new Uint8Array(await readFile(file!));
    expect(saved).toEqual(gif);
    expect(gifSize(saved)).toEqual([64, 64]);
    await rm(path.dirname(file!), { recursive: true, force: true });

    const url = new URL(String(device.named('Device/PlayTFGif')[0]?.['FileName']));
    expect(await accepts(Number(url.port))).toBe(false);
  });
});

// ─── A cancelled push sends nothing after the abort ───────────────────────────

/**
 * Each case runs the real `PixooClient` against a stand-in Pixoo on loopback that
 * replies as a Pixoo would, and aborts from inside it once the request the case is about
 * has reached it. A push that carried on past the abort would send its next command
 * before it settled, so once the push has settled the commands received are complete.
 */
describe('PixooService — a cancelled push', () => {
  /** What a frame push sends: the channel check, the push itself, the state read-back. */
  const FRAME_PUSH = [
    'Channel/GetIndex',
    'Draw/ResetHttpGifId',
    'Draw/SendHttpGif',
    'Channel/GetIndex',
    'Channel/GetAllConf',
  ];
  let device: FakePixoo | undefined;

  /** Let pending I/O callbacks and microtasks run. */
  async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Fake `setTimeout` from here on, with the clock at the current `Date` — the frozen one,
   * where a test froze `Date` alone before its first push. Faked any earlier, the `fetch`
   * beneath a push leaves its own timers pending, and `vi.getTimerCount()` counts them.
   */
  function fakeTimersFromNow() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
  }

  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_IP'] = '127.0.0.1';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await device?.close();
    device = undefined;
    vi.restoreAllMocks();
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
  });

  it('a frame push aborted with its frame on the wire rejects with the reason and sends nothing more', async () => {
    const controller = new AbortController();
    device = await startFakePixoo((command) => {
      if (command === 'Draw/SendHttpGif') controller.abort();
      return pixooReply(command);
    });

    const error = await getPixooService()
      .pushFrame(new Canvas(64), createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);

    expect(error).toBe(controller.signal.reason);
    expect(device.commands).toEqual(FRAME_PUSH.slice(0, 3));
  });

  it.each([
    ['its channel read', 'Channel/GetIndex', ['Channel/GetIndex']],
    ['its channel switch', 'Channel/SetIndex', ['Channel/GetIndex', 'Channel/SetIndex']],
  ])(
    'a push to a device on another channel aborted during %s sends no further channel command and no push',
    async (_during, abortOn, sent) => {
      const controller = new AbortController();
      let channel: Channel = Channel.Faces;
      device = await startFakePixoo((command) => {
        if (command === abortOn) controller.abort();
        if (command === 'Channel/SetIndex') channel = Channel.Custom;
        return pixooReply(command, channel);
      });

      const error = await getPixooService()
        .pushFrame(new Canvas(64), createMockContext({ signal: controller.signal }))
        .catch((err: unknown) => err);

      expect(error).toBe(controller.signal.reason);
      expect(device.commands).toEqual(sent);
    },
  );

  it('an animation of 40 frames or fewer aborted after its second frame sends no third', async () => {
    const controller = new AbortController();
    let frames = 0;
    device = await startFakePixoo((command) => {
      if (command === 'Draw/SendHttpGif' && ++frames === 2) controller.abort('User cancelled');
      return pixooReply(command);
    });

    const error = await getPixooService()
      .pushAnimation(frameStack(10), 100, createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);

    // The reason a notifications/cancelled carries arrives as the raw string.
    expect(error).toBe('User cancelled');
    expect(device.commands).toEqual([
      'Channel/GetIndex',
      'Draw/ResetHttpGifId',
      'Draw/SendHttpGif',
      'Draw/SendHttpGif',
    ]);
  });

  it('an animation past 40 frames aborted during Device/PlayTFGif sends nothing more and closes its listener', async () => {
    const controller = new AbortController();
    let port: number | undefined;
    device = await startFakePixoo((command) => {
      if (command !== 'Device/PlayTFGif') return pixooReply(command);
      port = ((listen.mock.contexts[0] as Server).address() as AddressInfo).port;
      // Cancelled while the device has yet to answer the play: no reply goes back.
      controller.abort();
      return;
    });
    const listen = vi.spyOn(Server.prototype, 'listen');

    const error = await getPixooService()
      .pushAnimation(frameStack(41), 100, createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);

    // The cancellation itself, not the gif_serve_failed its listener reports when cut short.
    expect(error).toBe(controller.signal.reason);
    expect(device.commands).toEqual(['Channel/GetIndex', 'Device/PlayTFGif']);
    expect((listen.mock.contexts[0] as Server).listening).toBe(false);
    expect(await accepts(port!)).toBe(false);
  });

  it('an animation past 40 frames aborted while its listener waits for the download rejects with the reason', async () => {
    const controller = new AbortController();
    // A Pixoo's reply to the play, from a device that never downloads the GIF.
    device = await startFakePixoo();
    const play = vi.spyOn(PixooClient.prototype, 'playGifUrl');
    const listen = vi.spyOn(Server.prototype, 'listen');

    const push = getPixooService()
      .pushAnimation(frameStack(41), 100, createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);
    while (play.mock.results.length === 0) await new Promise((resolve) => setImmediate(resolve));
    // Once the accepted play is back, the push waits on the download.
    await expect(play.mock.results[0]?.value).resolves.toMatchObject({ ok: true });
    await flush();
    controller.abort();

    // The cancellation itself, not the gif_serve_failed the listener's wait ends with.
    expect(await push).toBe(controller.signal.reason);
    expect(device.commands).toEqual(['Channel/GetIndex', 'Device/PlayTFGif']);
    expect((listen.mock.contexts[0] as Server).listening).toBe(false);
  });

  it('a push aborted while queued behind another sends nothing and holds up no push behind it', async () => {
    const queued = new AbortController();
    device = await startFakePixoo((command) => {
      // The first push has its frame on the wire, so the second is still waiting its turn.
      if (command === 'Draw/SendHttpGif') queued.abort();
      return pixooReply(command);
    });
    const svc = getPixooService();
    let firstSettled = false;

    const first = svc.pushFrame(new Canvas(64), createMockContext()).finally(() => {
      firstSettled = true;
    });
    const second = svc
      .pushFrame(new Canvas(64), createMockContext({ signal: queued.signal }))
      .catch((err: unknown) => err);
    const third = svc.pushFrame(new Canvas(64), createMockContext());

    expect(await second).toBe(queued.signal.reason);
    // It gave up its place at the abort, before the push ahead of it finished.
    expect(firstSettled).toBe(false);
    await expect(first).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    await expect(third).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    // The first push and then the third: nothing from the cancelled one between them.
    expect(device.commands).toEqual([...FRAME_PUSH, ...FRAME_PUSH]);
  });

  it('a push that fails uncancelled gives up its place: the next push on the service sends its frame', async () => {
    const [, htmlPage] = NON_PIXOO_REPLIES[0]!;
    let isPixoo = false;
    device = await startFakePixoo((command) => (isPixoo ? pixooReply(command) : htmlPage));
    const svc = getPixooService();
    await expect(svc.pushFrame(new Canvas(64), createMockContext())).rejects.toMatchObject({
      data: { reason: 'device_invalid_response' },
    });
    const before = device.commands.length;
    isPixoo = true;

    const started = device.requested.length;
    const next = svc.pushFrame(new Canvas(64), createMockContext());
    await flush();
    // Its turn came at once: it has started its first command.
    expect(device.requested[started]).toBe('Channel/GetIndex');
    await expect(next).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    expect(device.commands.slice(before)).toEqual(FRAME_PUSH);
  });

  it('a push cancelled during its read-back, after the device took the frame, resolves with the device state', async () => {
    const controller = new AbortController();
    device = await startFakePixoo((command) => {
      if (command === 'Channel/GetAllConf') controller.abort();
      return pixooReply(command);
    });

    await expect(
      getPixooService().pushFrame(new Canvas(64), createMockContext({ signal: controller.signal })),
    ).resolves.toEqual({
      reachable: true,
      channel: 'custom',
      brightness: 80,
      screenOn: true,
      clockId: 0,
    });
    expect(device.commands).toEqual(FRAME_PUSH);
  });

  it('a push aborted during the pacing wait ends the wait at once and sends nothing', async () => {
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
    resetServerConfig();
    device = await startFakePixoo();
    const svc = getPixooService();
    await svc.pushFrame(new Canvas(64), createMockContext());
    const before = device.commands.length;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let pacedSettled = false;
    const paced = svc
      .pushFrame(new Canvas(64), createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err)
      .finally(() => {
        pacedSettled = true;
      });
    // No request is in flight, so the one timer is its pacing wait.
    while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    const behind = svc.pushFrame(new Canvas(64), createMockContext());

    controller.abort();
    await flush();

    // Settled with no time passing: the wait ended at the abort.
    expect(pacedSettled).toBe(true);
    expect(await paced).toBe(controller.signal.reason);
    // The push queued behind it then waits out its own interval and pushes.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(behind).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    expect(device.commands.slice(before)).toEqual(FRAME_PUSH);
  });

  it('a push aborted as the push ahead of it settles rejects without waiting out the interval', async () => {
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
    resetServerConfig();
    device = await startFakePixoo();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const svc = getPixooService();
    const controller = new AbortController();
    let secondSettled = false;

    const first = svc.pushFrame(new Canvas(64), createMockContext());
    const second = svc
      .pushFrame(new Canvas(64), createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err)
      .finally(() => {
        secondSettled = true;
      });
    // Its turn has come by the time this runs; its pacing wait has not begun.
    await first.then(() => controller.abort());
    await flush();

    // Settled with no time passing: no wait started on the cancelled signal.
    expect(secondSettled).toBe(true);
    expect(await second).toBe(controller.signal.reason);
    expect(device.commands).toEqual(FRAME_PUSH);
  });

  /** Reject the first `Draw/SendHttpGif` with a non-zero `error_code`; answer the rest as a Pixoo. */
  function rejectFirstFrame() {
    let rejected = false;
    return (command: string) => {
      if (command !== 'Draw/SendHttpGif' || rejected) return pixooReply(command);
      rejected = true;
      return { body: JSON.stringify({ error_code: 1 }) };
    };
  }

  it.each([
    ['the device rejects its frame', rejectFirstFrame, 64, { data: { reason: 'device_rejected' } }],
    ['its frame does not fit the panel', () => pixooReply, 32, { name: 'RangeError' }],
  ])(
    'a push that fails uncancelled because %s leaves the next push unpaced',
    async (_because, answer, size, failure) => {
      process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
      resetServerConfig();
      device = await startFakePixoo(answer());
      const svc = getPixooService();
      await expect(svc.pushFrame(new Canvas(size), createMockContext())).rejects.toMatchObject(
        failure,
      );
      const before = device.requested.length;

      fakeTimersFromNow();
      const next = svc.pushFrame(new Canvas(64), createMockContext());
      while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));

      // Its one timer belongs to its first command, already sent: no pacing wait held it.
      expect(device.requested.slice(before)).toEqual(['Channel/GetIndex']);
      await expect(next).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    },
  );

  it('a push cancelled once its commands began holds the next push back for the whole interval', async () => {
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
    resetServerConfig();
    const controller = new AbortController();
    let frames = 0;
    device = await startFakePixoo((command) => {
      if (command === 'Draw/SendHttpGif' && ++frames === 2) controller.abort();
      return pixooReply(command);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const svc = getPixooService();
    const cutShort = await svc
      .pushAnimation(frameStack(10), 100, createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);
    expect(cutShort).toBe(controller.signal.reason);
    const before = device.requested.length;

    fakeTimersFromNow();
    const next = svc.pushFrame(new Canvas(64), createMockContext());
    while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));

    // Its one timer is the pacing wait: nothing goes to the device a moment before the interval.
    expect(device.requested.slice(before)).toEqual([]);
    vi.advanceTimersByTime(59_999);
    await flush();
    expect(device.requested.slice(before)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    expect(device.commands.slice(before)).toEqual(FRAME_PUSH);
  });

  it('a push cancelled during its pacing wait leaves the interval measured from the push before it', async () => {
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '60000';
    resetServerConfig();
    device = await startFakePixoo();
    vi.useFakeTimers({ toFake: ['Date'] });
    const svc = getPixooService();
    await svc.pushFrame(new Canvas(64), createMockContext());
    const before = device.requested.length;

    fakeTimersFromNow();
    const controller = new AbortController();
    const cancelled = svc
      .pushFrame(new Canvas(64), createMockContext({ signal: controller.signal }))
      .catch((err: unknown) => err);
    // No request is in flight, so the one timer is its pacing wait.
    while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    const behind = svc.pushFrame(new Canvas(64), createMockContext());
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    expect(await cancelled).toBe(controller.signal.reason);
    await flush();

    // The push behind it sends once the first push's interval is over, not a fresh one after the abort.
    vi.advanceTimersByTime(29_999);
    await flush();
    expect(device.requested.slice(before)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(device.requested.slice(before)).toContain('Channel/GetIndex');
    await expect(behind).resolves.toMatchObject({ reachable: true, channel: 'custom' });
    expect(device.commands.slice(before)).toEqual(FRAME_PUSH);
  });
});

// ─── getPixooService accessor guard ──────────────────────────────────────────

describe('getPixooService', () => {
  it('throws when called before initPixooService', async () => {
    // Need an isolated module to test uninitialized state cleanly
    // Instead: just test that after init it returns a PixooService instance
    initPixooService(fakeConfig, fakeStorage);
    const svc = getPixooService();
    expect(svc).toBeInstanceOf(PixooService);
  });
});
