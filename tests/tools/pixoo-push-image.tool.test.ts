/**
 * @fileoverview Tests for the pixoo_push_image tool handler.
 * @module tests/tools/pixoo-push-image.tool.test
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Canvas, savePng } from '@cyanheads/pixoo-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooPushImage } from '@/mcp-server/tools/definitions/pixoo-push-image.tool.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';
import { expectDeviceFailure, failDevicePush } from '../helpers/device-failure.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeDeviceState = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

/** Absolute path to a real 64×64 PNG fixture written once before the suite. */
let fixturePath: string;

describe('pixooPushImage', () => {
  beforeEach(async () => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);

    // Build a tiny 64×64 fixture PNG so the handler can loadImage without a real file.
    if (!fixturePath) {
      const canvas = new Canvas(64);
      canvas.clear([0, 128, 255]);
      fixturePath = path.join(os.tmpdir(), `pixoo-test-fixture-${Date.now()}.png`);
      await savePng(canvas, fixturePath);
    }
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  async function stubPush() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushFrame').mockResolvedValue(fakeDeviceState);
  }

  it('happy path with local fixture — push:false returns pushed:false', async () => {
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: fixturePath,
      push: false,
    });
    const result = await pixooPushImage.handler(input, ctx);

    expect(result.pushed).toBe(false);
    expect(result.deviceState).toBeUndefined();
    // The downsampled result rides content[], never structuredContent.
    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: expect.any(String), mimeType: 'image/png' },
    ]);
    expect(result).not.toHaveProperty('previewData');
  });

  it('push:true calls pushFrame and returns deviceState', async () => {
    await stubPush();
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: fixturePath,
      push: true,
    });
    const result = await pixooPushImage.handler(input, ctx);

    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('asset_not_found error when file does not exist', async () => {
    const ctx = createMockContext({ errors: pixooPushImage.errors });
    const input = pixooPushImage.input.parse({
      source: '/tmp/pixoo-nonexistent-file-xyz-12345.png',
      push: false,
    });
    await expect(pixooPushImage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'asset_not_found' },
    });
  });

  it('asset_not_found forwards the declared recovery on both surfaces', async () => {
    const result = await runToolContract(pixooPushImage, {
      source: '/tmp/pixoo-nonexistent-file-xyz-12345.png',
      push: false,
    });
    expectForwardedRecovery(result, pixooPushImage.errors, 'asset_not_found');
    expect(result.structuredContent).toMatchObject({
      error: { data: { path: '/tmp/pixoo-nonexistent-file-xyz-12345.png' } },
    });
  });

  describe('device failures on push reach both surfaces through the contract', () => {
    it('device_unreachable carries retryable: true', async () => {
      failDevicePush({ ok: false, kind: 'network', message: 'connect EHOSTUNREACH' });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_unreachable', true);
    });

    it.each([
      [503, true],
      [404, false],
    ])('device_http_error (HTTP %i) is declared, retryable: %s', async (status, retryable) => {
      failDevicePush({ ok: false, kind: 'http', status, message: `HTTP ${status}` });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_http_error', retryable);
    });

    it('device_rejected carries no retryable key', async () => {
      failDevicePush({ ok: false, kind: 'device', deviceCode: 1, message: 'error_code 1' });
      const result = await runToolContract(pixooPushImage, { source: fixturePath, push: true });
      expectDeviceFailure(result, pixooPushImage.errors, 'device_rejected', undefined);
    });
  });

  it('format() returns text block containing Pushed status', () => {
    const output = { pushed: false };
    const blocks = pixooPushImage.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pushed');
  });

  it('format() mentions Saved when outputFiles present', () => {
    const output = { pushed: false, outputFiles: ['/tmp/out.png'] };
    const blocks = pixooPushImage.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Saved');
    expect(text).toContain('/tmp/out.png');
  });
});
