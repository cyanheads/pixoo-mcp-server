/**
 * @fileoverview Drives the real `PixooService` push path against a fake device client —
 * a failing push, or a successful push followed by a chosen device-state read-back — and
 * asserts the assembled tool result on both client surfaces.
 * @module tests/helpers/device-failure
 */

import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
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
