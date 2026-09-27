/**
 * @fileoverview Structural checks on the pixoo_display_text input schema: every nested
 * object is closed, an unknown key fails by its full path, and every pixoo_display_text
 * suggestion the design brief makes still validates.
 * @module tests/tools/pixoo-display-text.input-schema.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pixooDesignBrief } from '@/mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { pixooDisplayText } from '@/mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';
import { resultText } from '../helpers/device-failure.js';
import { keysAt, objectNodes, openObjectPaths } from '../helpers/zod-object-nodes.js';

type DisplayInput = z.input<typeof pixooDisplayText.input>;

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const hintOf = (result: ToolResult) =>
  (result.structuredContent as { error: { data: { recovery: { hint: string } } } }).error.data
    .recovery.hint;

/** Asserts a -32602 invalid_arguments failure on both surfaces, before the handler ran. */
function expectRejected(result: ToolResult, handler: ReturnType<typeof vi.spyOn>) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: -32602, data: { reason: 'invalid_arguments' } },
  });
  expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
  expect(result.content.some((block) => block.type === 'image')).toBe(false);
  expect(handler).not.toHaveBeenCalled();
}

const NUMERALS_HINT =
  'text: Characters not in the numerals font: "F". It draws 0–9, space, and : . - + / % ° ? only. Set units and labels in the standard or compact font, or use pixoo_compose_scene to place a numerals text element beside a standard or compact label.';

describe('pixoo_display_text input schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('every nested object is closed', () => {
    const nodes = objectNodes(pixooDisplayText.input);

    it('no object below the root accepts an undeclared key', () => {
      expect(openObjectPaths(pixooDisplayText.input)).toEqual([]);
    });

    it('the walk reaches each nested object, so it cannot pass on an empty visit', () => {
      expect(new Set(nodes.map((node) => node.path))).toEqual(
        new Set(['', 'background', 'background.gradient', 'style', 'style.palette', 'position']),
      );
      expect(keysAt(nodes, 'background')).toEqual([['gradient']]);
      expect(keysAt(nodes, 'background.gradient')).toEqual([['from', 'to', 'type']]);
      expect(keysAt(nodes, 'style')).toEqual([['color', 'outline', 'palette', 'scale', 'shadow']]);
      expect(keysAt(nodes, 'style.palette')).toEqual([['from', 'to']]);
      expect(keysAt(nodes, 'position')).toEqual([['x', 'y']]);
    });
  });

  describe('an unknown key fails -32602 by its full path, before the handler runs', () => {
    it('at the root, naming what the tool accepts', async () => {
      const handler = vi.spyOn(pixooDisplayText, 'handler');
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        push: false,
        colour: '#ff0000',
      } as DisplayInput);

      const hint =
        'Unknown key colour. This tool accepts: text, theme, background, style, font, position, align, effect, push, brightness.';
      expectRejected(result, handler);
      expect(hintOf(result)).toBe(hint);
      expect(resultText(result)).toContain(hint);
    });

    it.each([
      [
        'style.colour',
        { style: { colour: '#ff0000' } },
        'Unknown key style.colour. style accepts: palette, shadow, outline, scale, color.',
      ],
      [
        'style.palette.mid',
        { style: { palette: { from: 'white', to: 'blue', mid: 'green' } } },
        'Unknown key style.palette.mid. style.palette accepts: from, to.',
      ],
      ['position.X', { position: { X: 3 } }, 'Unknown key position.X. position accepts: x, y.'],
      [
        // The typo also leaves the required gradient out, so both are reported.
        'background.gradeint',
        { background: { gradeint: { type: 'v', from: 'navy', to: 'black' } } },
        'Provide background.gradient. Unknown key background.gradeint. background accepts: gradient.',
      ],
      [
        'background.gradient.via',
        { background: { gradient: { type: 'v', from: 'navy', to: 'black', via: 'teal' } } },
        'Unknown key background.gradient.via. background.gradient accepts: type, from, to.',
      ],
    ] as const)('%s', async (_path, extra, hint) => {
      const handler = vi.spyOn(pixooDisplayText, 'handler');
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        push: false,
        ...extra,
      } as DisplayInput);

      expectRejected(result, handler);
      expect(hintOf(result)).toBe(hint);
      expect(resultText(result)).toContain(hint);
    });

    it('does not hide the numerals check: both failures are reported', async () => {
      const handler = vi.spyOn(pixooDisplayText, 'handler');
      const result = await runToolContract(pixooDisplayText, {
        text: '72°F',
        font: 'numerals',
        push: false,
        style: { colour: 'red' },
      } as DisplayInput);

      expectRejected(result, handler);
      expect(hintOf(result)).toBe(
        `Unknown key style.colour. style accepts: palette, shadow, outline, scale, color. ${NUMERALS_HINT}`,
      );
    });
  });

  describe('what closing the objects leaves unchanged', () => {
    it('the numerals refinement message is exactly what it was', async () => {
      const result = await runToolContract(pixooDisplayText, {
        text: '72°F',
        font: 'numerals',
        push: false,
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(hintOf(result)).toBe(NUMERALS_HINT);
    });

    it.each([
      [
        'every documented style key, a custom palette stop, and pixel positions',
        {
          style: {
            palette: { from: 'white', to: 'blue' },
            shadow: true,
            outline: true,
            scale: 2,
            color: 'orange',
          },
          position: { x: 2, y: 3 },
          background: { gradient: { type: 'h', from: 'navy', to: 'black' } },
        },
      ],
      [
        'a named palette, semantic positions, and a solid background',
        {
          style: { palette: 'ember' },
          position: { x: 'left', y: 'top' },
          background: '#101020',
        },
      ],
    ] as const)('%s still render', async (_label, extra) => {
      const result = await runToolContract(pixooDisplayText, {
        text: 'HI',
        push: false,
        ...extra,
      } as DisplayInput);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ pushed: false, frames: 1 });
      expect(result.content.some((block) => block.type === 'image')).toBe(true);
    });
  });

  describe('pixoo_design_brief display_text suggestions validate', () => {
    // The framework rejects an undeclared top-level key, so the suggestions are held to it too.
    const StrictInput = z.strictObject(pixooDisplayText.input.shape);
    const STATES = {
      reachable: { reachable: true, channel: 'custom', brightness: 80, screenOn: true },
      unreachable: { reachable: false },
    };
    const cases = pixooDesignBrief.input.shape.topic.options.flatMap((topic) =>
      Object.entries(STATES).map(([state, status]) => [topic, state, status] as const),
    );

    it.each(cases)('%s (%s)', async (topic, _state, status) => {
      initPixooService(
        {} as Parameters<typeof initPixooService>[0],
        {} as Parameters<typeof initPixooService>[1],
      );
      vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue(status);
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic }),
        createMockContext(),
      );
      for (const suggestion of result.nextToolSuggestions) {
        if (suggestion.toolName !== 'pixoo_display_text') continue;
        const parsed = StrictInput.safeParse(suggestion.args);
        expect(parsed.success, parsed.error?.message).toBe(true);
      }
    });

    it('the brief makes display_text suggestions to check', async () => {
      initPixooService(
        {} as Parameters<typeof initPixooService>[0],
        {} as Parameters<typeof initPixooService>[1],
      );
      vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue(STATES.reachable);
      const result = await pixooDesignBrief.handler(
        pixooDesignBrief.input.parse({ topic: 'text' }),
        createMockContext(),
      );
      expect(result.nextToolSuggestions.map((s) => s.toolName)).toContain('pixoo_display_text');
    });
  });
});
