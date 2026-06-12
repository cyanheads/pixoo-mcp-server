# Developer Protocol

**Server:** pixoo-mcp-server
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Architecture Overview

Local-network MCP server for Divoom Pixoo LED matrix displays (Pixoo-64 primary; 16/32 supported). The server owns all composition — rendering happens in an RGBA canvas pipeline on the host via `@cyanheads/pixoo-toolkit`, and the device receives final RGB frames over its local HTTP API.

**Two distinct layers:**

- **`src/renderer/`** — Pure rendering pipeline with no device dependency. Element renderers, styled-text engine (gradient ramps, shadows, outlines, semantic alignment), theme/palette registry, icon registry, effect compiler (presets → keyframes), keyframe interpolation, preview encoding (PNG/contact-sheet/GIF). Independently unit-testable.
- **`src/services/pixoo/`** — `PixooService` wraps `@cyanheads/pixoo-toolkit`. Handles lazy init from config, command serialization with min-interval pacing, `ensureCustomChannel()`, result→error-contract mapping, and device state snapshots.

Tools call renderer + service; they don't talk to the toolkit directly.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date
2. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
3. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill
4. **Run `devcheck`** — lint, format, typecheck, and security audit
5. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
6. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `serviceUnavailable()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Every `PixooResult` checked.** No fire-and-forget device calls. `pushed: true` means `error_code: 0` from the device.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it.

---

## Patterns

### Tool — display text example

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

export const pixooDisplayText = tool('pixoo_display_text', {
  title: 'pixoo_display_text',
  description:
    'Render styled text (theme, gradient, shadow, outline, auto-fit) onto the Pixoo display and push it. Returns the rendered frame as an image content block for immediate inspection.',
  annotations: { idempotentHint: true, destructiveHint: false },
  input: z.object({
    text: z.union([
      z.string().describe('Single string of text to display.'),
      z.array(z.string()).describe('Lines of text.'),
    ]).describe('Text to display.'),
    theme: z.enum(['midnight', 'ember', 'claude', 'ice', 'neon', 'forest', 'mono'])
      .optional().describe('Named scene theme.'),
    push: z.boolean().default(true).describe('Push to device after render.'),
  }),
  output: z.object({
    preview: z.string().describe('Base64-encoded PNG preview of the rendered frame.'),
    pushed: z.boolean().describe('True if the device acknowledged the push.'),
  }),
  async handler(input, ctx) {
    const service = getPixooService();
    const result = await renderAndPush(input, service);
    ctx.log.info('Text rendered', { pushed: result.pushed });
    return result;
  },
  format: (result) => [
    { type: 'image', data: result.preview, mimeType: 'image/png' },
    { type: 'text', text: `Pushed: ${result.pushed}` },
  ],
});
```

### Resource

```ts
import { resource } from '@cyanheads/mcp-ts-core';

export const pixooDeviceStatusResource = resource('pixoo://device/status', {
  name: 'device-status',
  title: 'Pixoo Device Status',
  description: 'Live snapshot of the connected Pixoo display.',
  mimeType: 'application/json',
  async handler(_params, ctx) {
    const service = getPixooService();
    return service.getStatus();
  },
});
```

### Server config

```ts
// src/config/server-config.ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  pixooIp: z.string().optional().describe('Device IP on the local network.'),
  pixooSize: z.coerce.number()
    .refine((v) => v === 16 || v === 32 || v === 64)
    .default(64).describe('Display size in pixels (16, 32, or 64).'),
  pixooOutputDir: z.string().optional().describe('Auto-save directory for preview PNG/GIF files.'),
  pixooPushMinIntervalMs: z.coerce.number().int().min(0).default(1000)
    .describe('Pacing floor between device pushes in milliseconds.'),
});

export function getServerConfig() {
  return parseEnvConfig(ServerConfigSchema, {
    pixooIp: 'PIXOO_IP',
    pixooSize: 'PIXOO_SIZE',
    pixooOutputDir: 'PIXOO_OUTPUT_DIR',
    pixooPushMinIntervalMs: 'PIXOO_PUSH_MIN_INTERVAL_MS',
  });
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties used by this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

Pixoo-specific error reasons declared on tools:

| Reason | Code | When |
|:-------|:-----|:-----|
| `device_unreachable` | `ServiceUnavailable` | Toolkit result kind `network`/`timeout` |
| `device_http_error` | `ServiceUnavailable` | Non-2xx from the device's HTTP server |
| `device_rejected` | `ServiceUnavailable` | Firmware returned non-zero `error_code` |
| `no_device_configured` | `InvalidParams` | Device tool called without `PIXOO_IP` |
| `asset_not_found` | `NotFound` | Image/sprite path or URL unreadable |
| `invalid_color` | `InvalidParams` | `resolveColor` throw — invalid color name or format |
| `unknown_icon` | `InvalidParams` | Icon name not in registry |
| `discovery_failed` | `ServiceUnavailable` | Divoom cloud unreachable |

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_device_configured', code: JsonRpcErrorCode.InvalidParams,
    when: 'PIXOO_IP not configured',
    recovery: 'Run pixoo_discover_devices to find device IPs, then set PIXOO_IP.' },
  { reason: 'device_unreachable', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Device network timeout or connection refused',
    recovery: 'Check the device is on the same LAN and powered on, then retry.' },
],
```

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    pixoo/
      pixoo-service.ts                  # PixooService — toolkit wrapper, pacing, result mapping
      types.ts                          # Service types
  renderer/
    themes.ts                           # Theme + palette registry
    icons.ts                            # Icon registry (SVG path data by category)
    styled-text.ts                      # Gradient ramp + shadow + outline text engine
    layout.ts                           # Semantic positioning resolver
    effects.ts                          # Animation preset → keyframe compiler
    keyframes.ts                        # Keyframe interpolation (lerp numbers/colors, snap booleans)
    preview.ts                          # PNG/contact-sheet/GIF encoding
    elements/                           # Per-type element renderers
  mcp-server/
    tools/definitions/
      pixoo-display-text.tool.ts
      pixoo-compose-scene.tool.ts
      pixoo-push-image.tool.ts
      pixoo-overlay-text.tool.ts
      pixoo-control-device.tool.ts
      pixoo-discover-devices.tool.ts
      pixoo-design-brief.tool.ts
    resources/definitions/
      pixoo-device-status.resource.ts
      pixoo-themes.resource.ts
      pixoo-icons.resource.ts
      pixoo-design-guide.resource.ts
tests/
  renderer/                             # Pure renderer unit tests (no device)
  tools/                                # Tool handler tests with mock context
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `pixoo-display-text.tool.ts` |
| Tool/resource names | snake_case | `pixoo_display_text` |
| Directories | kebab-case | `src/services/pixoo/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Render styled text onto the display.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface |
| `security-pass` | Audit server for MCP-flavored security gaps |
| `code-simplifier` | Post-session cleanup against `git diff` |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-context` | Context interface, logger, state, progress |
| `api-testing` | createMockContext, test patterns |

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation.

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit` |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff |
| `bunx vitest run` | Run tests |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — image content blocks for renders, text for structured data
- [ ] Every device call goes through `PixooService`; every `PixooResult` checked
- [ ] Renderer functions have no device dependency — testable without hardware
- [ ] `npm run devcheck` passes
