/**
 * @fileoverview Drives the real `PixooService` push path against a fake device — a fake
 * client in place of the toolkit's (a failing push, or a successful push followed by a
 * chosen device-state read-back), or a stand-in Pixoo on loopback behind the real
 * client — and asserts the assembled tool result on both client surfaces.
 * @module tests/helpers/device-failure
 */

import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Channel, type PixooFailure } from '@cyanheads/pixoo-toolkit';
import { expect, type Mock, vi } from 'vitest';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const ok = (data: object = {}) => ({ ok: true, data: { error_code: 0, ...data } });

/**
 * Address every fake device answers at. The GIF listener for a push of more than 40
 * frames binds the local address routed to it, so the listener stays on loopback.
 */
const FAKE_DEVICE_IP = '127.0.0.1';

/** The URL a `PixooClient` for {@link FAKE_DEVICE_IP} posts every command to. */
const FAKE_DEVICE_URL = `http://${FAKE_DEVICE_IP}/post`;

/** A reply {@link startFakePixoo} sends. Status defaults to 200, type to JSON. */
export interface FakeReply {
  body: string;
  status?: number;
  type?: string;
}

/** A stand-in Pixoo started by {@link startFakePixoo}. */
export interface FakePixoo {
  /** Stop the server and drop any open connection; the real `fetch` is back afterwards. */
  close(): Promise<void>;
  /** The `Command` of every request received, in arrival order. */
  commands: string[];
  /**
   * The `Command` of every request the client has started, in call order — recorded
   * when `fetch` is called, before the request can reach the server.
   */
  requested: string[];
}

/**
 * Status-200 replies that are not a Pixoo's JSON envelope with a numeric `error_code` —
 * what a router page or another HTTP service at `PIXOO_IP` sends.
 */
export const NON_PIXOO_REPLIES: ReadonlyArray<[label: string, reply: FakeReply]> = [
  [
    'an HTML page',
    { type: 'text/html', body: '<!doctype html><title>Router</title><p>Sign in</p>' },
  ],
  ['an empty body', { type: 'text/plain', body: '' }],
  ['JSON without an error_code', { body: '{"status":"ok"}' }],
  ['JSON with a string error_code', { body: '{"error_code":"0"}' }],
];

/** What a Pixoo-64 on `channel`, the Custom channel unless given, answers each command with. */
export function pixooReply(command: string, channel: Channel = Channel.Custom): FakeReply {
  switch (command) {
    case 'Channel/GetIndex':
      return { body: JSON.stringify({ error_code: 0, SelectIndex: channel }) };
    case 'Channel/GetAllConf':
      return {
        body: JSON.stringify({ error_code: 0, Brightness: 80, LightSwitch: 1, CurClockId: 0 }),
      };
    default:
      return { body: JSON.stringify({ error_code: 0 }) };
  }
}

/**
 * Stand in for a Pixoo at `PIXOO_IP=127.0.0.1` with a real HTTP server on a free
 * loopback port. `fetch` is wrapped to send the device URL there, and only that URL:
 * each command still travels through the real `fetch` and socket with the caller's
 * signal, so an abort tears the request down as it would against the device. A
 * request's `Command` is recorded once its body has arrived; `answer` then picks the
 * reply, a Pixoo's by default. `answer` runs while the caller awaits that reply, so a
 * test can abort the call from there with the request in flight, and `undefined`
 * leaves the request unanswered.
 */
