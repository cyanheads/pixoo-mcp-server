# Changelog

All notable changes to this project will be documented in this file.

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
