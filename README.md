<div align="center">
  <h1>pixoo-mcp-server</h1>
  <p><b>MCP server for pushing visual content to Divoom Pixoo RGB LED matrix displays (16x16, 32x32, 64x64) over the local network.</b>
  <div>4 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--11--25-8A2BE2.svg?style=flat-square)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/changelog.mdx) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun->=1.2.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Overview

Push pixel art, images, animations, and text to Divoom Pixoo displays directly from any MCP client (Claude Code, etc.). No auth required — the server communicates with the device via plain HTTP POST on the local network.

Built on [`@cyanheads/pixoo-toolkit`](https://github.com/cyanheads/pixoo-toolkit) and [`mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template).

## Tools

| Tool                   | Description                                                                                                               |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **`pixoo_compose`**    | Compose a scene from layered elements (text, images, sprites, shapes, pixel art) and push to device — static or animated. |
| **`pixoo_push_image`** | Load a single image file, resize to display grid, push.                                                                   |
| **`pixoo_text`**       | Push native on-device scrolling text via hardware rendering.                                                              |
| **`pixoo_control`**    | Read or change device settings (brightness, screen, channel, clock face).                                                 |

## Getting Started

### MCP Client Configuration

```json
{
  "mcpServers": {
    "pixoo-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["pixoo-mcp-server@latest"],
      "env": {
        "PIXOO_IP": "192.168.1.100",
        "PIXOO_SIZE": "64",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher
- A Divoom Pixoo device on the same local network

### Installation

```sh
git clone https://github.com/cyanheads/pixoo-mcp-server.git
cd pixoo-mcp-server
bun install
```

### Configuration

Copy `.env.example` to `.env` and set your device IP:

```sh
cp .env.example .env
```

| Variable             | Description                                         | Default        |
| :------------------- | :-------------------------------------------------- | :------------- |
| **`PIXOO_IP`**       | IP address of the Pixoo device on the local network | **(required)** |
| `PIXOO_SIZE`         | Display resolution: `16`, `32`, or `64`             | `64`           |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`                        | `stdio`        |
| `MCP_HTTP_PORT`      | HTTP server port                                    | `3010`         |
| `MCP_LOG_LEVEL`      | Log level (`debug`, `info`, `warn`, `error`)        | `debug`        |

### Running

```sh
# Development (watch mode)
bun run dev:stdio
bun run dev:http

# Production (build first)
bun run rebuild
bun run start:stdio
bun run start:http
```

### Development

```sh
bun run devcheck    # Lint, format, typecheck, security audit
bun run test        # Run tests
```

## Tool Details

### `pixoo_compose`

The primary tool. Compose a scene from layered elements and push to the device.

```json
{
  "background": "black",
  "elements": [
    { "type": "rect", "x": 0, "y": 0, "w": 64, "h": 20, "color": "#1a1a2e" },
    {
      "type": "text",
      "text": "Hello!",
      "x": 0,
      "y": 6,
      "color": "white",
      "font": "standard",
      "centered": true
    },
    {
      "type": "bitmap",
      "x": 28,
      "y": 40,
      "scale": 2,
      "palette": ["", "#ff4488", "#cc2266"],
      "data": ["0120210", "1111111", "1111111", "0111110", "0011100", "0001000"]
    }
  ]
}
```

**Element types:** `text`, `image`, `sprite`, `rect`, `circle`, `line`, `bitmap`, `pixels`

**Animation:** Set `frames` > 1 and add `animate` keyframes to elements:

```json
{
  "frames": 10,
  "speed": 150,
  "elements": [
    {
      "type": "text",
      "text": "Hello",
      "x": 0,
      "y": 2,
      "color": "#ffffff",
      "centered": true,
      "animate": {
        "color": [
          [0, "#ffffff"],
          [5, "#ff8800"],
          [9, "#ffffff"]
        ]
      }
    }
  ]
}
```

See [docs/pixoo-mcp-server.md](docs/pixoo-mcp-server.md) for full element and animation documentation.

### `pixoo_push_image`

Shortcut to load and push a single image file.

```json
{ "path": "/path/to/image.png", "fit": "contain", "kernel": "nearest" }
```

### `pixoo_text`

Native on-device scrolling text with hardware rendering.

```json
{ "text": "Hello World", "color": "#00ff00", "speed": 50, "direction": "left" }
```

### `pixoo_control`

Read or change device settings. Call with no parameters to read current config.

```json
{ "brightness": 75, "channel": "custom" }
```

## Device Quirks

- **~1 push/sec recommended** — device may freeze after ~300 rapid pushes
- **Channel must be `custom`** to display pushed content — compose/push_image auto-switch
- **Text overlays persist** across channel switches — use `clear: true` to remove
- **Max ~40 animation frames** for stability
- **~5s "Loading.." overlay** when a new animation starts

## References

- [Divoom API Docs](http://doc.divoom-gz.com/web/#/12?page_id=220)
- [pixoo-toolkit](https://github.com/cyanheads/pixoo-toolkit) — `@cyanheads/pixoo-toolkit`
- [mcp-ts-template](https://github.com/cyanheads/mcp-ts-template) — server foundation
- [Device Font List](https://app.divoom-gz.com/Device/GetTimeDialFontList)

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

---

<div align="center">
  <b>Maintained by <a href="https://github.com/cyanheads">@cyanheads</a></b>
</div>
