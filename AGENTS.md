# Developer Protocol

**Server:** pixoo-mcp-server
**Version:** 1.2.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0 (protocol revision 2026-07-28 alongside the 2025 era)
**Zod:** ^4.6.5

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

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
3. **Add services** — scaffold domain service integrations using the `add-service` skill
4. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
5. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
6. **Run `devcheck`** — lint, format, typecheck, and security audit
7. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `serviceUnavailable()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler. (`ctx.elicit` was removed in the SDK v2 migration.) The server declares `sessionMode: 'stateless'` because no handler does this today — the first one that does changes it to `{ default: 'stateful', require: 'stateful' }` in `src/index.ts`, `.env.example`, the Dockerfile, and the README.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Every `PixooResult` checked.** No fire-and-forget device calls. `pushed: true` means `error_code: 0` from the device.
- **Adding an env var requires both files** — `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`). `bun run lint:packaging` verifies the names match.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

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
    pushed: z.boolean().describe('True if the device acknowledged the push.'),
  }),
  async handler(input, ctx) {
    const service = getPixooService();
    const { preview, pushed } = await renderAndPush(input, service);
    // Rendered bytes go through ctx.content — prepended to content[] and never
    // written to structuredContent, so the base64 is carried once, not twice.
    ctx.content.image(preview, 'image/png');
    ctx.log.info('Text rendered', { pushed });
    return { pushed };
  },
  format: (result) => [{ type: 'text', text: `Pushed: ${result.pushed}` }],
});
```

**Rendered previews never enter `output`.** Every render tool emits its PNG with
`ctx.content.image(...)`. Declaring it as an `output` field too would ship the base64
twice — once in `structuredContent`, once in the `content[]` block.

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

### Session posture and shutdown

```ts
await createApp({
  sessionMode: 'stateless',
  setup(core) { initPixooService(core.config, core.storage); },
});
```

`sessionMode` declares the HTTP session posture in `src/`. `MCP_SESSION_MODE` still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). Add `require: 'stateful'` when a tool asks the caller for input mid-handler via `ctx.requestInput`: startup then fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt. Stdio is never refused.

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. It runs after the transport stops and before the logger closes, on every shutdown path. This server passes none: `PixooService` opens a `fetch` per device command and holds no persistent handle. Add one if a service starts keeping a socket, watcher, or ref'd timer.

---

## Context

Handlers receive a unified `ctx` object. Key properties used by this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `.notice()` / `.total()` / `.echo()` / `.truncated()`. Lands only when the definition declares an `enrichment` block. |
| `ctx.fail` | Typed throw against the definition's `errors[]` reason union — auto-populates `data.reason`. |
| `ctx.recoveryFor` | `{ recovery: { hint } }` for a declared reason, resolved from the contract. Pass it as `ctx.fail`'s data argument (or spread it in) to put the declared hint on the wire. |
| `ctx.state` | Tenant-scoped KV — `.get`, `.set(key, value, { ttl? })`, `.delete`, `.getMany`, `.list`. Keys are validated; colons are not legal separators. |
| `ctx.requestInput` / `ctx.inputs` | Multi-round-trip input. `return ctx.requestInput(...)`; read the answers with `ctx.inputs.accepted(key, schema)` on re-entry. Unused by this server. |
| `ctx.signal` | `AbortSignal` for cancellation. Pass it to any long-running I/O. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

Pixoo-specific error reasons declared on tools:

| Reason | Code | When | `retryable` |
|:-------|:-----|:-----|:------------|
| `device_unreachable` | `ServiceUnavailable` | Toolkit result kind `network`/`timeout` | `true` |
| `device_http_error` | `ServiceUnavailable` | Non-2xx from the device's HTTP server | `true` for 408, 429, 500, 502–504; `false` otherwise |
| `device_rejected` | `ServiceUnavailable` | Firmware returned non-zero `error_code` | — |
| `no_device_configured` | `InvalidParams` | Device tool called without `PIXOO_IP` | — |
| `asset_not_found` | `NotFound` | Image/sprite path or URL unreadable | — |
| `invalid_color` | `InvalidParams` | `resolveColor` throw — invalid color name or format | — |
| `unknown_icon` | `InvalidParams` | Icon name not in registry | — |
| `discovery_failed` | `ServiceUnavailable` | Divoom cloud unreachable | `true` |

`PixooService` and `src/renderer/` raise the device, configuration, and asset reasons themselves (a factory error carrying `data.reason`), so those entries carry `thrownBy: 'service'` — lint-only metadata that keeps `error-contract-unthrown` from reading them as dead. A reason the handler throws with `ctx.fail` stays unmarked, and every such site forwards its declared recovery with `ctx.recoveryFor`. A computed reason forwards the same way (`ctx.recoveryFor(reason)`); `lint:mcp` skips a definition whose `ctx.fail` reason is non-literal, so a clean lint says nothing about those sites.

