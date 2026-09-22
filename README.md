<div align="center">
  <h1>@cyanheads/pixoo-mcp-server</h1>
  <p><b>Render and push styled pixel art, text, dashboards, and animations to Divoom Pixoo LED displays on your local network via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 4 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pixoo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pixoo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pixoo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pixoo-mcp-server/releases/latest/download/pixoo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pixoo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGl4b28tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pixoo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpixoo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Divoom Pixoo LED matrix displays (Pixoo-64 primary; 16 and 32 also supported) on the local network. Render and push styled text, layered scenes, dashboards, and animations, or control device state, from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:-----|:------------|
| `pixoo_display_text` | Render styled text (theme, gradient, shadow, outline, auto-fit) onto the display and push it. Returns the rendered frame as an image. |
| `pixoo_compose_scene` | Compose a full scene: layered elements (text, icons, widgets, shapes, bitmaps, images, sprites) with per-element effects and keyframes, static or animated. Returns the rendered scene as an image. |
| `pixoo_push_image` | Load an image (absolute local path or https URL), resize it to the LED grid, and push it. Returns the downsampled result as an image. |
| `pixoo_overlay_text` | Set or clear a device-native scrolling text overlay. Uses device-rendered fonts; overlays persist across channel switches until cleared. |
| `pixoo_control_device` | Read or change device state: brightness, screen on/off, channel, or clock face. Call with no params for a status read. |
| `pixoo_discover_devices` | Find Pixoo devices on the local network via Divoom's cloud discovery endpoint. Run once during setup to find device IPs. |
| `pixoo_design_brief` | Return craft guidance and live device context for a design topic. Covers legibility rules, palette discipline, layout zones, animation budget, and pre-filled next-tool suggestions. |

### Resources

| Resource | Description |
|:---|:---|
| `pixoo://device/status` | Live snapshot of the connected Pixoo display: reachable, channel, brightness, screen state, and display size |
| `pixoo://reference/themes` | Theme and palette registry with background gradients, default text palettes, accent colors, and swatch values |
| `pixoo://reference/icons` | Built-in icon names organized by category (weather, arrows, status, media) |
| `pixoo://reference/design-guide` | Long-form 64px craft guide: legibility floors, palette discipline, layout zones, animation budget, and known device behaviors |

All resource data is also reachable via tools. `pixoo_design_brief` surfaces the design guide content per topic; `pixoo_control_device` returns live device state equivalent to `pixoo://device/status`.

## Capability reference

### `pixoo_display_text` <sub>tool</sub>

- Named scene themes set background gradient and default text palette in one parameter (`midnight`, `ember`, `claude`, `ice`, `neon`, `forest`, `mono`)
- Style block: palette ramps (`ember`, `ice`, `neon`, `fire`, `lavender`, `claude`, `mono`) or a custom gradient/flat color, optional drop shadow, 1px outline, integer scale 1–8
- Semantic positioning (`x: "center"`, `y: "bottom"`) or absolute pixel coordinates; multi-line text stacks vertically with configurable alignment
- Auto-fit overflow tries standard font, then compact, then scroll; every fit decision is reported in `layout[]` with an `action` (`shrunk-to-compact`, `scrolling`, `wrapped`, `truncated`, `clipped`)
- Optional `brightness` (0–100) applied before push — a failure is a warning via an enrichment notice, not a tool error
- Returns the rendered frame as an image content block; `outputFiles` is populated only when `PIXOO_OUTPUT_DIR` is configured

---

### `pixoo_compose_scene` <sub>tool</sub>

