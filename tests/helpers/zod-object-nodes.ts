/**
 * @fileoverview Walks a Zod 4 input schema to every object schema it holds, so a test can
 * assert that each object below the root is closed to undeclared keys.
 * @module tests/helpers/zod-object-nodes
 */

import type { z } from '@cyanheads/mcp-ts-core';

/** The slice of a Zod 4 schema definition the walker reads. */
interface SchemaDef {
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  items?: readonly z.ZodType[];
  options?: readonly z.ZodType[];
  rest?: z.ZodType | null;
  shape?: Record<string, z.ZodType>;
  type: string;
}

const defOf = (schema: z.ZodType) => schema._zod.def as unknown as SchemaDef;

const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'nonoptional',
]);
const LEAVES = new Set(['string', 'number', 'boolean', 'enum', 'literal']);

/** One object schema met by the walker: where it sits, whether it is closed, and its keys. */
export interface ObjectNode {
  closed: boolean;
  keys: string[];
  path: string;
}

/**
 * Every object schema reachable from `schema`, by path: `.key` for a property, `[]` for an
 * array element, `[i]` for a tuple slot; unions and optional/default wrappers add nothing.
 * A schema type the walker does not know fails loudly rather than being skipped.
 */
export function objectNodes(schema: z.ZodType, path = '', out: ObjectNode[] = []): ObjectNode[] {
  const def = defOf(schema);
  if (def.type === 'object') {
    const shape = def.shape ?? {};
    out.push({
      path,
      closed: def.catchall !== undefined && defOf(def.catchall).type === 'never',
      keys: Object.keys(shape),
    });
    for (const [key, child] of Object.entries(shape)) {
      objectNodes(child, path ? `${path}.${key}` : key, out);
    }
  } else if (WRAPPERS.has(def.type) && def.innerType) {
    objectNodes(def.innerType, path, out);
  } else if (def.type === 'union' && def.options) {
    for (const option of def.options) objectNodes(option, path, out);
  } else if (def.type === 'array' && def.element) {
    objectNodes(def.element, `${path}[]`, out);
  } else if (def.type === 'tuple' && def.items) {
    for (const [i, item] of def.items.entries()) objectNodes(item, `${path}[${i}]`, out);
    if (def.rest) objectNodes(def.rest, `${path}[]`, out);
  } else if (!LEAVES.has(def.type)) {
    throw new Error(`objectNodes: unhandled schema type "${def.type}" at "${path}"`);
  }
  return out;
}

/** Paths of open object schemas below the root, which the framework closes itself. */
export const openObjectPaths = (schema: z.ZodType) =>
  objectNodes(schema)
    .filter((node) => node.path !== '' && !node.closed)
    .map((node) => node.path);

/** Keys of every object at `path`, one sorted list per object. */
export const keysAt = (nodes: ObjectNode[], path: string) =>
  nodes.filter((node) => node.path === path).map((node) => [...node.keys].sort());
