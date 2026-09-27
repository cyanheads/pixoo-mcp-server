<div align="center">
  <h1>@cyanheads/pixoo-mcp-server</h1>
  <p><b>Render and push styled pixel art, text, dashboards, and animations to Divoom Pixoo LED displays on your local network via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 4 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pixoo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pixoo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pixoo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pixoo-mcp-server/releases/latest/download/pixoo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pixoo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGl4b28tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pixoo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpixoo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Divoom Pixoo LED matrix displays on the local network, with the Pixoo-64 as the primary target and the 16 and 32 also supported. Render and push styled text, layered scenes, dashboards, animations, and HTML pages, or read and change device state. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `pixoo_display_text` | Render styled text with themes, gradients, shadows, and auto-fit, static or animated, and push it |
| `pixoo_compose_scene` | Compose layered scenes of text, icons, widgets, shapes, bitmaps, images, and sprites, static or animated |
| `pixoo_push_image` | Resize a local or https image to the LED grid and push it, an animated GIF or WebP as an animation |
| `pixoo_render_html` | Render an HTML page (CSS, SVG, Canvas, WebGL) in a headless browser at the panel size, still or animated frame by frame on a virtual clock, and push it |
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
- Animation through per-element `effect` presets (`float`, `scroll-left`, `scroll-right`, `pulse`, `blink`, `twinkle`, `drift`, `fade-in`, `fade-out`) or raw `animate` keyframes over `dx`, `dy`, `opacity` (numbers or numeric strings), `visible` (`true`/`false`), and `color` (interpolated through RGB on any element with a `color`), each track holding at least one keyframe; `frames` 1–800, `speed` 10–2000 ms per frame (default 150). Past 40 frames the scene plays as one GIF the device downloads from this host, with `speed` rounded to 10 ms. An element takes `effect` or `animate`, not both. An effect's `amplitude` sets the movement of `float`, `scroll-*`, and `drift`, and the 0–1 depth of the `pulse` and `twinkle` opacity dip

---

### `pixoo_push_image` <sub>tool</sub>

- `source` is an absolute local path or an https URL, with downloads capped at 10 MB; `fit` is `contain` (default), `cover`, or `fill`, and `kernel` is `nearest` (default, for pixel art), `lanczos3` (photos), or `mitchell`
- A source that decodes as an animated GIF or WebP, whatever its file name, pushes as an animation of up to `maxFrames` frames (1–800, default 40), sampled evenly from a longer source; past 40 frames it plays as one GIF the device downloads from this host. It plays at the source's total duration over the pushed frame count (150 ms when the source records no delays), or at `speed` (10–2000 ms per frame); `frames`, `sourceFrames`, and `speed` report what was pushed
- `finish` reduces the image to a palette before the push: exactly one of `colors` (2–256, built from the image) or `palette` (1–256 hex or named colors), plus `dither` (`none`, `bayer4`, `floyd-steinberg`). Transparent pixels stay unlit, and an animation's `colors` palette is shared by every frame
- An unreadable path or URL fails as `asset_not_found`, a source that is read but does not decode (a text file, an HTML page, a truncated download) fails as `invalid_image`, and an unresolvable `finish` palette entry fails as `invalid_color`; the preview is the exact frame the device receives, or a grid of an animation's frames

---

### `pixoo_render_html` <sub>tool</sub>

