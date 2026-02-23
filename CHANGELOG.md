# Changelog

All notable changes to this project will be documented in this file.

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
