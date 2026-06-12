/**
 * @fileoverview Tests for the pixoo_compose_scene tool handler.
 * @module tests/tools/pixoo-compose-scene.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeDeviceState = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

describe('pixooComposeScene', () => {
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

  async function stubPush() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushFrame').mockResolvedValue(fakeDeviceState);
  }

  async function stubPushAnimation() {
    const { getPixooService } = await import('@/services/pixoo/pixoo-service.js');
    vi.spyOn(getPixooService(), 'pushAnimation').mockResolvedValue(fakeDeviceState);
  }

  it('static scene with push:true calls pushFrame and returns deviceState', async () => {
    await stubPush();
    const ctx = createMockContext();
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      frames: 1,
      push: true,
    });
    const result = await pixooComposeScene.handler(input, ctx);
    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('static scene with push:false — returns layout[] and frames:1', async () => {
    const ctx = createMockContext();
    const input = pixooComposeScene.input.parse({
      background: '#001020',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      frames: 1,
      push: false,
    });
    const result = await pixooComposeScene.handler(input, ctx);

    expect(result.pushed).toBe(false);
    expect(result.frames).toBe(1);
    expect(Array.isArray(result.layout)).toBe(true);
    expect(result.layout.length).toBeGreaterThan(0);
    expect(result.deviceState).toBeUndefined();
  });

  it('layout entry has required fields (element, type, box, fits, action)', async () => {
    const ctx = createMockContext();
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 5, color: '#ff0000' }],
      frames: 1,
      push: false,
    });
    const result = await pixooComposeScene.handler(input, ctx);
    const entry = result.layout[0]!;

    expect(entry).toHaveProperty('element');
    expect(entry).toHaveProperty('type');
    expect(entry).toHaveProperty('box');
    expect(entry.box).toMatchObject({ x: expect.any(Number), y: expect.any(Number), w: 10, h: 5 });
    expect(entry).toHaveProperty('fits');
    expect(entry).toHaveProperty('action');
  });

  it('animation path (frames > 1) — returns frames count and image content block', async () => {
    await stubPushAnimation();
    const ctx = createMockContext();
    const input = pixooComposeScene.input.parse({
      background: { theme: 'midnight' },
      elements: [
        {
          type: 'text',
          text: 'LOOP',
          x: 0,
          y: 0,
          effect: { name: 'float', amplitude: 2 },
        },
      ],
      frames: 4,
      speed: 150,
      push: true,
    });
    const result = await pixooComposeScene.handler(input, ctx);

    expect(result.frames).toBe(4);
    expect(result.pushed).toBe(true);
    expect(result.deviceState).toEqual(fakeDeviceState);
  });

  it('no_device_configured error when push:true and no PIXOO_IP', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'HI', x: 0, y: 0 }],
      push: true,
    });
    await expect(pixooComposeScene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('gradient background resolves without throw', async () => {
    const ctx = createMockContext();
    const input = pixooComposeScene.input.parse({
      background: { gradient: { type: 'v', from: '#001020', to: '#000000' } },
      elements: [],
      push: false,
    });
    await expect(pixooComposeScene.handler(input, ctx)).resolves.toMatchObject({ frames: 1 });
  });

  it('format() returns text block containing Pushed and Layout', () => {
    const output = {
      pushed: false,
      frames: 1,
      layout: [
        {
          element: 0 as const,
          type: 'rect',
          box: { x: 0, y: 0, w: 10, h: 5 },
          fits: true,
          action: 'none' as const,
        },
      ],
    };
    const blocks = pixooComposeScene.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Pushed');
    expect(text).toContain('Frames');
    expect(text).toContain('Layout');
  });

  it('invalid_color: data.reason === "invalid_color" and message names a color', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'text', text: 'Hi', color: 'notacolor' }],
      frames: 1,
      push: false,
    });
    const err = await pixooComposeScene.handler(input, ctx).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.data?.reason).toBe('invalid_color');
    expect(err.message).toMatch(/white|black|red|green|blue/);
  });

  it('unknown_icon: data.reason === "unknown_icon"', async () => {
    const ctx = createMockContext({ errors: pixooComposeScene.errors });
    const input = pixooComposeScene.input.parse({
      background: '#000000',
      elements: [{ type: 'icon', name: 'nonexistent_icon_xyz' }],
      frames: 1,
      push: false,
    });
    const err = await pixooComposeScene.handler(input, ctx).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.data?.reason).toBe('unknown_icon');
  });
});
