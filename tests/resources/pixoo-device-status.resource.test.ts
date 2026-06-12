/**
 * @fileoverview Tests for the pixoo://device/status resource.
 * @module tests/resources/pixoo-device-status.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDeviceStatusResource } from '@/mcp-server/resources/definitions/pixoo-device-status.resource.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

describe('pixooDeviceStatusResource', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  it('returns reachable:false (not an error) when no device IP is configured', async () => {
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext();
    const params = pixooDeviceStatusResource.params.parse({});
    const result = await pixooDeviceStatusResource.handler(params, ctx);

    expect(result.reachable).toBe(false);
    // displaySize and configuredIp should still be present
    expect(result.displaySize).toBe(64);
    expect(result.configuredIp).toBeNull();
  });

  it('returns configuredIp when PIXOO_IP is set (even if device unreachable)', async () => {
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);

    const svc = (await import('@/services/pixoo/pixoo-service.js')).getPixooService();
    vi.spyOn(svc, 'getStatus').mockResolvedValue({ reachable: false });

    const ctx = createMockContext();
    const params = pixooDeviceStatusResource.params.parse({});
    const result = await pixooDeviceStatusResource.handler(params, ctx);

    expect(result.configuredIp).toBe('10.0.0.1');
    expect(result.reachable).toBe(false);
  });

  it('returns full device snapshot when device is reachable', async () => {
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);

    const svc = (await import('@/services/pixoo/pixoo-service.js')).getPixooService();
    vi.spyOn(svc, 'getStatus').mockResolvedValue({
      reachable: true,
      channel: 'custom',
      brightness: 75,
      screenOn: true,
      clockId: undefined,
    });

    const ctx = createMockContext();
    const params = pixooDeviceStatusResource.params.parse({});
    const result = await pixooDeviceStatusResource.handler(params, ctx);

    expect(result.reachable).toBe(true);
    expect(result.channel).toBe('custom');
    expect(result.brightness).toBe(75);
    expect(result.screenOn).toBe(true);
    expect(result.displaySize).toBe(64);
  });

  it('list() returns the expected URI and metadata', async () => {
    const listing = await pixooDeviceStatusResource.list!();
    expect(listing.resources.length).toBe(1);
    const r = listing.resources[0]!;
    expect(r.uri).toBe('pixoo://device/status');
    expect(r.name).toBe('device-status');
    expect(r.mimeType).toBe('application/json');
  });
});
