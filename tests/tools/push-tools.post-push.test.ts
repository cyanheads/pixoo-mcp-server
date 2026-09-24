/**
 * @fileoverview What the three push tools do after the push: the visibility notice on
 * a successful push, and the rendered preview kept on a failed one. Each case runs the
 * assembled tool result through the real `PixooService` against a fake device client.
 * @module tests/tools/push-tools.post-push.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Canvas, Channel, type PixooFailure, savePng } from '@cyanheads/pixoo-toolkit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { pixooPushImage } from '@/mcp-server/tools/definitions/pixoo-push-image.tool.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import {
  errorOutputFiles,
  expectDeviceFailure,
  type FakeDeviceState,
  failDevicePush,
  imageKind,
  isolateTmpdir,
  listFiles,
  resultText,
  stubDeviceState,
} from '../helpers/device-failure.js';

type Extra = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
type Success = {
  pushed: boolean;
  notice?: string;
  deviceState?: { reachable: boolean };
};

let fixtureDir: string;
let fixturePath: string;

/** One push tool, a representative input for it, and the extra that makes it animate. */
interface PushTool {
  animated?: Extra;
  errors: ReadonlyArray<{ code: number; reason: string; recovery: string }> | undefined;
  name: string;
  run: (extra?: Extra) => Promise<ToolResult>;
}

const TOOLS: PushTool[] = [
  {
    name: 'pixoo_display_text',
    errors: pixooDisplayText.errors,
    animated: { effect: 'float' },
    run: (extra = {}) =>
      runToolContract(pixooDisplayText, { text: 'hi', ...extra } as z.input<
        typeof pixooDisplayText.input
      >),
  },
  {
    name: 'pixoo_compose_scene',
    errors: pixooComposeScene.errors,
    animated: { frames: 3, elements: [{ type: 'text', text: 'HI', effect: { name: 'float' } }] },
    run: (extra = {}) =>
      runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [{ type: 'text', text: 'HI' }],
        ...extra,
      } as z.input<typeof pixooComposeScene.input>),
  },
  {
    name: 'pixoo_push_image',
    errors: pixooPushImage.errors,
    run: (extra = {}) =>
      runToolContract(pixooPushImage, { source: fixturePath, ...extra } as z.input<
        typeof pixooPushImage.input
      >),
  },
];

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-post-push-fixture-'));
  fixturePath = path.join(fixtureDir, 'fixture.png');
  await savePng(new Canvas(64).clear([0, 128, 255]), fixturePath);
});

afterAll(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetServerConfig();
  process.env['PIXOO_SIZE'] = '64';
  process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
  process.env['PIXOO_IP'] = '10.0.0.1';
  initPixooService(fakeConfig, fakeStorage);
});

afterEach(() => {
  delete process.env['PIXOO_IP'];
  delete process.env['PIXOO_SIZE'];
  delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
  delete process.env['PIXOO_OUTPUT_DIR'];
  resetServerConfig();
});

describe.each(TOOLS)('$name — visibility notice after a push', (tool) => {
  async function pushTo(state: FakeDeviceState, extra: Extra = {}) {
    stubDeviceState(state);
    const result = await tool.run({ push: true, ...extra });
    expect(result.isError).toBeFalsy();
    return { result, sc: result.structuredContent as Success };
  }

  it.each<[string, FakeDeviceState, RegExp]>([
    ['the screen is off', { screenOn: false }, /screen is off.*screen: "on"/],
    ['brightness is at the floor of 10', { brightness: 10 }, /brightness is 10.*brightness: /],
    [
      'the device stayed on another channel',
      { channel: Channel.Faces },
      /faces channel.*channel: "custom"/,
    ],
  ])('names the problem and its fix when %s', async (_label, state, pattern) => {
    const { result, sc } = await pushTo(state);
    expect(sc.pushed).toBe(true);
    expect(sc.notice).toMatch(pattern);
    expect(sc.notice).toContain('pixoo_control_device');
    // The same notice reaches the content[] surface in the enrichment trailer.
    expect(resultText(result)).toContain(sc.notice);
  });

  it('folds several problems into one notice', async () => {
    const { sc } = await pushTo({ screenOn: false, brightness: 3, channel: Channel.Cloud });
    expect(sc.notice).toMatch(/screen is off/);
    expect(sc.notice).toMatch(/brightness is 3/);
    expect(sc.notice).toMatch(/cloud channel/);
  });

  it.each<[string, FakeDeviceState]>([
    ['a visible device', {}],
    ['brightness just above the floor', { brightness: 11 }],
  ])('adds no notice for %s', async (_label, state) => {
    const { sc } = await pushTo(state);
    expect(sc).not.toHaveProperty('notice');
  });

  it('adds no notice when the read-back could not reach the device', async () => {
    const { sc } = await pushTo({ unreachable: true, screenOn: false });
    expect(sc.deviceState).toEqual({ reachable: false });
    expect(sc).not.toHaveProperty('notice');
  });

  it('adds no notice and touches no device when push is false', async () => {
    const client = stubDeviceState({ screenOn: false });
    const result = await tool.run({ push: false });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(client.push).not.toHaveBeenCalled();
    expect(client.getChannel).not.toHaveBeenCalled();
  });

  if (tool.animated) {
    it('checks visibility after an animation push too', async () => {
      const { sc } = await pushTo({ screenOn: false }, tool.animated);
      expect(sc.notice).toMatch(/screen is off/);
    });
  }
});