A contract's `retryable` reaches the wire only through `ctx.fail`; a service throw carries it only when the service writes `data.retryable` itself. `classifyDeviceFailure` (in `pixoo-service.ts`) is the one place a failed device call becomes a reason and a retryability — `PixooService` writes both on its push-path throws, and `pixoo_overlay_text` passes the retryability into `ctx.fail` so it overrides the contract default per occurrence.

The three push tools (`pixoo_display_text`, `pixoo_compose_scene`, `pixoo_push_image`) share one post-render path in `src/mcp-server/tools/device-push.ts`. `pushKeepingPreview` rethrows a failed push's error with its code, `reason`, `retryable`, and recovery untouched, adding `data.outputFiles` (the file the call already saved, else a copy in a fresh `os.tmpdir()` directory) and naming the path in the message. The framework drops `ctx.content` blocks from error results, so the file path is how the render survives. On success, `visibilityNotice` turns the post-push `DeviceStateSnapshot` into one `ctx.enrich.notice` (screen off, brightness ≤ 10, not on the custom channel). `ctx.enrich.notice` is last-wins, so a tool with a second notice source composes them into one string.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_device_configured', code: JsonRpcErrorCode.InvalidParams,
    when: 'PIXOO_IP is not set.',
    recovery: 'Run pixoo_discover_devices to find the device IP, then set PIXOO_IP.',
    thrownBy: 'service' },
  { reason: 'invalid_color', code: JsonRpcErrorCode.InvalidParams,
    when: 'The color value could not be resolved.',
    recovery: 'Use a hex color (#RRGGBB or #RGB, with or without the #) or a case-insensitive named color such as white, orange, or claude.' },
],

// in the handler
throw ctx.fail('invalid_color', `Invalid color "${input.color}"`, ctx.recoveryFor('invalid_color'));
```

Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring. A tool argument that fails the input schema reaches the client as `InvalidParams` (-32602) with `structuredContent.error` — assert that code, not `ValidationError`, in tests.

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
  renderer/
    themes.ts                           # Theme + palette registry
    icons.ts                            # Icon registry (SVG path data by category)
    text-engine.ts                      # Gradient ramp + shadow + outline text engine, overflow handling
    scene-renderer.ts                   # Element vocabulary, layout resolver, frame rendering
    keyframes.ts                        # Keyframe interpolation + animation preset compiler
    preview.ts                          # PNG/contact-sheet/GIF encoding
    remote-image.ts                     # https image fetch to a temp file for the toolkit loader; stops on ctx.signal
  mcp-server/
    tools/
      device-push.ts                    # Shared post-render push: preview kept on failure, visibility notice
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
  index.session-mode.test.ts            # Boots the entry point over HTTP, pins the declared session mode
  renderer/                             # Pure renderer unit tests (no device)
  resources/                            # Resource handler tests
  services/pixoo/                       # PixooService tests with a fake client
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, and this server ships `.claude-plugin/` and `.codex-plugin/`, so a root `skills/` would hand these development skills to every agent that installs it.

**Agent skill directories:** `.claude/skills/` and `.agents/skills/` carry copies of `framework-skills/`. After framework updates, run the `maintenance` skill — Phase B re-syncs both.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseEnvConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, createFetchMock, runToolContract, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation.

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, MCPB `user_config` wiring, plugin manifests, README version badge (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies and strips dependency-shipped agent docs and platform-specific native bindings that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP deployments are unaffected.

`lint:packaging` verifies that `server.json` and `manifest.json` declare the same env var names, that every `manifest.json` `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.<key>}"` (the host substitutes nothing else), that an optional string option carries `"default": ""`, that no plugin manifest writes an empty `env` value, and that the README `Version-` badge matches `package.json`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved. `CHANGELOG.md` is a **navigation index** regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter: `summary` (required, ≤350 chars), optional `breaking: true` for changes consumers must act on, optional `security: true` only for a security fix in this server's own source (never a dependency CVE bump — those go under `## Dependencies`).

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Tool inputs are strict at the root — an undeclared argument key is rejected by name. Add `.passthrough()` / `.catchall()` only where an open object is genuinely required
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders every `output` field as text — different clients read different surfaces (`structuredContent` vs `content[]`); `lint:mcp` enforces parity. Rendered image bytes go through `ctx.content.image(...)`, never an `output` field
- [ ] Every device call goes through `PixooService`; every `PixooResult` checked
- [ ] Renderer functions have no device dependency — testable without hardware
- [ ] Env var added? Declared in BOTH `server.json` and `manifest.json` (`lint:packaging` enforces parity)
- [ ] `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` carry the `package.json` `version`; display fields use the unscoped repo name `pixoo-mcp-server`. A user-supplied variable goes in `env_vars` (`.codex-plugin/mcp.json`) or `userConfig` + `"${user_config.<option>}"` (`.claude-plugin/plugin.json`) — never `"KEY": ""` in `env`
- [ ] `bun run devcheck` and `bun run test` pass
