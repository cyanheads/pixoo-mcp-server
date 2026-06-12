/**
 * @fileoverview Tests for the pixoo_control_device tool handler.
 * @module tests/tools/pixoo-control-device.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooControlDevice } from '@/mcp-server/tools/definitions/pixoo-control-device.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeStatus = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

describe('pixooControlDevice', () => {
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
    resetServerConfig();
    vi.restoreAllMocks();
  });

  function stubStatus(status = fakeStatus) {
    vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue(status);
  }

  function stubSetters() {
    const svc = getPixooService();
    vi.spyOn(svc, 'setBrightness').mockResolvedValue({ ok: true } as never);
    vi.spyOn(svc, 'setScreen').mockResolvedValue({ ok: true } as never);
    vi.spyOn(svc, 'setChannel').mockResolvedValue({ ok: true } as never);
    vi.spyOn(svc, 'setClock').mockResolvedValue({ ok: true } as never);
  }

  it('read-only call (no params) — returns reachable:true and applied:[]', async () => {
    stubStatus();
    const ctx = createMockContext();
    const input = pixooControlDevice.input.parse({});
    const result = await pixooControlDevice.handler(input, ctx);

    expect(result.reachable).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.channel).toBe('custom');
    expect(result.brightness).toBe(80);
  });

  it('brightness setter — applied[] contains "brightness:75"', async () => {
    stubStatus();
    stubSetters();
    const ctx = createMockContext();
    const input = pixooControlDevice.input.parse({ brightness: 75 });
    const result = await pixooControlDevice.handler(input, ctx);

    expect(result.applied).toContain('brightness:75');
  });

  it('screen setter — applied[] contains "screen:on"', async () => {
    stubStatus();
    stubSetters();
    const ctx = createMockContext();
    const input = pixooControlDevice.input.parse({ screen: 'on' });
    const result = await pixooControlDevice.handler(input, ctx);

    expect(result.applied).toContain('screen:on');
  });

  it('no_device_configured error when PIXOO_IP absent', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext({ errors: pixooControlDevice.errors });
    const input = pixooControlDevice.input.parse({ brightness: 50 });
    await expect(pixooControlDevice.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('format() returns text block with Device Status heading', () => {
    const output = {
      reachable: true,
      channel: 'custom',
      brightness: 80,
      screenOn: true,
      applied: ['brightness:80'],
    };
    const blocks = pixooControlDevice.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Device Status');
    expect(text).toContain('brightness:80');
  });
});
