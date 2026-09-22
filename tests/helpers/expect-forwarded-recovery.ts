/**
 * @fileoverview Asserts that a tool error result carries its declared `errors[]` recovery
 * on both client surfaces — `structuredContent.error.data.recovery.hint` and the
 * `Recovery:` line of the `content[]` text.
 * @module tests/helpers/expect-forwarded-recovery
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Assert `result` failed with `reason` and forwarded that reason's declared recovery. */
export function expectForwardedRecovery(
  result: ToolResult,
  errors: ReadonlyArray<{ reason: string; recovery: string }> | undefined,
  reason: string,
): void {
  const hint = errors?.find((entry) => entry.reason === reason)?.recovery;
  expect(hint, `no errors[] entry declares '${reason}'`).toBeDefined();

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint } } },
  });

  const text = result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  expect(text).toContain(`Recovery: ${hint}`);
  expect(text).toContain(`(reason ${reason}`);
}
