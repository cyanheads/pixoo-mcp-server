# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [1.2.0](changelog/1.2.x/1.2.0.md) — 2026-09-23 · ⚠️ Breaking

pixoo_display_text adds scroll/float/pulse effects, align, and an honored font; animated previews return a full frame grid; failed pushes keep their render; design_brief's suggestion shape and overlay_text's x/y/width bounds change (breaking); scene image sizing and per-source caching are fixed.

## [1.1.4](changelog/1.1.x/1.1.4.md) — 2026-09-23 · 🛡️ Security

Push-capable tools now declare device_http_error and carry retryable; pixoo_compose_scene's image opacity and missing local-asset errors are fixed; pixoo_control_device no longer drops failed-setter notices; pixoo_push_image's fetch cap now holds while the body streams.

## [1.1.3](changelog/1.1.x/1.1.3.md) — 2026-09-21

Errors thrown in the tool handlers now forward their declared recovery hint to callers; invalid_color hints match what resolveColor accepts; pixoo_control_device drops two error reasons it could never emit (#8). mcp-ts-core ^0.13.2 → ^0.13.6 adds a Recovery: hint on argument rejections and key normalization for tool calls.

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
