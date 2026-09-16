# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [1.1.2](changelog/1.1.x/1.1.2.md) — 2026-09-16

@cyanheads/mcp-ts-core ^0.13.2 adoption: explicit stateless session mode, a structured -32602 argument-rejection envelope, unset-env normalization for PIXOO_* vars, and the framework skill tree moved to framework-skills/. Claude and Codex plugin manifests now forward PIXOO_IP/PIXOO_SIZE.

## [1.1.1](changelog/1.1.x/1.1.1.md) — 2026-08-22

Docker build stage pinned to $BUILDPLATFORM — 1.1.0 published no GHCR image; this restores the multi-arch (linux/amd64 + linux/arm64) publish.

## [1.1.0](changelog/1.1.x/1.1.0.md) — 2026-08-22 · ⚠️ Breaking · 🛡️ Security

SDK v2 adoption: rendered previews move from `output` to `content[]` (`previewData`/`previewMimeType` removed from 3 tools); fixes a dead path-traversal guard in `pixoo_compose_scene`'s output path (#5).

## [1.0.0](changelog/1.0.x/1.0.0.md) — 2026-06-12 · ⚠️ Breaking

Ground-up 1.0 rebuild on mcp-ts-core 0.10.6 — pure renderer pipeline, 7 tools, 4 resources, 166 tests.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-12

Project scaffold from @cyanheads/mcp-ts-core.