export async function startFakePixoo(
  answer: (command: string) => FakeReply | undefined = pixooReply,
): Promise<FakePixoo> {
  const commands: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      const command = String((JSON.parse(raw) as { Command?: unknown }).Command);
      commands.push(command);
      const reply = answer(command);
      if (!reply) return;
      res
        .writeHead(reply.status ?? 200, { 'Content-Type': reply.type ?? 'application/json' })
        .end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/post`;

  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  const routed = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) !== FAKE_DEVICE_URL) return realFetch(input, init);
    requested.push(String((JSON.parse(String(init?.body)) as { Command?: unknown }).Command));
    return realFetch(target, init);
  });

  return {
    commands,
    requested,
    close: () => {
      routed.mockRestore();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Swap the service's device client for a fake whose frame pushes, animation pushes,
 * and GIF plays fail with `failure`. Everything above the client — pacing, channel
 * check, the GIF listener, failure mapping — runs for real.
 */
export function failDevicePush(failure: PixooFailure): void {
  const client = {
    ip: FAKE_DEVICE_IP,
    getChannel: vi.fn().mockResolvedValue({ ok: true, data: { SelectIndex: 3 } }),
    push: vi.fn().mockResolvedValue(failure),
    pushAnimation: vi.fn().mockResolvedValue(failure),
    playGifUrl: vi.fn().mockResolvedValue(failure),
  };
  (getPixooService() as unknown as { client: unknown }).client = client;
}

/** What the fake device reports when read back after a push. */
export interface FakeDeviceState {
  brightness?: number;
  /** Channel the device sits on; a switch to Custom fails, so it stays there. Default: custom. */
  channel?: Channel;
  screenOn?: boolean;
  /** Every channel read fails — the post-push snapshot degrades to `reachable: false`. */
  unreachable?: boolean;
}

/** The fake device client {@link stubDeviceState} installs — one Vitest mock per call. */
export interface FakeDeviceClient {
  /** Each GIF the fake downloaded from a `playGifUrl` URL, in play order. */
  downloads: Promise<Uint8Array>[];
  getChannel: Mock;
  getConfig: Mock;
  ip: string;
  playGifUrl: Mock;
  push: Mock;
  pushAnimation: Mock;
  setBrightness: Mock;
  setChannel: Mock;
}

/**
 * Swap the service's device client for a fake whose pushes succeed and whose
 * read-back reports `state`. A GIF play answers first, then downloads the URL the way
 * the firmware does. Returns the fake so a test can inspect its calls.
 */
export function stubDeviceState(state: FakeDeviceState = {}): FakeDeviceClient {
  const channel = state.channel ?? Channel.Custom;
  const downloads: Promise<Uint8Array>[] = [];
  const client: FakeDeviceClient = {
    ip: FAKE_DEVICE_IP,
    downloads,
    playGifUrl: vi.fn((url: string) => {
      downloads.push(fetch(url).then(async (res) => new Uint8Array(await res.arrayBuffer())));
      return Promise.resolve(ok());
    }),
    getChannel: vi
      .fn()
      .mockResolvedValue(
        state.unreachable
          ? { ok: false, kind: 'network', message: 'connect EHOSTUNREACH' }
          : ok({ SelectIndex: channel }),
      ),
    setChannel: vi.fn().mockResolvedValue({ ok: false, kind: 'device', message: 'refused' }),
    getConfig: vi.fn().mockResolvedValue(
      ok({
        Brightness: state.brightness ?? 80,
        LightSwitch: state.screenOn === false ? 0 : 1,
      }),
    ),
    setBrightness: vi.fn().mockResolvedValue(ok()),
    push: vi.fn().mockResolvedValue(ok()),
    pushAnimation: vi.fn().mockResolvedValue(ok()),
  };
  (getPixooService() as unknown as { client: unknown }).client = client;
  return client;
}

/**
 * Assert `result` failed with `reason`, that the reason is declared on the tool as
 * `ServiceUnavailable`, and that `retryable` reaches both surfaces as given —
 * `undefined` meaning the key is absent and the text tail carries no retryability term.
 */
export function expectDeviceFailure(
  result: ToolResult,
  errors: ReadonlyArray<{ reason: string; code: number }> | undefined,
  reason: string,
  retryable: boolean | undefined,
): void {
  expect(errors?.find((entry) => entry.reason === reason)?.code).toBe(
    JsonRpcErrorCode.ServiceUnavailable,
  );

  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: { code: number; data: object } }).error;
  expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(error.data).toMatchObject({ reason, recovery: { hint: expect.any(String) } });
  if (retryable === undefined) expect(error.data).not.toHaveProperty('retryable');
  else expect(error.data).toMatchObject({ retryable });

  const text = resultText(result);
  const tail =
    retryable === undefined
      ? `(reason ${reason})`
      : `(reason ${reason} · ${retryable ? 'retryable' : 'not retryable'})`;
  expect(text.trimEnd().slice(-tail.length)).toBe(tail);
  expect(text).toContain('Recovery: ');
}

/** Every text block of a tool result, joined — the `content[]` surface a client reads. */
export function resultText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/**
 * Point `os.tmpdir()` at a fresh, empty directory for one test, so the test sees
 * exactly which temp files the code under test wrote. Call `restore` in `afterEach`:
 * it puts `TMPDIR` back and deletes the directory with everything written to it.
 */
export async function isolateTmpdir(): Promise<{ dir: string; restore: () => void }> {
  const previous = process.env['TMPDIR'];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-test-tmp-'));
  process.env['TMPDIR'] = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every file under `dir`, recursively, as absolute paths; empty when `dir` is absent. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

/** The image format a file's magic bytes declare. */
export async function imageKind(file: string): Promise<'png' | 'gif' | 'other'> {
  const head = (await fs.readFile(file)).subarray(0, 6).toString('latin1');
  if (head.slice(1, 4) === 'PNG') return 'png';
  if (head.startsWith('GIF8')) return 'gif';
  return 'other';
}

/** The `error.data.outputFiles` a failed tool result carries. */
export function errorOutputFiles(result: ToolResult): unknown {
  return (result.structuredContent as { error: { data?: { outputFiles?: unknown } } }).error.data
    ?.outputFiles;
}