- Up to 50 layered elements rendered back-to-front: `text`, `icon`, `rect`, `circle`, `line`, `progress`, `sparkline`, `bitmap`, `pixels`, `image`, `sprite`
- Background: solid color, gradient (vertical, horizontal, or radial), or named theme
- Animation via named effect presets (`float`, `scroll-left`, `scroll-right`, `pulse`, `blink`, `twinkle`, `drift`, `fade-in`, `fade-out`) or raw per-property keyframe arrays — 1–40 frames at 10–2000ms per frame (default 150ms)
- `image` and `sprite` elements accept an absolute local path or an https URL; a supplied `output` path must be absolute with no traversal segments
- Static scenes return a PNG preview; animations return a labeled contact-sheet PNG plus a saved GIF (GIF preview is inconsistent across MCP clients)
- Typed failures for `asset_not_found`, `invalid_color`, and `unknown_icon`, alongside the shared device-error reasons

---

### `pixoo_push_image` <sub>tool</sub>

- Accepts an absolute local file path or an https (not http) URL
- Three fit modes: `contain` (letterbox), `cover` (crop to fill), `fill` (stretch)
- Three resize kernels: `nearest` for pixel art (default), `lanczos3` for photos, `mitchell` for a balance
- Returns the exact resized result as an image content block before it is pushed

---

### `pixoo_overlay_text` <sub>tool</sub>

- `mode: "set"` adds or updates an overlay on one of 20 independent slots (`id` 0–19); `mode: "clear"` removes it
- 115 device-rendered font IDs (0–114); overlays persist across channel switches until explicitly cleared
- Configurable `x`/`y` (0–64), scroll `direction` (`left`/`right`), `speed` (0–100), and `align`; color is `#RRGGBB` hex only — named colors aren't supported here
- Device-rendered, not previewable — for styled, previewable text use `pixoo_display_text`

---

### `pixoo_control_device` <sub>tool</sub>

- Call with no params to read state only; supply any of `brightness` (0–100), `screen` (`on`/`off`), `channel` (`faces`/`cloud`/`visualizer`/`custom`), or `clockFaceId` to apply changes before the read-back
- `applied` lists which requested settings succeeded; a failed setting is omitted from `applied` and reported via an enrichment notice instead of failing the call
- Always returns current `reachable`, `channel`, `brightness`, `screenOn`, and `clockId` (the latter three absent when the device is unreachable)

---

### `pixoo_discover_devices` <sub>tool</sub>

- Queries Divoom's cloud discovery endpoint (`app.divoom-gz.com`) — requires internet access even for local device control
- Returns each device's name, numeric ID, and LAN IP to set as `PIXOO_IP`
- When `PIXOO_IP` is already configured, flags whether it matches a discovered device (`configuredIpFound`) and notes a mismatch
- `timeoutMs` configurable 1000–30000ms (default 5000ms)

---

### `pixoo_design_brief` <sub>tool</sub>

- Six topics: `text`, `scene`, `dashboard`, `animation`, `pixel-art`, `troubleshooting`
- Returns markdown craft guidance (legibility floors, palette discipline, layout zones, animation budgets) plus a live `deviceContext` snapshot
- `nextToolSuggestions` are pre-filled with ready-to-use arguments tailored to the topic and current device state (e.g. suggests `pixoo_discover_devices` when the device is unreachable)
- Also returns `availableThemes` and `iconCategories` for direct use in other tools

---

### `pixoo://device/status` <sub>resource</sub>

- Live snapshot: `reachable`, `channel`, `brightness`, `screenOn`, `clockId`, `displaySize`, `configuredIp`
- No cache — every read reaches the device; degrades to `reachable: false` instead of erroring when the device is unreachable
- Equivalent to calling `pixoo_control_device` with no params

---

### `pixoo://reference/themes` <sub>resource</sub>

- Every registered theme (background gradient or solid, default text palette, accent color, shadow flag) and every named palette (gradient stop pair)
- `themeNames` / `paletteNames` arrays for direct use in the `theme` / `palette` parameters
- Compile-time constants — cached for 24h

---

### `pixoo://reference/icons` <sub>resource</sub>

- Every built-in icon name, its category, and its SVG `viewBox`, plus a `byCategory` grouping (weather, arrows, status, media)
- Use a `name` from this registry in `pixoo_compose_scene` icon elements
- Compile-time constants — cached for 24h

---

