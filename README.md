<div align="center">
  <h1>@cyanheads/pixoo-mcp-server</h1>
  <p><b>Render and push styled pixel art, text, dashboards, and animations to Divoom Pixoo LED displays on your local network via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 4 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pixoo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pixoo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pixoo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pixoo-mcp-server/releases/latest/download/pixoo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pixoo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGl4b28tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pixoo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpixoo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools covering the full display pipeline — from quick styled text to full layered scene composition, device control, and initial setup:

| Tool | Description |
|:-----|:------------|
| `pixoo_display_text` | Render styled text (theme, gradient, shadow, outline, auto-fit) onto the display and push it. Returns the rendered frame as an image. |
| `pixoo_compose_scene` | Compose a full scene: layered elements (text, icons, widgets, shapes, bitmaps, images, sprites) with per-element effects and keyframes, static or animated. Returns the rendered scene as an image. |
| `pixoo_push_image` | Load an image (absolute local path or https URL), resize it to the LED grid, and push it. Returns the downsampled result as an image. |
| `pixoo_overlay_text` | Set or clear a device-native scrolling text overlay. Uses device-rendered fonts; overlays persist across channel switches until cleared. |
| `pixoo_control_device` | Read or change device state: brightness, screen on/off, channel, or clock face. Call with no params for a status read. |
| `pixoo_discover_devices` | Find Pixoo devices on the local network via Divoom's cloud discovery endpoint. Run once during setup to find device IPs. |
| `pixoo_design_brief` | Return craft guidance and live device context for a design topic. Covers legibility rules, palette discipline, layout zones, animation budget, and pre-filled next-tool suggestions. |

### `pixoo_display_text`

The primary tool for text-only display. Covers the 80% case — styled text with quality defaults.

- Named scene themes set background gradient and text palette in one parameter (`midnight`, `ember`, `claude`, `ice`, `neon`, `forest`, `mono`)
- Style block: gradient palette ramps (`ember`, `ice`, `neon`, `fire`, `lavender`, `claude`, `mono`), drop shadow, 1px outline for legibility, integer scale multiplier for block-letter weight
- Semantic positioning: `x: "center"`, `y: "bottom"` — no manual pixel math
- Auto-fit overflow: tries 5×7 → 3×5 → scroll; every fit decision reported in `layout[]`
- Returns the rendered frame as an image content block so you see it immediately
- Optional brightness convenience parameter applied before push

---

### `pixoo_compose_scene`

Full scene composition with the complete element vocabulary.

- Layered elements rendered back-to-front: `text`, `icon`, `rect`, `circle`, `line`, `progress`, `sparkline`, `bitmap`, `pixels`, `image`, `sprite`
- Named icons from the built-in registry (weather, arrows, status, media) or custom SVG path
- Dashboard widgets: `progress` bar with gradient fill and optional label; `sparkline` mini chart (line or bar, auto-scaled)
- Animation: named effect presets (`float`, `scroll-left`, `scroll-right`, `pulse`, `blink`, `twinkle`, `drift`, `fade-in`, `fade-out`) or raw keyframe arrays — 1–40 frames, configurable speed
- Per-element opacity and `visible` flag; images at https URLs fetched server-side to a temp file
- Returns a preview image (static: PNG; animated: labeled contact-sheet PNG + GIF saved to disk)

---

### `pixoo_push_image`

Push any image to the display with control over the downsampling.

- Accepts absolute local paths and https URLs
- Three fit modes: `contain` (letterbox), `cover` (crop to fill), `fill` (stretch)
- Three resize kernels: `nearest` for pixel art, `lanczos3` for photos, `mitchell` for a balance
- Returns the exact 64×64 result as an image block — you see what the display received

---

### `pixoo_overlay_text`

Device-native scrolling text overlay — persists across channel switches.

- 115 device-rendered font IDs (0–114)
- Up to 20 independent overlay slots (IDs 0–19)
- Configurable scroll direction, speed, and alignment
- Clears with `mode: "clear"` — overlays survive channel changes until explicitly removed
- Not previewable (device-rendered); for styled previewable text use `pixoo_display_text`

