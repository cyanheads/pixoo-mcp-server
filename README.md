<div align="center">
  <h1>@cyanheads/pixoo-mcp-server</h1>
  <p><b>Render and push styled pixel art, text, dashboards, and animations to Divoom Pixoo LED displays on your local network via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 4 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pixoo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pixoo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pixoo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pixoo-mcp-server/releases/latest/download/pixoo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pixoo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGl4b28tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pixoo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpixoo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Divoom Pixoo LED matrix displays on the local network, with the Pixoo-64 as the primary target and the 16 and 32 also supported. Render and push styled text, layered scenes, dashboards, and animations, or read and change device state. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `pixoo_display_text` | Render styled text with themes, gradients, shadows, and auto-fit, static or animated, and push it |
| `pixoo_compose_scene` | Compose layered scenes of text, icons, widgets, shapes, bitmaps, images, and sprites, static or animated |
| `pixoo_push_image` | Resize a local or https image to the LED grid and push it, an animated GIF or WebP as an animation |
| `pixoo_overlay_text` | Set or clear a device-rendered scrolling text overlay |
| `pixoo_control_device` | Read or change brightness, screen state, channel, or clock face |
| `pixoo_discover_devices` | Find Pixoo devices and their LAN IPs through Divoom's cloud discovery |
| `pixoo_design_brief` | Craft guidance for a design topic, with live device state and pre-filled next calls |

### Resources

| Resource | Description |
|:---|:---|
| `pixoo://device/status` | Live device snapshot: reachability, channel, brightness, screen state, display size |
| `pixoo://reference/themes` | Theme and palette registry |
| `pixoo://reference/icons` | Built-in icon names by category |
| `pixoo://reference/design-guide` | Long-form craft guide for the 64px display |

Tools cover the same ground for tool-only clients: `pixoo_control_device` reads the live device state, and `pixoo_design_brief` returns craft guidance, theme names, and icon names.

## Capability reference

### `pixoo_display_text` <sub>tool</sub>

- `text` as a string or an array of lines; `theme` (`midnight`, `ember`, `claude`, `ice`, `neon`, `forest`, `mono`) sets the background and default palette. `style` takes a `palette` ramp (`ember`, `ice`, `neon`, `fire`, `lavender`, `claude`, `mono`) or a custom `{ from, to }`, plus `shadow`, `outline`, and `scale` 1–8; `position` is semantic or in pixels, and `align` lines up multi-line text
- `font`: `standard` (5×7) and `compact` (3×5) draw printable ASCII plus `° ← ↑ → ↓ ▲ ▼ ♥ · …`, and any other character (`€`, `’`, a newline inside one string) as `?`, named with its code point and line index in the response `notice`; `numerals` is an 11×18 digit face for clocks and readouts that draws 0–9, space, and `: . - + / % ° ?`, and text holding any other character fails validation, naming those characters
- `layout[]` reports every fit decision as an `action` (`shrunk-to-compact` when the text fits only in the compact font, `scrolling` when the returned frames scroll, `none` otherwise), the `font` used, and whether each line's box `fits` on the panel; a single line too wide for the panel starts at x 0, cut at the right edge when it does not scroll. Single-line text falls back from the standard to the compact font unless `font` is set — never to `numerals` — and text still too wide only scrolls under `effect: "auto"` or `"scroll"`
- `effect`: `scroll` makes one pass in up to 40 frames, `auto` scrolls only on overflow, and `float` and `pulse` loop over 20 frames; `frames` reports the count, and the animation pushes as one device animation

---

### `pixoo_compose_scene` <sub>tool</sub>