### `pixoo://reference/design-guide` <sub>resource</sub>

- Long-form markdown: legibility floors, palette discipline, layout zones (top/middle/bottom strip pixel ranges), animation budget, pixel art rules, and known device behaviors (e.g. channel must be `custom` to show pushed content)
- `text/markdown` mime type; compile-time constant, cached for 24h
- Same content `pixoo_design_brief` surfaces per topic — this resource is the complete reference in one document

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Pixoo-specific:

- Requires a Divoom Pixoo LED matrix display on the local network; primary target is the Pixoo-64 (16 and 32 also supported)
- All composition happens in an RGBA canvas pipeline on the host (`@cyanheads/pixoo-toolkit`) — the device receives final RGB frames, never raw drawing commands
- Styled text engine: gradient palette ramps, drop shadows, outlines, integer scale, semantic alignment — no manual pixel math or bitmap letterforms required
- Push pacing: device commands serialized with a configurable minimum inter-push interval (default 1000ms) to prevent device freezes
- Animation capped at 40 frames (device instability beyond this); contact-sheet PNG preview for animations (GIF preview is inconsistent across MCP clients)

Agent-friendly output:

- Preview-as-content — render tools return the upscaled (8×, 512px) output as an image content block, so the calling model sees exactly what was drawn, before and after push
- Layout transparency — every silent renderer decision (font fallback, truncation, scroll engaged, element clipped) is reported in `layout[]` so agents can inspect and refine
- Device truth — `pushed` reflects the device ACK; `deviceState` after a push flags visibility issues (screen off, brightness ≤ 10, wrong channel) as enrichment notices rather than failures
- Graceful degradation — render succeeds and returns the preview even when the device is unreachable, so the agent keeps its work

## Getting started

Add the following to your MCP client configuration file. Run `pixoo_discover_devices` to find your Pixoo's IP, then set `PIXOO_IP` below.

```json
{
  "mcpServers": {
    "pixoo-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/pixoo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "PIXOO_IP": "192.168.1.50"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "pixoo-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/pixoo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "PIXOO_IP": "192.168.1.50"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "pixoo-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "PIXOO_IP=192.168.1.50",
        "ghcr.io/cyanheads/pixoo-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 PIXOO_IP=192.168.1.50 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A Divoom Pixoo LED matrix display on the local network (Pixoo-64, Pixoo-32, or Pixoo-16). Discovery tools and pure-render tools (`push: false`) work without a configured device.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/pixoo-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd pixoo-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set PIXOO_IP
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `PIXOO_IP` | Device IP address on the local network. **Required for device tools** (`pixoo_display_text`, `pixoo_compose_scene`, `pixoo_push_image`, `pixoo_overlay_text`, `pixoo_control_device`). Discovery and pure-render (`push: false`) work without it. | — |
| `PIXOO_SIZE` | Display size in pixels: `16`, `32`, or `64`. | `64` |
| `PIXOO_OUTPUT_DIR` | Directory for auto-saving preview PNG and GIF files. When unset, previews are returned in-response only. | — |
| `PIXOO_PUSH_MIN_INTERVAL_MS` | Minimum interval between device pushes in milliseconds. Prevents device freeze from rapid-fire commands. | `1000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto` (the framework's schema default, which resolves to `stateful`). The server declares `stateless` in source — no tool requests input mid-call — and a value set here overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t pixoo-mcp-server .
docker run --rm -e PIXOO_IP=192.168.1.50 -p 3010:3010 pixoo-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/pixoo-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and initializes the Pixoo service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/pixoo/` | `PixooService` — wraps `@cyanheads/pixoo-toolkit`, handles pacing, result mapping, and device state. |
| `src/renderer/` | Pure rendering pipeline: element renderers, styled-text engine, themes, icons, effect compiler, preview encoding. No device dependency. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- The renderer (`src/renderer/`) is pure — no device dependency, testable without hardware
- All device calls go through `PixooService`; every `PixooResult` is checked — never assume a push succeeded

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
