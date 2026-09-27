/**
 * @fileoverview `Object.prototype` member names as color inputs, and the assertion that a
 * render tool rejects one as `invalid_color`. A named-color table is a plain object, so a
 * lookup that doesn't restrict itself to own keys resolves these names to inherited members.
 * @module tests/helpers/prototype-color-names
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import { resultText } from './device-failure.js';
import { expectForwardedRecovery } from './expect-forwarded-recovery.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** The 12 own property names of `Object.prototype`. */
export const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);

/** The two names a lowercased lookup reaches, as written and upper-cased. */
export const PROTOTYPE_NAME_CASES = ['constructor', '__proto__', 'CONSTRUCTOR', '__PROTO__'];

/** Every prototype name plus the upper-cased forms of the two a lowercased lookup reaches. */
export const PROTOTYPE_COLOR_INPUTS = [...new Set([...PROTOTYPE_NAMES, ...PROTOTYPE_NAME_CASES])];

/** Assert `result` failed as `invalid_color` (-32602) for `value`, recovery on both surfaces. */
export function expectInvalidColor(
  result: ToolResult,
  errors: ReadonlyArray<{ reason: string; recovery: string }> | undefined,
  value: string,
): void {
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams },
  });
  expectForwardedRecovery(result, errors, 'invalid_color');
  expect(resultText(result)).toContain(JSON.stringify(value));
}