- Up to 50 `elements` drawn back-to-front: `text` (in the same three fonts as `pixoo_display_text`), `icon`, `rect`, `circle`, `line`, `progress`, `sparkline`, `bitmap`, `pixels`, `image` (absolute path or https URL, with the same `finish` as `pixoo_push_image`), `sprite` (absolute path). The `background` is a solid color, a `v` / `h` / `r` gradient, or a `theme`
- Every element takes `opacity` (each pixel lands at its own alpha × `opacity`, so soft edges fade evenly) and `blend`: `normal`, `add` (glows and light beams), `screen`, or `multiply`. `line` and outline `circle` take `strokeWidth` and `antialias`, and a `rect` border takes `strokeWidth`, growing inward; either field on a shape that draws no stroke fails validation, naming it
- Returns `layout[]`: each element's placed box — for a wide or anti-aliased stroke, every pixel it draws — and whether it `fits` on the panel. Elements are placed as given and never refit, so `action` is always `none`. An absolute `output` path saves the first frame as a PNG in place of the `PIXOO_OUTPUT_DIR` auto-save. Typed failures: `asset_not_found`, `invalid_image` (an image or sprite that was read but does not decode), `invalid_color`, `unknown_icon`, `invalid_output_path`
- Animation through per-element `effect` presets (`float`, `scroll-left`, `scroll-right`, `pulse`, `blink`, `twinkle`, `drift`, `fade-in`, `fade-out`) or raw `animate` keyframes over `dx`, `dy`, `opacity` (numbers or numeric strings), `visible` (`true`/`false`), and `color` (interpolated through RGB on any element with a `color`), each track holding at least one keyframe; `frames` 1–40, `speed` 10–2000 ms per frame (default 150). An element takes `effect` or `animate`, not both. An effect's `amplitude` sets the movement of `float`, `scroll-*`, and `drift`, and the 0–1 depth of the `pulse` and `twinkle` opacity dip

---

### `pixoo_push_image` <sub>tool</sub>

- `source` is an absolute local path or an https URL, with downloads capped at 10 MB; `fit` is `contain` (default), `cover`, or `fill`, and `kernel` is `nearest` (default, for pixel art), `lanczos3` (photos), or `mitchell`
- A source that decodes as an animated GIF or WebP, whatever its file name, pushes as an animation of up to 40 frames, sampled evenly from a longer source. It plays at the source's total duration over the pushed frame count (150 ms when the source records no delays), or at `speed` (10–2000 ms per frame); `frames`, `sourceFrames`, and `speed` report what was pushed
- `finish` reduces the image to a palette before the push: exactly one of `colors` (2–256, built from the image) or `palette` (1–256 hex or named colors), plus `dither` (`none`, `bayer4`, `floyd-steinberg`). Transparent pixels stay unlit, and an animation's `colors` palette is shared by every frame
- An unreadable path or URL fails as `asset_not_found`, a source that is read but does not decode (a text file, an HTML page, a truncated download) fails as `invalid_image`, and an unresolvable `finish` palette entry fails as `invalid_color`; the preview is the exact frame the device receives, or a grid of every frame for an animation

---

### `pixoo_overlay_text` <sub>tool</sub>

- `mode: "set"` or `"clear"` on one of 20 slots (`id` 0–19). `set` requires `text` and takes a device `font` ID (0–114), `x` / `y` within `PIXOO_SIZE`, `color`, `speed` (0–100), `direction`, `align`, and `width`
- Returns `acknowledged`, `mode`, and `id`. The device renders the overlay, so there is no preview, and it persists across channel switches until cleared

---

### `pixoo_control_device` <sub>tool</sub>

- No params reads state; any of `brightness` (0–100), `screen` (`on` / `off`), `channel` (`faces` / `cloud` / `visualizer` / `custom`), or `clockFaceId` is applied before the read-back
- Returns `reachable`, `channel`, `brightness`, `screenOn`, and `clockId` (absent when unreachable) plus `applied`; a failed setting is left out of `applied` and named in the notice instead of failing the call

---

### `pixoo_discover_devices` <sub>tool</sub>

- Queries Divoom's cloud endpoint (`app.divoom-gz.com`), so it needs internet access; `timeoutMs` 1000–30000 (default 5000)
- Returns each device's `name`, `id`, and `ip`; with `PIXOO_IP` set, `configuredIpFound` says whether it matched. An unreachable endpoint fails as `discovery_failed`

---

### `pixoo_design_brief` <sub>tool</sub>

- `topic`: `text`, `scene`, `dashboard`, `animation`, `pixel-art`, or `troubleshooting`; works without a reachable device
- Returns markdown `craftGuidance`, a live `deviceContext`, `nextToolSuggestions` as `{ toolName, reason, args }` with arguments pre-filled for the topic and device state, plus `availableThemes` and `iconCategories`

