/**
 * @fileoverview Tests for the pixoo_design_brief tool handler.
 * @module tests/tools/pixoo-design-brief.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDesignBrief } from '@/mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

const fakeStatus = {
  reachable: true,
  channel: 'custom',
  brightness: 80,
  screenOn: true,
};

describe('pixooDesignBrief', () => {
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

  it('topic "text" — returns expected output shape', async () => {
    stubStatus();
    const ctx = createMockContext();
    const input = pixooDesignBrief.input.parse({ topic: 'text' });
    const result = await pixooDesignBrief.handler(input, ctx);

    expect(result.topic).toBe('text');
    expect(typeof result.craftGuidance).toBe('string');
    expect(result.craftGuidance.length).toBeGreaterThan(0);
    expect(result.deviceContext).toMatchObject({
      displaySize: 64,
      reachable: true,
    });
    expect(Array.isArray(result.nextToolSuggestions)).toBe(true);
    expect(result.nextToolSuggestions.length).toBeGreaterThan(0);
    expect(Array.isArray(result.availableThemes)).toBe(true);
    expect(typeof result.iconCategories).toBe('object');
  });

  it('each topic returns non-empty craftGuidance and at least one next-tool suggestion', async () => {
    stubStatus();
    for (const topic of [
      'text',
      'scene',
      'dashboard',
      'animation',
      'pixel-art',
      'troubleshooting',
    ] as const) {
      const ctx = createMockContext();
      const input = pixooDesignBrief.input.parse({ topic });
      const result = await pixooDesignBrief.handler(input, ctx);
      expect(result.craftGuidance.length, `craftGuidance for ${topic}`).toBeGreaterThan(0);
      expect(result.nextToolSuggestions.length, `suggestions for ${topic}`).toBeGreaterThan(0);
    }
  });

  it('device unreachable → deviceContext.reachable is false, still returns guidance', async () => {
    vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue({ reachable: false });
    const ctx = createMockContext();
    const input = pixooDesignBrief.input.parse({ topic: 'troubleshooting' });
    const result = await pixooDesignBrief.handler(input, ctx);

    expect(result.deviceContext.reachable).toBe(false);
    expect(result.craftGuidance.length).toBeGreaterThan(0);
  });

  it('format() returns text containing Design Brief heading and device context', () => {
    const output = {
      topic: 'text',
      craftGuidance: '## Text Display Guidance\nSome guidance here.',
      deviceContext: {
        displaySize: 64,
        reachable: true,
        channel: 'custom',
        brightness: 80,
        screenOn: true,
      },
      nextToolSuggestions: [{ tool: 'pixoo_display_text', rationale: 'Primary tool.' }],
      availableThemes: ['midnight', 'ember'],
      iconCategories: { weather: ['sun', 'cloud'] },
    };
    const blocks = pixooDesignBrief.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Design Brief');
    expect(text).toContain('text');
    expect(text).toContain('64');
  });
});
