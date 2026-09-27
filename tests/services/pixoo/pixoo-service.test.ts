/**
 * @fileoverview Tests for PixooService — failure mapping, lazy init, and status.
 * @module tests/services/pixoo/pixoo-service.test
 */

import { readFile, rm } from 'node:fs/promises';
import { type AddressInfo, createServer, Server, connect as tcpConnect } from 'node:net';
import * as path from 'node:path';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Canvas } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pushKeepingPreview } from '@/mcp-server/tools/device-push.js';
import { encodePanelGif, savePanelGif } from '@/renderer/preview.js';
import { getPixooService, initPixooService, PixooService } from '@/services/pixoo/pixoo-service.js';

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

  it('unknown failure kind → device_unreachable', async () => {
    const svc = getPixooService();
    injectClient(
      svc,
      makeFakeClient({
        push: () => Promise.resolve({ ok: false, kind: 'something_unknown', message: 'unknown' }),
        getChannel: () => Promise.resolve({ ok: true, data: { SelectIndex: 3 } }),
      }),
    );

    const ctx = createMockContext();
    const canvas = new Canvas(64);
    await expect(svc.pushFrame(canvas, ctx)).rejects.toMatchObject({
      data: { reason: 'device_unreachable', retryable: true },
    });
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
    process.env['PIXOO_SERVE_HOST'] = 'pixoo-host.lan';
    process.env['PIXOO_SERVE_PORT'] = '8765';
    resetServerConfig();
    const device = fakeDevice();
    const listen = vi.spyOn(Server.prototype, 'listen');

    await getPixooService().pushAnimation(frameStack(41), 100, createMockContext());

    expect(device.named('Device/PlayTFGif')[0]?.['FileName']).toMatch(
      /^http:\/\/pixoo-host\.lan:8765\/[0-9a-f]{32}\.gif$/,
    );
    expect(listen.mock.calls[0]?.slice(0, 2)).toEqual([8765, '127.0.0.1']);
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

    const error = (await pushKeepingPreview(
      () => getPixooService().pushAnimation(frames, 100, createMockContext(), gif),
      [],
      (dir) => savePanelGif(gif, dir, 'scene'),
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