---

### `pixoo://device/status` <sub>resource</sub>

- Uncached live read: `reachable`, `channel`, `brightness`, `screenOn`, `clockId`, `displaySize`, `configuredIp`
- Returns `reachable: false` rather than an error when the device can't be reached or `PIXOO_IP` is unset

---

### `pixoo://reference/themes` <sub>resource</sub>

- Every theme (background, `textPalette`, `accent`, `shadow`) and palette (`from` / `to` stops), plus `themeNames` and `paletteNames` for the `theme` and `palette` parameters
- Static registry, cached for 24h

---

### `pixoo://reference/icons` <sub>resource</sub>

- Each icon's `name`, `category`, and `viewBox`, plus a `byCategory` grouping (weather, arrows, status, media); a `name` goes in a `pixoo_compose_scene` icon element
- Static registry, cached for 24h

---

### `pixoo://reference/design-guide` <sub>resource</sub>

- `text/markdown`: legibility floors, palette discipline, layout zones, animation budget, effect presets, pixel art rules, push pacing, and known device behaviors
- The whole guide in one document, where `pixoo_design_brief` returns guidance per topic; cached for 24h

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Pixoo-specific:

- All composition happens on the host in an RGBA canvas pipeline (`@cyanheads/pixoo-toolkit`); the device receives finished RGB frames
- Pushes switch the device to the custom channel and run one at a time, spaced by `PIXOO_PUSH_MIN_INTERVAL_MS` (default 1000) so rapid pushes don't freeze the device
- Animations cap at 40 frames, past which the device becomes unstable; `pixoo_push_image` samples a longer GIF or WebP down to 40

Agent-friendly output:

- Preview on every render: `pixoo_display_text`, `pixoo_compose_scene`, and `pixoo_push_image` return the frame as an 8× upscaled PNG image block, pushed or not, so `push: false` checks a design with no device attached. Animations preview as a grid of every frame, since GIF display varies across MCP clients; the GIF itself is saved to `PIXOO_OUTPUT_DIR` when set
- Layout transparency: `layout[]` reports every renderer decision (font fallback, scrolling, and whether each box fits on the panel) so agents can refine a design
- Device truth: `pushed` reflects the device ACK, and the `deviceState` read back after a push comes with a notice naming the fix when the render won't be visible (screen off, brightness ≤ 10, off the custom channel)
- Renders survive failed pushes: the typed error (`device_unreachable`, `device_http_error`, `device_rejected`, `no_device_configured`) carries `outputFiles` pointing at the saved preview (the `PIXOO_OUTPUT_DIR` copy, or a temp file when that is unset)

## Getting started

Add the following to your MCP client configuration file, with `PIXOO_IP` set to your Pixoo's LAN address. `pixoo_discover_devices` finds it if you don't know it.

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
- A Divoom Pixoo on the local network (Pixoo-64, Pixoo-32, or Pixoo-16).

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

| Variable | Description | Default |
|:---|:---|:---|
| `PIXOO_IP` | Device IP on the local network. **Required** for pushes, overlays, and device control; discovery, design briefs, and `push: false` renders work without it. | — |
| `PIXOO_SIZE` | Display size in pixels: `16`, `32`, or `64`. | `64` |
| `PIXOO_OUTPUT_DIR` | Directory where render tools save preview PNG and GIF files. A relative path resolves against the directory the server was launched from, so the saved paths it reports are absolute. Unset, previews are returned only in the response. | — |
| `PIXOO_PUSH_MIN_INTERVAL_MS` | Minimum gap between device pushes, in ms. | `1000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. A value set here overrides the server's declared `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/pixoo-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resources and initializes the Pixoo service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`), the shared post-render push path, and the shared `finish` input schema. |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/pixoo/` | `PixooService`: wraps `@cyanheads/pixoo-toolkit` with push pacing, result mapping, and device state reads. |
| `src/renderer/` | Pure rendering pipeline with no device dependency: element renderers, styled-text engine, themes, icons, effect compiler, palette finishing, preview encoding, remote image fetch. |
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
