# Pixoo Display MCP Server

**Status**: Idea
**Project Name**: `pixoo-mcp-server`
**Priority**: Medium | **Difficulty**: Medium

## Overview

MCP server for pushing visual content to Divoom Pixoo RGB LED matrix displays (16x16, 32x32, 64x64) over the local network. No auth — plain HTTP POST to `http://<device-ip>/post`. User provides `PIXOO_IP` env var. Optional `PIXOO_SIZE` env var sets display resolution (default: `64`).

**Dependencies**: [`@cyanheads/pixoo-toolkit`](https://github.com/cyanheads/pixoo-toolkit)

---

## Tools

### `pixoo_compose`

The primary tool. Compose a scene from layered elements and push to the device — static or animated. Automatically switches the device to the custom channel before pushing.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `background` | string | No | Fill color for the canvas before drawing elements. Default: `"black"` |
| `elements` | array | Yes | Ordered list of elements to draw (back-to-front). See element types below. |
| `frames` | number | No | Frame count for animation (1 = static, default). When >1, elements can use `animate` keyframes. |
| `speed` | number | No | Animation frame duration in ms. Default: `150` |
| `push` | boolean | No | Push to device. Default: `true`. Set `false` to only save a preview PNG. |
| `output` | string | No | Absolute path to save a preview PNG. If omitted, no preview is saved. |

**Element types** (each element has a `type` field):

| Type | Description | Key Fields |
|---|---|---|
| `text` | Bitmap font text | `text`, `x`, `y`, `color`, `font` (`standard`/`compact`), `scale`, `centered` |
| `image` | Load and place an image | `path`, `x`, `y`, `width`, `height`, `fit`, `kernel` |
| `sprite` | Load a sprite sheet via `downsampleSprite` | `path`, `cols`, `rows`, `x`, `y`, `scale`, `bodyColor`, `darkColor` |
| `rect` | Filled or stroked rectangle | `x`, `y`, `w`, `h`, `color`, `fill` (default: true) |
| `circle` | Filled or stroked circle | `cx`, `cy`, `radius`, `color`, `fill` (default: true) |
| `line` | Arbitrary line | `x0`, `y0`, `x1`, `y1`, `color` |
| `bitmap` | Inline pixel art grid | `x`, `y`, `palette`, `data` (row strings of palette indices) |
| `pixels` | Batch pixel set | `data` (array of `{ x, y, color }`) |

Common fields on all element types:

| Field | Type | Description |
|---|---|---|
| `visible` | boolean | Default `true`. Set `false` to skip rendering (useful with animation keyframes). |

**`image` element fields:**

| Field | Type | Description |
|---|---|---|
| `path` | string | Absolute path to image file (PNG, JPEG, WebP, GIF, AVIF, TIFF, SVG) |
| `x`, `y` | number | Top-left placement on canvas. Default: `0, 0` |
| `width`, `height` | number | Target dimensions. Defaults to canvas size. |
| `fit` | enum | `contain` (default), `cover`, `fill` |
| `kernel` | enum | `nearest` (default, pixel art), `lanczos3` (photos), `mitchell` (balanced) |

**`bitmap` element fields:**

Compact inline pixel art. Define a palette of colors, then draw rows as strings where each character is a palette index. `""` (empty string) in the palette = transparent.

| Field | Type | Description |
|---|---|---|
| `x`, `y` | number | Top-left placement on canvas. Default: `0, 0` |
| `palette` | string[] | Color palette. Index 0 = first char in row strings. `""` = transparent. |
| `data` | string[] | Row strings. Each character is a palette index (`0`–`9`, `a`–`z` for 10+). |
| `scale` | number | Pixel scale multiplier. Default: `1`. Set `2` to render each bitmap pixel as 2×2, etc. |

```json
{
  "type": "bitmap",
  "x": 28, "y": 40, "scale": 2,
  "palette": ["", "#ff4488", "#cc2266"],
  "data": [
    "0120210",
    "1111111",
    "1111111",
    "0111110",
    "0011100",
    "0001000"
  ]
}
```

Supports up to 36 palette entries (0–9, a–z). For most use cases 2–4 colors suffice.

**Animation**: When `frames` > 1, elements can include an `animate` object to tween properties across frames. Each animated property is defined as keyframes — an array of `[frame, value]` pairs. The server interpolates between keyframes linearly for numeric values; non-numeric values (colors, booleans) snap at the keyframe.

```json
{
  "background": "black",
  "frames": 10,
  "speed": 150,
  "elements": [
    {
      "type": "sprite",
      "path": "assets/clawd.png",
      "cols": 10, "rows": 8, "scale": 4,
      "x": 7, "y": 24,
      "animate": {
        "y": [[0, 24], [4, 22], [6, 25], [8, 24]]
      }
    },
    {
      "type": "text",
      "text": "Hello",
      "x": 0, "y": 2, "color": "#ffffff",
      "font": "standard", "centered": true,
      "animate": {
        "color": [[0, "#ffffff"], [5, "#ff8800"], [9, "#ffffff"]]
      }
    }
  ]
}
```

Keyframe `[0, 24]` means "at frame 0, value is 24". Between keyframes, numeric values are linearly interpolated. First keyframe's value is held for all prior frames; last keyframe's value is held through the end.

Maps to: `Canvas` primitives, `drawText`/`drawTextCentered`, `loadImage`, `downsampleSprite`/`renderSprite`, `buildAnimation`, `PixooClient.push()`/`pushAnimation()`.

### `pixoo_push_image`

Shortcut: load a single image file, resize to display grid (`PIXOO_SIZE`, default 64), push. Automatically switches the device to the custom channel before pushing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Absolute path to image file (PNG, JPEG, WebP, GIF, AVIF, TIFF, SVG) |
| `fit` | enum | No | `contain` (default), `cover`, `fill` |
| `kernel` | enum | No | `nearest` (default, pixel art), `lanczos3` (photos), `mitchell` (balanced) |

### `pixoo_text`

Push native on-device scrolling text via `Draw/SendHttpText`. Renders using the device's built-in fonts with smooth hardware scrolling — no frame encoding needed. Overlays on top of the current display content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | Yes | Text string to display |
| `id` | number | No | Text overlay ID (0–19). Default: `0`. Use different IDs to stack multiple text overlays. |
| `x`, `y` | number | No | Position. Default: `0, 0` |
| `direction` | enum | No | Scroll direction: `left` (default), `right` |
| `font` | number | No | Device font ID (0–114). Default: `0`. Notable: 18 = arrow glyphs, 20 = °C/°F symbols. |
| `width` | number | No | Scrolling area width in pixels. Default: display size. |
| `speed` | number | No | Scroll speed (higher = faster). Default: `50` |
| `color` | string | No | Text color (hex or named). Default: `"white"` |
| `align` | enum | No | `left` (default), `center`, `right` |
| `clear` | boolean | No | If `true`, clears the text overlay at the given `id` instead of setting it. |

Maps to: `Draw/SendHttpText`, `Draw/ClearHttpText`.

### `pixoo_control`

Read or change device settings. Call with no parameters to read current config.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `brightness` | number | No | 0–100 |
| `screen` | enum | No | `on` or `off` |
| `channel` | enum | No | `faces`, `cloud`, `visualizer`, `custom` |
| `clock_face_id` | number | No | Clock face ID (only on `faces` channel) |

Returns current config (brightness, channel, screen state, display size) regardless of whether changes were made.

---

## Device Quirks

- **GIF ID reset required** before each push — `PixooClient.push()` handles this
- **~1 push/sec recommended** — device freezes after ~300 rapid pushes
- **Channel must be `custom`** (index 3) to display pushed content — `pixoo_compose` and `pixoo_push_image` auto-switch
- **`Draw/CommandList` cannot batch `Draw/SendHttpGif`**
- **Text overlays persist** — they render on top of any channel and survive channel switches. Call `pixoo_text` with `clear: true` to remove.

---

## References

- [Divoom API Docs](http://doc.divoom-gz.com/web/#/12?page_id=220)
- [pixoo-toolkit](https://github.com/cyanheads/pixoo-toolkit) — `@cyanheads/pixoo-toolkit`
- [mcp-ts-template](https://github.com/cyanheads/mcp-ts-template)
- [Device Font List](https://app.divoom-gz.com/Device/GetTimeDialFontList) — JSON list of all 115 built-in fonts
- [Font Visual Preview](http://dial.divoom-gz.com/dial.php/index.html)

---

**Maintained by**: [@cyanheads](https://github.com/cyanheads)
**Last Updated**: 2026-02-21
