/**
 * @fileoverview Tests for the pixoo_design_brief tool handler.
 * @module tests/tools/pixoo-design-brief.tool.test
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooDesignBrief } from '@/mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { pixooRenderHtml } from '@/mcp-server/tools/definitions/pixoo-render-html.tool.js';
import { BROWSER_UNAVAILABLE_RECOVERY } from '@/services/browser/browser-renderer.js';
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
    delete process.env['PIXOO_HTML_ENABLED'];
    delete process.env['PIXOO_BROWSER_PATH'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  function stubStatus(status = fakeStatus) {
    vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue(status);
  }

  /**
   * Point discovery at a browser path: an empty executable file for `available`, a path
   * that does not exist for `no_browser`. Discovery only stats it, so nothing launches.
   */
  async function setBrowserPath(state: 'available' | 'no_browser') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brief-browser-'));
    const file = path.join(dir, 'chrome-headless-shell');
    if (state === 'available') {
      await writeFile(file, '');
      await chmod(file, 0o755);
    }
    process.env['PIXOO_BROWSER_PATH'] = file;
    resetServerConfig();
  }

  describe('htmlRenderer', () => {
    it.each([
      ['available', 'available', ' — pixoo_render_html can render pages.'],
      ['no_browser', 'no_browser', ' — pixoo_render_html fails browser_unavailable'],
      ['disabled', 'available', ' — PIXOO_HTML_ENABLED=false, so pixoo_render_html is not listed.'],
    ] as const)(
      '%s: reported on structuredContent and format()',
      async (expected, browser, note) => {
        await setBrowserPath(browser);
        if (expected === 'disabled') {
          process.env['PIXOO_HTML_ENABLED'] = 'false';
          resetServerConfig();
        }
        stubStatus();
        const result = await runToolContract(pixooDesignBrief, { topic: 'text' });
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { htmlRenderer: string }).htmlRenderer).toBe(expected);
        expect(resultText(result)).toContain(`HTML renderer: **${expected}**${note}`);
      },
    );

    it('disabled wins over discovery: a missing browser still reads disabled', async () => {
      await setBrowserPath('no_browser');
      process.env['PIXOO_HTML_ENABLED'] = 'false';
      resetServerConfig();
      stubStatus();
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'html' }),
        createMockContext(),
      );
      expect(result.htmlRenderer).toBe('disabled');
    });

    it('no_browser: format() carries the install instructions', async () => {
      await setBrowserPath('no_browser');
      stubStatus();
      const result = await runToolContract(pixooDesignBrief, { topic: 'troubleshooting' });
      expect(resultText(result)).toContain(BROWSER_UNAVAILABLE_RECOVERY);
    });
  });

  describe('topic "html"', () => {
    it('covers loops, the page defaults, the clock, the network, strokes, and sampling', async () => {
      await setBrowserPath('available');
      stubStatus();
      const { craftGuidance } = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'html' }),
        createMockContext(),
      );
      for (const term of [
        // Seamless loops
        '`window.render(t, frame)`',
        '`t = frame / frames`',
        'closes the loop with no seam',
        '`page_error`',
        // Page defaults
        '`body` has no margin',
        'scrollbars are hidden',
        'renders on black, which the panel shows as unlit',
        "The page's own CSS overrides each",
        // Virtual clock
        '`requestAnimationFrame`',
        'a nested or repeating timer waiting at least 4 ms',
        '`performance.now()` reads 0 at load and `frame × speed` at each frame',
        '`Date` starts at the real time',
        '`requestIdleCallback` and iframes keep real time',
        'Workers are blocked',
        // No network
        'Nothing loads from a network URL',
        '`data:` or `blob:`',
        '`Blocked navigation: <url>`',
        'a popup is blocked',
        // Frames past 40
        '`frames` is 1–800',
        'Up to 40 push frame by frame',
        'PIXOO_SERVE_HOST',
        // Strokes and sampling
        '**Thin strokes vanish:**',
        'strokes of 2px or more',
        'renders at 8× and averages each 8×8 block',
        'smoothing transforms, text, SVG, and canvas',
        "Chromium snaps a plain box's edges to whole CSS pixels",
        '`left: 0.5px` still lands on one LED',
        'move it with `transform` for sub-pixel motion',
        // The pixoo runtime
        'for crisp pixel text use `pixoo.text`',
        '**Pixel text and icons:**',
        'Every page gets a `pixoo` global before its own scripts run, a `<head>` script included',
        '`pixoo.context()` returns the 2D context of one transparent panel-size canvas fixed over the page',
        '`pixoo.text(ctx, text, x, y, { font, color, palette, scale, shadow, outline })`',
        'returns the `{ x, y, w, h }` it drew',
        '`pixoo.icon(ctx, name, x, y, { w, h, color, palette })`',
        '12×12 by default',
        '`pixoo.palettes` holds the 7 palettes as `{ from, to }` stops',
        '`pixoo.size` is the panel size',
        'one unit stays one panel pixel under `supersample`',
        'An unknown palette, font, icon, or color throws naming it',
        '`numerals` text holding a character that font lacks',
        // htmlRenderer pointer
        '`available`, `disabled` (PIXOO_HTML_ENABLED=false), or `no_browser`',
      ]) {
        expect(craftGuidance).toContain(term);
      }
    });

    // The framework rejects an undeclared top-level key, so the suggestion is held to it too.
    const StrictHtmlInput = z.strictObject(pixooRenderHtml.input.shape);

    it.each([
      ['reachable', fakeStatus, true],
      ['unreachable', { reachable: false }, false],
    ] as const)(
      '%s: suggests a pixoo_render_html loop whose args validate',
      async (_state, status, push) => {
        await setBrowserPath('available');
        stubStatus(status as typeof fakeStatus);
        const result = await pixooDesignBrief.handler(
          pixooDesignBrief.input.parse({ topic: 'html' }),
          createMockContext(),
        );
        const [suggestion] = result.nextToolSuggestions;
        expect(result.nextToolSuggestions).toHaveLength(1);
        expect(suggestion?.toolName).toBe('pixoo_render_html');
        const parsed = StrictHtmlInput.safeParse(suggestion?.args);
        expect(parsed.success, parsed.error?.message).toBe(true);
        expect(suggestion?.args).toMatchObject({
          frames: 20,
          sampling: 'supersample',
          push,
        });
        expect(suggestion?.args['html']).toContain('window.render = (t) =>');
      },
    );

    it('no_browser: still suggests pixoo_render_html, with the install step in its reason', async () => {
      await setBrowserPath('no_browser');
      stubStatus();
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'html' }),
        createMockContext(),
      );
      expect(result.nextToolSuggestions).toHaveLength(1);
      expect(result.nextToolSuggestions[0]?.toolName).toBe('pixoo_render_html');
      expect(result.nextToolSuggestions[0]?.reason).toContain(BROWSER_UNAVAILABLE_RECOVERY);
    });

    it('disabled: suggests the animation topic’s compose_scene call instead of the unlisted tool', async () => {
      process.env['PIXOO_HTML_ENABLED'] = 'false';
      resetServerConfig();
      stubStatus();
      const html = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'html' }),
        createMockContext(),
      );
      const animation = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'animation' }),
        createMockContext(),
      );
      expect(html.nextToolSuggestions.map((s) => s.toolName)).toEqual(['pixoo_compose_scene']);
      expect(html.nextToolSuggestions[0]?.reason).toContain('PIXOO_HTML_ENABLED=false');
      expect(html.nextToolSuggestions[0]?.args).toEqual(animation.nextToolSuggestions[0]?.args);
    });
  });

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

  it('topic "pixel-art" points at finish for palette reduction and dithering', async () => {
    stubStatus();
    const { craftGuidance } = await pixooDesignBrief.handler(
      pixooDesignBrief.input.parse({ topic: 'pixel-art' }),
      createMockContext(),
    );
    expect(craftGuidance).not.toContain('Dithering patterns not supported');
    for (const term of ['`finish`', 'pixoo_push_image', '`colors`', '`palette`', '`dither`']) {
      expect(craftGuidance).toContain(term);
    }
    expect(craftGuidance).toContain('`bayer4`');
    expect(craftGuidance).toContain('`floyd-steinberg`');
  });

  it('topic "scene" carries a glow recipe: a larger, dimmer shape blended add beneath the bright one', async () => {
    stubStatus();
    const { craftGuidance } = await pixooDesignBrief.handler(
      pixooDesignBrief.input.parse({ topic: 'scene' }),
      createMockContext(),
    );
    expect(craftGuidance).toContain('**Glow:**');
    expect(craftGuidance).toContain('`blend: "add"`');
  });

  it('topic "pixel-art" offers anti-aliased and wide strokes instead of calling them unavailable', async () => {
    stubStatus();
    const { craftGuidance } = await pixooDesignBrief.handler(
      pixooDesignBrief.input.parse({ topic: 'pixel-art' }),
      createMockContext(),
    );
    expect(craftGuidance).not.toContain('Not available');
    expect(craftGuidance).toContain('`antialias: true`');
    expect(craftGuidance).toContain('`strokeWidth`');
  });

  it('topic "troubleshooting" gives the measured panel response, not an unmeasured threshold', async () => {
    stubStatus();
    const { craftGuidance } = await pixooDesignBrief.handler(
      pixooDesignBrief.input.parse({ topic: 'troubleshooting' }),
      createMockContext(),
    );
    expect(craftGuidance).not.toContain('#202020');
    expect(craftGuidance).toContain('brightness 100, channel levels 0–4 stay dark');
    expect(craftGuidance).toContain('#D97757 reads red');
  });

  it.each(['text', 'dashboard'] as const)(
    'topic "%s" lists the symbols beyond ASCII and the numerals face',
    async (topic) => {
      stubStatus();
      const { craftGuidance } = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic }),
        createMockContext(),
      );
      expect(craftGuidance).toContain('`° ← ↑ → ↓ ▲ ▼ ♥ · …`');
      expect(craftGuidance).toContain('`font: "numerals"`');
      expect(craftGuidance).toContain('11×18');
      expect(craftGuidance).toContain('0–9, space, and `: . - + / % ° ?`');
    },
  );

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
      'html',
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
      'html',
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
      htmlRenderer: 'available' as const,
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
      htmlRenderer: 'available' as const,
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
