/**
 * @fileoverview Drives a device failure through the real `PixooService` push path and
 * asserts the assembled tool error — both client surfaces — against the tool's
 * declared `errors[]` contract.
 * @module tests/helpers/device-failure
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { PixooFailure } from '@cyanheads/pixoo-toolkit';
import { expect, vi } from 'vitest';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/**
 * Swap the service's device client for a fake whose frame and animation pushes fail
 * with `failure`. Everything above the client — pacing, channel check, failure
 * mapping — runs for real.
 */
export function failDevicePush(failure: PixooFailure): void {
  const client = {
    getChannel: vi.fn().mockResolvedValue({ ok: true, data: { SelectIndex: 3 } }),
    push: vi.fn().mockResolvedValue(failure),
    pushAnimation: vi.fn().mockResolvedValue(failure),
  };
  (getPixooService() as unknown as { client: unknown }).client = client;
}

/**
 * Assert `result` failed with `reason`, that the reason is declared on the tool as
 * `ServiceUnavailable`, and that `retryable` reaches both surfaces as given —
 * `undefined` meaning the key is absent and the text tail carries no retryability term.
 */
export function expectDeviceFailure(
  result: ToolResult,
  errors: ReadonlyArray<{ reason: string; code: number }> | undefined,
  reason: string,
  retryable: boolean | undefined,
): void {
  expect(errors?.find((entry) => entry.reason === reason)?.code).toBe(
    JsonRpcErrorCode.ServiceUnavailable,
  );

  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: { code: number; data: object } }).error;
  expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(error.data).toMatchObject({ reason, recovery: { hint: expect.any(String) } });
  if (retryable === undefined) expect(error.data).not.toHaveProperty('retryable');
  else expect(error.data).toMatchObject({ retryable });

  const text = result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  const tail =
    retryable === undefined
      ? `(reason ${reason})`
      : `(reason ${reason} · ${retryable ? 'retryable' : 'not retryable'})`;
  expect(text.trimEnd().slice(-tail.length)).toBe(tail);
  expect(text).toContain('Recovery: ');
}
