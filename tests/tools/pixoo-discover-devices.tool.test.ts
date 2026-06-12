/**
 * @fileoverview Tests for the pixoo_discover_devices tool handler.
 * @module tests/tools/pixoo-discover-devices.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDiscoverDevices } from '@/mcp-server/tools/definitions/pixoo-discover-devices.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeDevices = [
  { name: 'Pixoo64', id: 1001, ip: '192.168.1.42' },
  { name: 'Pixoo16', id: 1002, ip: '192.168.1.43' },
];

describe('pixooDiscoverDevices', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  function stubDiscovery(devices = fakeDevices) {
    vi.spyOn(getPixooService(), 'discoverDevices').mockResolvedValue(devices);
  }

  it('happy path — returns discovered devices array', async () => {
    stubDiscovery();
    const ctx = createMockContext();
    const input = pixooDiscoverDevices.input.parse({ timeoutMs: 1000 });
    const result = await pixooDiscoverDevices.handler(input, ctx);

    expect(Array.isArray(result.devices)).toBe(true);
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0]).toMatchObject({ name: 'Pixoo64', ip: '192.168.1.42' });
    expect(result.configuredIp).toBeUndefined();
  });

  it('configuredIp present and configuredIpFound:true when PIXOO_IP matches', async () => {
    process.env['PIXOO_IP'] = '192.168.1.42';
    resetServerConfig();
    initPixooService(fakeConfig, fakeStorage);
    stubDiscovery();

    const ctx = createMockContext();
    const input = pixooDiscoverDevices.input.parse({ timeoutMs: 1000 });
    const result = await pixooDiscoverDevices.handler(input, ctx);

    expect(result.configuredIp).toBe('192.168.1.42');
    expect(result.configuredIpFound).toBe(true);
  });

  it('configuredIpFound:false when PIXOO_IP does not match any device', async () => {
    process.env['PIXOO_IP'] = '10.0.0.99';
    resetServerConfig();
    initPixooService(fakeConfig, fakeStorage);
    stubDiscovery();

    const ctx = createMockContext();
    const input = pixooDiscoverDevices.input.parse({ timeoutMs: 1000 });
    const result = await pixooDiscoverDevices.handler(input, ctx);

    expect(result.configuredIpFound).toBe(false);
  });

  it('discovery_failed error when discoverDevices throws', async () => {
    vi.spyOn(getPixooService(), 'discoverDevices').mockRejectedValue(
      Object.assign(new Error('discovery_failed'), { data: { reason: 'discovery_failed' } }),
    );

    const ctx = createMockContext({ errors: pixooDiscoverDevices.errors });
    const input = pixooDiscoverDevices.input.parse({ timeoutMs: 1000 });
    await expect(pixooDiscoverDevices.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'discovery_failed' },
    });
  });

  it('format() lists device names and IPs', () => {
    const output = {
      devices: [{ name: 'Pixoo64', id: 1001, ip: '192.168.1.42' }],
      configuredIp: undefined,
      configuredIpFound: undefined,
    };
    const blocks = pixooDiscoverDevices.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pixoo64');
    expect(text).toContain('192.168.1.42');
  });
});