- `html` is a full document or a body fragment, up to 500,000 characters, laid out in a square viewport one CSS pixel per LED. The page is the panel: `body` has no margin, scrollbars are hidden, and a page that paints no background renders on black (unlit). Its own CSS overrides each
- `frames` 1–800 (default 1), `speed` 10–2000 ms per frame (default 150). Each frame advances a virtual clock by `speed`: `window.render(t, frame)`, when the page defines it, runs before each capture with `t = frame / frames`, so periodic motion loops seamlessly; `requestAnimationFrame`, `setTimeout` / `setInterval` (4 ms floor for nested and repeating timers), `Date` (starting at the real time), and `performance.now()` (0 at load) follow the same clock, and CSS animations are paused and seeked to it, so every frame is deterministic. `requestIdleCallback` and iframes keep real time. Past 40 frames the page plays as one GIF the device downloads from this host, as on `pixoo_compose_scene`
- `sampling`: `native` (default) or `supersample`, which renders at 8× and area-averages into each LED, smoothing transforms, text, SVG, and canvas. Chromium snaps a plain box's edges to whole CSS pixels before scaling, so a box at `left: 0.5px` still lands on one LED; move it with `transform` for sub-pixel motion. `finish` takes the same palette reduction as `pixoo_push_image`, applied before the preview
- Nothing loads from the network and workers are blocked. `pageErrors` returns the page's uncaught errors, `console.error` output, and blocked URLs (a blocked navigation as `Blocked navigation: <url>`): the first 20, each cut to 500 characters. A `window.render` that throws or rejects fails as `page_error`, naming the frame; with no browser found, the call fails as `browser_unavailable` with install steps (see [Prerequisites](#prerequisites)); `render_timeout` and `render_crashed` cover a render past 30 s and a crashed browser or page. `PIXOO_HTML_ENABLED=false` removes the tool
- Every page gets a `pixoo` global before its own scripts run, for the crisp bitmap text, palettes, and icons that browser anti-aliasing would smear across LEDs:
  - `pixoo.context()` is the 2D context of a transparent panel-size canvas fixed over the page.
  - `pixoo.text(ctx, text, x, y, { font, color, palette, scale, shadow, outline })` draws `pixoo_display_text`'s fonts.
  - `pixoo.icon(ctx, name, x, y, { w, h, color, palette })` draws a registry icon.
  - `pixoo.palettes` holds the 7 palettes, and `pixoo.size` is the panel size.

  Text and icons drawn this way match `pixoo_compose_scene` pixel for pixel in both sampling modes. An unknown palette, icon, or color throws naming it:

  ```html
  <script>
    const ctx = pixoo.context();
    pixoo.text(ctx, 'HELLO', 'center', 4, { palette: 'ember', scale: 2, shadow: true });
    pixoo.icon(ctx, 'check-circle', 50, 50, { color: 'green' });
  </script>
  ```

- `pixoo_design_brief` with topic `html` covers loops, the clock, sampling, the `pixoo` runtime, and legibility at 64 px. A dot orbiting the panel once per loop:

```json
{
  "html": "<svg viewBox=\"0 0 64 64\" style=\"display:block;width:100vw;height:100vh\"><circle id=\"dot\" r=\"6\" fill=\"#ffb000\"/></svg><script>const dot = document.getElementById('dot'); window.render = (t) => { const a = 2 * Math.PI * t; dot.setAttribute('cx', 32 + 20 * Math.cos(a)); dot.setAttribute('cy', 32 + 20 * Math.sin(a)); };</script>",
  "frames": 20,
  "speed": 100,
  "sampling": "supersample"
}
```

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

- `topic`: `text`, `scene`, `dashboard`, `animation`, `pixel-art`, `html`, or `troubleshooting`; works without a reachable device
- Returns markdown `craftGuidance`, a live `deviceContext`, `htmlRenderer` (`available`, `disabled` when `PIXOO_HTML_ENABLED=false`, or `no_browser`, found without launching a browser), `nextToolSuggestions` as `{ toolName, reason, args }` with arguments pre-filled for the topic and device state, plus `availableThemes` and `iconCategories`

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
- Up to 40 animation frames push one request each; more frame pushes make the device unstable. Past 40, `pixoo_compose_scene`, `pixoo_push_image`, and `pixoo_render_html` (up to 800 frames) serve one GIF from a one-shot listener on this host, which the device downloads and loops, so the device must be able to reach this host. `pixoo_display_text` stays within 40

Agent-friendly output:

