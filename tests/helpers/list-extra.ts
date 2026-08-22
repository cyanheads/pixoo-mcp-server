/**
 * @fileoverview Minimal `ListExtra` stand-in for exercising resource `list()` providers.
 * `list()` receives the SDK's `ServerContext`, not a handler `Context`; the listings in
 * this server are static and read nothing off it, so an empty cast is enough.
 * @module tests/helpers/list-extra
 */

import type { ListExtra } from '@cyanheads/mcp-ts-core/resources';

/** Build a throwaway `ListExtra` for a `list()` provider that ignores it. */
export function listExtra(): ListExtra {
  return {} as ListExtra;
}