---

### `pixoo_design_brief`

The orientation tool. Run before authoring any scene to get grounded in 64px craft constraints.

- Six topics: `text`, `scene`, `dashboard`, `animation`, `pixel-art`, `troubleshooting`
- Returns legibility floors, palette discipline, layout zones, animation budgets, and common pitfalls
- Merges live device state (reachable, channel, brightness, screen) into the response
- Pre-filled `nextToolSuggestions` with ready-to-use arguments based on current device state

---

## Resources

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `pixoo://device/status` | Live snapshot of the connected Pixoo display: reachable, channel, brightness, screen state, and display size |
| Resource | `pixoo://reference/themes` | Theme and palette registry with background gradients, default text palettes, accent colors, and swatch values |
| Resource | `pixoo://reference/icons` | Built-in icon names organized by category (weather, arrows, status, media) |
| Resource | `pixoo://reference/design-guide` | Long-form 64px craft guide: legibility floors, palette discipline, layout zones, animation budget, and known device behaviors |

All resource data is also reachable via tools. `pixoo_design_brief` surfaces the design guide content per topic; `pixoo_control_device` returns live device state equivalent to `pixoo://device/status`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Pixoo-specific:

- Requires a Divoom Pixoo LED matrix display on the local network; primary target is the Pixoo-64 (16 and 32 also supported)
- All composition happens in an RGBA canvas pipeline on the host (`@cyanheads/pixoo-toolkit`) — the device receives final RGB frames, never raw drawing commands
- Styled text engine: gradient palette ramps, drop shadows, outlines, integer scale, semantic alignment — no manual pixel math or bitmap letterforms required
- Push pacing: device commands serialized with a configurable minimum inter-push interval (default 1000ms) to prevent device freezes
- Every `PixooResult` checked — `pushed: true` means the device acknowledged with `error_code: 0`, never "I tried"
- Animation capped at 40 frames (device instability beyond this); contact-sheet PNG preview for animations (GIF inconsistent across MCP clients)
- Local transports only — `sharp` image processing doesn't run on Cloudflare Workers

Agent-friendly output:

- **Preview-as-content**: render tools return the upscaled (8×, 512px) output as an image content block — the calling model sees exactly what was drawn, before and after push
- **Layout transparency**: every silent renderer decision (font fallback, truncation, scroll engaged, element clipped) reported in `layout[]` so agents can inspect and refine
- **Device truth**: `pushed` reflects the device ACK; `deviceState` post-push flags visibility issues (screen off, brightness ≤ 10, wrong channel) as enrichment notices rather than failures
- **Graceful degradation**: render succeeds and returns the preview even when the device is unreachable — the agent keeps its work

## Getting started

**Requirements:** A Divoom Pixoo display (Pixoo-64, Pixoo-32, or Pixoo-16) on the same local network as the server. Run `pixoo_discover_devices` to find its IP, then set `PIXOO_IP` in your server configuration.

Add the following to your MCP client configuration file:

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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
| `PIXOO_IP` | Device IP address on the local network. Required for device tools (`pixoo_display_text`, `pixoo_compose_scene`, `pixoo_push_image`, `pixoo_overlay_text`, `pixoo_control_device`). Discovery and pure-render (`push: false`) work without it. | — |
| `PIXOO_SIZE` | Display size in pixels: `16`, `32`, or `64`. | `64` |
| `PIXOO_OUTPUT_DIR` | Directory for auto-saving preview PNG and GIF files. When unset, previews are returned in-response only. | — |
| `PIXOO_PUSH_MIN_INTERVAL_MS` | Minimum interval between device pushes in milliseconds. Prevents device freeze from rapid-fire commands. | `1000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
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

| Path | Purpose |
|:-----|:--------|
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
- All device calls go through `PixooService`; every `PixooResult` is checked

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
