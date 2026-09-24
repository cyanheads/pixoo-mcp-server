/**
 * @fileoverview Tests for the pixoo_design_brief tool handler.
 * @module tests/tools/pixoo-design-brief.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDesignBrief } from '@/mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';
import { resultText } from '../helpers/device-failure.js';

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

  it('topic "text" names only parameters pixoo_display_text accepts', async () => {
    stubStatus();
    const result = await pixooDesignBrief.handler(
      pixooDesignBrief.input.parse({ topic: 'text' }),
      createMockContext(),
    );
    const accepted = Object.keys(pixooDisplayText.input.shape);
    // Inline `name: value` references in the guidance — top-level or style-block keys.
    const named = [...result.craftGuidance.matchAll(/`(\w+): /g)].map(([, name]) => name);
    expect(named).not.toContain('overflow');
    for (const name of named) {
      expect([...accepted, 'palette', 'shadow', 'outline', 'scale']).toContain(name);
    }
    expect(result.craftGuidance).toContain('`effect: "auto"`');
  });

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

  describe('nextToolSuggestions entries are { toolName, reason, args }', () => {
    const TOPICS = [
      'text',
      'scene',
      'dashboard',
      'animation',
      'pixel-art',
      'troubleshooting',
    ] as const;
    // Every device state a branch reads: reachable, unreachable, screen off, dim.
    const STATES = {
      reachable: fakeStatus,
      unreachable: { reachable: false },
      'screen off': { ...fakeStatus, screenOn: false },
      dim: { ...fakeStatus, brightness: 5 },
    };

    it.each(
      TOPICS.flatMap((topic) =>
        Object.entries(STATES).map(([state, status]) => [topic, state, status] as const),
      ),
    )('%s (%s): every entry carries exactly toolName, reason, args', async (topic, _s, status) => {
      stubStatus(status as typeof fakeStatus);
      const result = await runToolContract(pixooDesignBrief, { topic });
      expect(result.isError).toBeFalsy();
      const { nextToolSuggestions } = result.structuredContent as {
        nextToolSuggestions: Array<Record<string, unknown>>;
      };
      expect(nextToolSuggestions.length).toBeGreaterThan(0);
      for (const entry of nextToolSuggestions) {
        expect(Object.keys(entry).sort()).toEqual(['args', 'reason', 'toolName']);
        expect(entry['toolName']).toMatch(/^pixoo_/);
        expect(typeof entry['reason']).toBe('string');
        expect(entry['args']).toBeTypeOf('object');
        // The markdown surface names every suggested tool with its reason.
        expect(resultText(result)).toContain(`**${entry['toolName']}**: ${entry['reason']}`);
      }
    });

    it.each([
      ['text', { reachable: false }, 'pixoo_discover_devices'],
      ['troubleshooting', { reachable: false }, 'pixoo_discover_devices'],
      ['troubleshooting', fakeStatus, 'pixoo_control_device'],
    ] as const)('%s → %o: the arg-less %s entry has args: {}', async (topic, status, toolName) => {
      stubStatus(status as typeof fakeStatus);
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic }),
        createMockContext(),
      );
      expect(result.nextToolSuggestions).toContainEqual(
        expect.objectContaining({ toolName, args: {} }),
      );
    });

    it.each([
      [10, true],
      [11, false],
    ])(
      'troubleshooting at brightness %i: suggests raising it = %s (same ≤ 10 floor as the post-push notice)',
      async (brightness, suggested) => {
        stubStatus({ ...fakeStatus, brightness });
        const result = await pixooDesignBrief.handler(
          pixooDesignBrief.input.parse({ topic: 'troubleshooting' }),
          createMockContext(),
        );
        const raise = expect.objectContaining({ args: { brightness: 80 } });
        if (suggested) expect(result.nextToolSuggestions).toContainEqual(raise);
        else expect(result.nextToolSuggestions).not.toContainEqual(raise);
      },
    );

    it('pre-filled args survive the rename', async () => {
      stubStatus({ ...fakeStatus, screenOn: false });
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'troubleshooting' }),
        createMockContext(),
      );
      expect(result.nextToolSuggestions).toEqual([
        {
          toolName: 'pixoo_control_device',
          reason: 'Screen appears to be off.',
          args: { screen: 'on' },
        },
      ]);
    });
  });

  it('device unreachable → deviceContext.reachable is false, still returns guidance', async () => {
    vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue({ reachable: false });
    const ctx = createMockContext();
    const input = pixooDesignBrief.input.parse({ topic: 'troubleshooting' });
    const result = await pixooDesignBrief.handler(input, ctx);

    expect(result.deviceContext.reachable).toBe(false);
    expect(result.craftGuidance.length).toBeGreaterThan(0);
  });

  it('format() renders each suggestion as a name line, plus a JSON block only when it has args', () => {
    const output = {
      topic: 'troubleshooting',
      craftGuidance: 'Guidance.',
      deviceContext: { displaySize: 64, reachable: true },
      nextToolSuggestions: [
        { toolName: 'pixoo_control_device', reason: 'Read full device state.', args: {} },
        {
          toolName: 'pixoo_control_device',
          reason: 'Screen appears to be off.',
          args: { screen: 'on' },
        },
      ],
      availableThemes: ['midnight'],
      iconCategories: {},
    };
    const text = (pixooDesignBrief.format!(output)[0] as { text: string }).text;
    const nextSteps = text.slice(
      text.indexOf('## Next Steps'),
      text.indexOf('## Available Themes'),
    );
    expect(nextSteps).toBe(
      [
        '## Next Steps',
        '**pixoo_control_device**: Read full device state.',
        '**pixoo_control_device**: Screen appears to be off.',
        '```json',
        '{\n  "screen": "on"\n}',
        '```',
        '',
        '',
      ].join('\n'),
    );
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
      nextToolSuggestions: [{ toolName: 'pixoo_display_text', reason: 'Primary tool.', args: {} }],
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