- Preview on every render: `pixoo_display_text`, `pixoo_compose_scene`, `pixoo_push_image`, and `pixoo_render_html` return the frame as an 8× upscaled PNG image block, pushed or not, so `push: false` checks a design with no device attached. Animations preview as a grid of their frames (every frame while 1× tiles fit the 512 px sheet, an even sample past that), since GIF display varies across MCP clients; the GIF itself is saved to `PIXOO_OUTPUT_DIR` when set — an 8× preview GIF, or past 40 frames the panel-size GIF the device downloads
- Layout transparency: `layout[]` reports every renderer decision (font fallback, scrolling, and whether each box fits on the panel) so agents can refine a design
- Device truth: `pushed` reflects the device ACK (past 40 frames, the ACK of the play plus the device's request for the GIF, with the whole file handed to the OS to send; the device does not confirm receipt), and the `deviceState` read back after a push comes with a notice naming the fix when the render won't be visible (screen off, brightness ≤ 10, off the custom channel)
- Renders survive failed pushes: on all four render tools, the typed error (`device_unreachable`, `device_http_error`, `device_rejected`, `gif_serve_failed`, `no_device_configured`) carries `outputFiles` pointing at the saved preview (the `PIXOO_OUTPUT_DIR` copy, or a temp file when that is unset)

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
        "-e", "PIXOO_SERVE_HOST=192.168.1.20",
        "-e", "PIXOO_SERVE_PORT=8765",
        "-p", "8765:8765",
        "ghcr.io/cyanheads/pixoo-mcp-server:latest"
      ]
    }
  }
}
```

The device downloads an animation of more than 40 frames from this host, and on Docker's default bridge network the address routed to the device is the container's own, which the device can't reach. Set `PIXOO_SERVE_HOST` to the Docker host's LAN address and publish a fixed `PIXOO_SERVE_PORT`, as above; 40 frames or fewer need neither.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 PIXOO_IP=192.168.1.50 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A Divoom Pixoo on the local network (Pixoo-64, Pixoo-32, or Pixoo-16).
- Optional, for the HTML renderer: [chrome-headless-shell](https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell). `npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer` installs it where the server looks by default. Installed anywhere else with `--path <dir>`, set `PIXOO_BROWSER_PATH` to the executable path the install prints. The server launches it headless, with no DevTools port, only when a render needs it.

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
| `PIXOO_SERVE_HOST` | Host advertised in the URL the device downloads an animation of more than 40 frames from, in place of the local address the OS routes to `PIXOO_IP`. The listener binds that routed address either way. Set it behind NAT or in a container. | — |
| `PIXOO_SERVE_PORT` | Fixed port for that download's one-shot listener, for firewall rules and container port publishing. Unset, a free port per play. | — |
| `PIXOO_BROWSER_PATH` | Browser executable for HTML rendering. When set, the only browser tried: a path that is not an executable file fails rather than falling back. A relative path resolves against the launch directory. Unset, the newest chrome-headless-shell in Puppeteer's cache (`~/.cache/puppeteer`). The Docker image ships no browser. | — |
| `PIXOO_HTML_ENABLED` | Offer `pixoo_render_html`. `false` removes it from `tools/list`; a value that is not a boolean fails startup. | `true` |
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

  # Real-browser suite for the HTML renderer (opt-in; launches the named browser)
  PIXOO_TEST_BROWSER_PATH=/path/to/chrome-headless-shell bun run test:browser
  ```

### Docker

```sh
docker build -t pixoo-mcp-server .
docker run --rm -e PIXOO_IP=192.168.1.50 -p 3010:3010 \
  -e PIXOO_SERVE_HOST=192.168.1.20 -e PIXOO_SERVE_PORT=8765 -p 8765:8765 \
  pixoo-mcp-server
```

`PIXOO_SERVE_HOST` (the Docker host's LAN address) and the published `PIXOO_SERVE_PORT` let the device download animations of more than 40 frames from inside the container, as in the stdio configuration above.

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/pixoo-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resources and initializes the Pixoo service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`), the shared post-render push path, and the shared `finish` input schema. |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/pixoo/` | `PixooService`: wraps `@cyanheads/pixoo-toolkit` with push pacing, result mapping, and device state reads. |
| `src/services/browser/` | `BrowserRenderer`: renders HTML in an isolated headless chrome-headless-shell, driven over the DevTools Protocol pipe, and captures it as a panel frame. |
| `src/renderer/` | Pure rendering pipeline with no device dependency: element renderers, styled-text engine, themes, icons, effect compiler, palette finishing, preview encoding, remote image fetch, and the virtual clock injected into HTML pages. |
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