describe.each(TOOLS)('$name — preview kept on a failed push', (tool) => {
  let tmp: Awaited<ReturnType<typeof isolateTmpdir>>;

  beforeEach(async () => {
    tmp = await isolateTmpdir();
  });

  afterEach(async () => {
    tmp.restore();
    await fs.rm(tmp.dir, { recursive: true, force: true });
    await fs.rm(`${tmp.dir}-out`, { recursive: true, force: true });
  });

  it.each<[string, PixooFailure, string, boolean | undefined]>([
    [
      'unreachable',
      { ok: false, kind: 'network', message: 'EHOSTUNREACH' },
      'device_unreachable',
      true,
    ],
    [
      'HTTP 503',
      { ok: false, kind: 'http', status: 503, message: 'HTTP 503' },
      'device_http_error',
      true,
    ],
    [
      'HTTP 404',
      { ok: false, kind: 'http', status: 404, message: 'HTTP 404' },
      'device_http_error',
      false,
    ],
    [
      'rejected',
      { ok: false, kind: 'device', deviceCode: 1, message: 'error_code 1' },
      'device_rejected',
      undefined,
    ],
  ])(
    '%s: the typed error is unchanged and outputFiles names a temp PNG',
    async (_label, failure, reason, retryable) => {
      failDevicePush(failure);
      const result = await tool.run({ push: true });

      expectDeviceFailure(result, tool.errors, reason, retryable);
      const recovery = tool.errors?.find((entry) => entry.reason === reason)?.recovery;
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: recovery } } },
      });

      const files = errorOutputFiles(result) as string[];
      expect(files).toHaveLength(1);
      expect(files[0]!.startsWith(tmp.dir)).toBe(true);
      expect(await imageKind(files[0]!)).toBe('png');
      expect(await listFiles(tmp.dir)).toEqual(files);
      // content[]-only clients learn where the render went from the message.
      expect(resultText(result)).toContain(files[0]);
    },
  );

  it.each([
    ['ends mid-sentence', 'EHOSTUNREACH', 'Device unreachable: EHOSTUNREACH. Rendered'],
    ['ends with a period', 'Host down.', 'Device unreachable: Host down. Rendered'],
    [
      'ends with a question mark',
      'Unable to connect. Is the computer able to access the url?',
      'access the url? Rendered',
    ],
  ])(
    'the preview path follows a message that %s as its own sentence',
    async (_label, message, expected) => {
      failDevicePush({ ok: false, kind: 'network', message });
      const failed = await tool.run({ push: true });
      const sent = (failed.structuredContent as { error: { message: string } }).error.message;
      expect(sent).toContain(expected);
      expect(sent).toMatch(/Rendered preview saved to \S+\.png\.$/);
    },
  );

  if (tool.animated) {
    it('a failed animation push keeps the GIF', async () => {
      failDevicePush({ ok: false, kind: 'network', message: 'EHOSTUNREACH' });
      const result = await tool.run({ push: true, ...tool.animated });
      expectDeviceFailure(result, tool.errors, 'device_unreachable', true);
      const files = errorOutputFiles(result) as string[];
      expect(files).toHaveLength(1);
      expect(await imageKind(files[0]!)).toBe('gif');
    });
  }

  it('with PIXOO_OUTPUT_DIR, names the auto-save and writes no temp copy', async () => {
    const outDir = `${tmp.dir}-out`;
    process.env['PIXOO_OUTPUT_DIR'] = outDir;
    resetServerConfig();
    failDevicePush({ ok: false, kind: 'network', message: 'EHOSTUNREACH' });

    const result = await tool.run({ push: true });

    expectDeviceFailure(result, tool.errors, 'device_unreachable', true);
    const files = errorOutputFiles(result) as string[];
    expect(files).toHaveLength(1);
    expect(await listFiles(outDir)).toEqual(files);
    expect(await listFiles(tmp.dir)).toEqual([]);
  });

  it('a push with no device configured keeps the preview too', async () => {
    delete process.env['PIXOO_IP'];
    resetServerConfig();
    initPixooService(fakeConfig, fakeStorage);

    const result = await tool.run({ push: true });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_device_configured' } },
    });
    const files = errorOutputFiles(result) as string[];
    expect(files).toHaveLength(1);
    expect(await imageKind(files[0]!)).toBe('png');
  });

  it.each([
    ['a successful push', true],
    ['push: false', false],
  ])('%s writes no temp file and attaches nothing', async (_label, push) => {
    stubDeviceState();
    const result = await tool.run({ push });
    expect(result.isError).toBeFalsy();
    expect(await listFiles(tmp.dir)).toEqual([]);
  });
});
