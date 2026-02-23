# Changelog

All notable changes to this project will be documented in this file.

---

## [0.3.1] - 2026-02-23

### Added

- Added `example-output/hello_from_claude.png` hero image to README header.
- Added Example Output reference link to README.
- Added npm keywords: `animation`, `claude`, `divoom-pixoo`, `iot`, `sprite`.

### Changed

- Renamed npm package from `pixoo-mcp-server` to `@cyanheads/pixoo-mcp-server` (scoped package). Legacy `pixoo-mcp-server` bin entry preserved for backward compatibility.
- Rewrote `README.md` — expanded tools table with annotations, added Streamable HTTP config, server features section, project structure table, security overview, testing and contributing sections.
- Unified project description across `package.json`, `server.json`, and README to "Compose and push pixel art, animations, and text to Divoom Pixoo LED matrices via MCP."
- Corrected `.env.example` log level values to match Pino levels (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`).
- Updated `server.json` npm identifiers to scoped package name.

---

## [0.3.0] - 2026-02-22

### Added

- Auto-save output directory (`PIXOO_OUTPUT_DIR` env var / `pixoo.outputDir` config) — compose and push-image tools automatically save preview files when configured.
- GIF animation export in `pixoo_compose` — animated compositions now output a single `.gif` instead of per-frame PNGs (uses `saveAnimationGif` from pixoo-toolkit 0.4.0).

### Fixed

- Prevented Pino serialization crash caused by spreading raw SDK context (contains `AbortSignal`) into `RequestContext` in tool and resource handler factories.
- Made `channelIndex` and `clockId` optional in `pixoo_control` output schema to match actual device response variability.

### Changed

- Bumped `@cyanheads/pixoo-toolkit` from `^0.3.2` to `0.4.0` (pinned) — adds `gifenc` dependency for GIF encoding.
- Bumped `hono` from `4.11.9` to `4.11.10`.
- Refactored config path resolution with shared `resolveDir` helper for cleaner project root derivation.

---

## [0.2.0] - 2026-02-22

### Added

- Integrated `@cyanheads/pixoo-toolkit` (v0.3.2) as the core device communication and rendering library.
- Added `pixoo` config block (`PIXOO_IP`, `PIXOO_SIZE`) with Zod validation in `src/config/index.ts`.
- Registered `PixooClientToken` as a DI-managed lazy singleton in `src/container/`.
- Implemented `pixoo_compose` tool — compose layered scenes (text, images, sprites, shapes, bitmaps, pixels) with multi-frame animation and per-element keyframes.
- Implemented `pixoo_push_image` tool — load and push a single image file to the display.
- Implemented `pixoo_text` tool — native on-device scrolling text overlays via `Draw/SendHttpText`.
- Implemented `pixoo_control` tool — read/change device settings (brightness, screen, channel, clock face).
- Added example output GIFs (`example-output/`) — `neon-city-preview.gif` (animated neon cityscape) and `hello-heart.gif`.

### Tests

- Added unit tests for `pixoo_control`, `pixoo_push_image`, and `pixoo_text` tools.
- Updated test setup to provide default `PIXOO_IP` env var for test environments.
- Updated config tests for pixoo-specific expectations (`openrouterAppName`, `PIXOO_IP`).
- Added `PixooClientToken` to DI token registry tests.
- Updated resource tests to gracefully handle empty resource definitions array.
- Updated fuzz tests with pixoo tool skip lists (DI/device dependencies, discriminatedUnion schemas).
- Regenerated tool schema snapshots for pixoo tools (replaced template tool snapshots).
- Removed stale resource schema snapshot file.

### Changed

- Updated `docs/tree.md` to reflect current project structure.
- Normalized quote style in `smithery.yaml`.
- Updated `CLAUDE.md` — version bump, removed worker/edge parity references, pointed template references to pixoo tools.

### Removed

- Removed 7 template tool definitions and their tests (echo, cat-fact, image-test, madlibs-elicitation, code-review-sampling, async-countdown, data-explorer).
- Removed template resource definitions (echo, data-explorer-ui) and their tests.
- Removed template prompt definition (code-review) and its test.
- Removed unused `@modelcontextprotocol/ext-apps` dependency.

---

## [0.1.0] - 2026-02-22

### Added

- Initial project scaffolding from [`mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template) v2.9.6.
- Design doc at `docs/pixoo-mcp-server.md` with full tool specs, element types, animation system, and device quirks.
- `CLAUDE.md` Pixoo integration section: service pattern, tool rendering pipeline, text parameter mapping, device quirks.

### Changed

- Rebranded all project meta files (`package.json`, `server.json`, `smithery.yaml`, `Dockerfile`, `typedoc.json`, `wrangler.toml`) from `mcp-ts-template` to `pixoo-mcp-server`.
- Rewrote `README.md` with Pixoo-specific tools, configuration, usage examples, and device quirks.
- Simplified `.env.example` to Pixoo-relevant config (removed auth, database, LLM sections).
- Updated `smithery.yaml` config schema to require `PIXOO_IP` and expose `PIXOO_SIZE`.
- Updated `server.json` with Pixoo environment variables for both stdio and HTTP transports.

### Removed

- Old template changelog archives (`changelog/archive1.md`, `changelog/archive2.md`).
- Cloudflare D1 schema (`schemas/cloudflare-d1-schema.sql`) — not applicable for local device communication.
