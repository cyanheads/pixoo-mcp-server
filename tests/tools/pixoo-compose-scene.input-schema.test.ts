/**
 * @fileoverview Structural checks on the pixoo_compose_scene input schema: every nested
 * object is closed, and every documented compose example still validates.
 * @module tests/tools/pixoo-compose-scene.input-schema.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pixooComposeScene } from '@/mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { pixooDesignBrief } from '@/mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';
import { resultText } from '../helpers/device-failure.js';
import { keysAt, objectNodes, openObjectPaths } from '../helpers/zod-object-nodes.js';

describe('pixoo_compose_scene input schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('every nested object is closed', () => {
    const nodes = objectNodes(pixooComposeScene.input);

    it('no object below the root accepts an undeclared key', () => {
      expect(openObjectPaths(pixooComposeScene.input)).toEqual([]);
    });

    it('the walk reaches each nested object, so it cannot pass on an empty visit', () => {
      expect(new Set(nodes.map((node) => node.path))).toEqual(
        new Set([
          '',
          'background',
          'background.gradient',
          'elements[]',
          'elements[].style',
          'elements[].style.palette',
          'elements[].gradient',
          'elements[].data[]',
          'elements[].effect',
          'elements[].animate',
          'elements[].finish',
        ]),
      );
      // One object per element type in the discriminated union.
      expect(keysAt(nodes, 'elements[]')).toHaveLength(11);
      expect(keysAt(nodes, 'elements[].style.palette')).toEqual([['from', 'to']]);
      expect(keysAt(nodes, 'elements[].data[]')).toEqual([['color', 'x', 'y']]);
      expect(keysAt(nodes, 'background')).toEqual([['gradient', 'theme']]);
      expect(keysAt(nodes, 'elements[].effect')).toHaveLength(11);
      // Seven elements with a color field take the color track; bitmap, progress, image, and sprite do not.
      const animate = keysAt(nodes, 'elements[].animate').map((keys) => keys.join(','));
      expect(animate.filter((keys) => keys === 'color,dx,dy,opacity,visible')).toHaveLength(7);
      expect(animate.filter((keys) => keys === 'dx,dy,opacity,visible')).toHaveLength(4);
    });

    it('the walker flags an open object at any depth', () => {
      const schema = z.object({
        a: z.array(z.strictObject({ b: z.object({ c: z.string() }).optional() })),
        d: z.union([z.string(), z.object({ e: z.number() })]),
      });
      expect(openObjectPaths(schema)).toEqual(['a[].b', 'd']);
    });

    it('an unknown top-level key fails -32602 invalid_arguments before the handler runs', async () => {
      const handler = vi.spyOn(pixooComposeScene, 'handler');
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [],
        push: false,
        colour: '#ff0000',
      } as z.input<typeof pixooComposeScene.input>);

      const hint =
        'Unknown key colour. This tool accepts: background, elements, frames, speed, push, output.';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', recovery: { hint } },
        },
      });
      expect(resultText(result)).toContain(hint);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('which failure an element with effect and animate reports', () => {
    const both = {
      effect: { name: 'pulse' },
      animate: {
        dx: [
          [0, 0],
          [7, 10],
        ],
      },
    };
    const BOTH_MESSAGE = 'elements.0.effect: Set either effect or animate on an element, not both';

    async function hintFor(element: Record<string, unknown>) {
      const result = await runToolContract(pixooComposeScene, {
        background: '#000000',
        elements: [element],
        frames: 8,
        push: false,
      } as z.input<typeof pixooComposeScene.input>);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      return (result.structuredContent as { error: { data: { recovery: { hint: string } } } }).error
        .data.recovery.hint;
    }

    it('an unknown key is reported first, then effect with animate', async () => {
      const hint = await hintFor({
        type: 'rect',
        x: 0,
        y: 0,
        w: 8,
        h: 8,
        colour: 'blue',
        ...both,
      });
      expect(hint.startsWith('Unknown key elements.0.colour. elements.0 accepts:')).toBe(true);
      expect(hint).toContain(BOTH_MESSAGE);
    });

    it('a missing required field stops the element before effect with animate is checked', async () => {
      const hint = await hintFor({ type: 'circle', cx: 1, cy: 1, ...both });
      expect(hint).toBe('Provide elements.0.radius.');
    });
  });

  describe('documented compose examples validate', () => {
    // The framework rejects an undeclared top-level key, so the examples are held to it too.
    const StrictInput = z.strictObject(pixooComposeScene.input.shape);

    function expectValid(args: unknown) {
      const parsed = StrictInput.safeParse(args);
      expect(parsed.success, parsed.error?.message).toBe(true);
    }

    describe('pixoo_design_brief compose suggestions', () => {
      const STATES = {
        reachable: { reachable: true, channel: 'custom', brightness: 80, screenOn: true },
        unreachable: { reachable: false },
      };

      it.each(
        (['scene', 'dashboard', 'animation'] as const).flatMap((topic) =>
          Object.entries(STATES).map(([state, status]) => [topic, state, status] as const),
        ),
      )('%s (%s): every pixoo_compose_scene suggestion validates', async (topic, _s, status) => {
        initPixooService(
          {} as Parameters<typeof initPixooService>[0],
          {} as Parameters<typeof initPixooService>[1],
        );
        vi.spyOn(getPixooService(), 'getStatus').mockResolvedValue(status);
        const result = await pixooDesignBrief.handler(
          pixooDesignBrief.input.parse({ topic }),
          createMockContext(),
        );
        const compose = result.nextToolSuggestions.filter(
          (s) => s.toolName === 'pixoo_compose_scene',
        );
        expect(compose.length).toBeGreaterThan(0);
        for (const suggestion of compose) expectValid(suggestion.args);
      });
    });

    /** Fenced ```json blocks in `file` that are compose arguments (they carry `elements`). */
    function composeExamples(file: string): Array<[string, unknown]> {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
        .map((match) => JSON.parse(match[1] ?? '') as unknown)
        .filter((json) => typeof json === 'object' && json !== null && 'elements' in json)
        .map((json, i) => [`${file} example ${i + 1}`, json]);
    }

    const DESIGN_EXAMPLES = composeExamples('docs/design.md');
    const EXAMPLES = [...DESIGN_EXAMPLES, ...composeExamples('README.md')];

    it('docs/design.md carries compose examples to check', () => {
      expect(DESIGN_EXAMPLES.length).toBeGreaterThan(0);
    });

    it.each(EXAMPLES)('%s validates', (_label, args) => {
      expectValid(args);
    });
  });
});
