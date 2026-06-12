# pixoo-mcp-server — Design

Ground-up redesign of the Pixoo MCP server on `@cyanheads/mcp-ts-core`, with `@cyanheads/pixoo-toolkit` `^0.6.0` as the device/rendering layer. The prior generation (now archived as `pixoo-mcp-server-archive`) proved the declarative compose model but left all visual craft to the calling agent — hand-drawn bitmap letterforms for styled text, manual centering math, palette discipline carried in prompts — and never checked device results, so `pushed: true` meant "I tried."

**North star: end-result quality.** Every design choice optimizes for what actually shows on the 64×64 LED matrix — legible, deliberately styled, colored, animated when it helps. Three pillars:

1. **See what you ship.** Render tools return the rendered output as an image content block in the tool response. The model looks at its own render, immediately, every time — the render → inspect → refine loop is native, not an act of faith about a PNG on disk.
2. **The server carries the craft.** Styled text (gradients, shadows, outlines), semantic layout (`x: "center"`), themes/palettes, icons, dashboard widgets, and animation presets are server capabilities. Agents describe intent; the server knows how to make it look good at 64px.
3. **Truth in, truth out.** Every device call checks its `PixooResult`. `pushed: true` means the device acknowledged `error_code: 0`. Failures map to a typed error contract with recovery guidance.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `pixoo_display_text` | The 80% case: render styled text (theme, gradient, shadow, outline, auto-fit) and push it. Returns the render as an image. | `text`, `theme`/`style`, `font`, `position`, `effect`, `push`, `brightness?` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_compose_scene` | Full scene composition: layered elements (styled text, icons, widgets, shapes, bitmaps, images, sprites) with per-element effects/keyframes, static or animated. Returns the render as an image. | `background`, `elements[]`, `frames`, `speed`, `push` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_push_image` | Load an image (local path or https URL), resize for the LED grid, push. Returns the downsampled render as an image. | `source`, `fit`, `kernel`, `push` | `idempotentHint: true, destructiveHint: false, openWorldHint: true` (URL fetch) |
| `pixoo_overlay_text` | Device-native scrolling text overlay (`Draw/SendHttpText`) — persists over any channel content until cleared. Not previewable (device-rendered). | `mode` (set/clear), `id`, `text`, `font`, `color`, `speed` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_control_device` | Read or change device state: brightness, screen on/off, channel, clock face. No params = status read. | `brightness?`, `screen?`, `channel?`, `clockFaceId?` | `idempotentHint: true` |
| `pixoo_discover_devices` | Find Pixoo devices on the LAN (via Divoom's cloud discovery endpoint — needs internet). Setup utility. | `timeoutMs?` | `readOnlyHint: true, openWorldHint: true` |
| `pixoo_design_brief` | Instruction tool: craft guidance for a topic (text, scene, dashboard, animation, pixel-art, troubleshooting) merged with live device state, with pre-filled next-tool suggestions. | `topic` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `pixoo://device/status` | Live device snapshot: reachable, channel, brightness, screen, size | No |
| `pixoo://reference/themes` | Theme + palette registry with swatch values | No |
| `pixoo://reference/icons` | Built-in icon names by category | No |
| `pixoo://reference/design-guide` | Long-form 64px craft guide (legibility, palette discipline, layout zones, animation budget) | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `pixoo_scene_director` | Walks the model through designing a scene: theme → layout zones → elements → motion budget → `pixoo_compose_scene` call | `subject`, `mood?`, `animate?` |

Prompt is optional scope — build last, defer if the surface lands without it.

## Overview

Local-network MCP server for Divoom Pixoo LED matrix displays (16/32/64; primary target Pixoo-64). The server is the source of truth for rendering — all composition happens in an RGBA canvas pipeline (pixoo-toolkit) on the host, with the device receiving final RGB frames over its local HTTP API. No external APIs besides the device itself and Divoom's optional cloud discovery endpoint.

Audience: agents producing display-quality output — status dashboards, ambient scenes, pixel art, notifications, stylized messages — and verifying the result visually before/after it hits the physical display.

## Requirements

- Device communication exclusively through `@cyanheads/pixoo-toolkit` `^0.6.0` (`PixooClient`, RGBA `Canvas`, fonts, SVG paths, gradients, image loading, PNG/GIF encoding). No wrapper interface around the toolkit client — it is the abstraction.
- Every `PixooResult` checked. No fire-and-forget device calls anywhere in the codebase.
- Render tools return preview images in the tool response (see Output design). Previews also auto-save to `PIXOO_OUTPUT_DIR` when configured.
- Push pacing: device tolerates ~1 push/sec and freezes after ~300 rapid pushes — the service serializes device commands with a minimum inter-push interval (default 1000ms).
- Animations capped at 40 frames (device instability beyond), enforced in schema.
- `sharp` dependency (image loading) → local stdio/HTTP transports only; Cloudflare Workers is not a target.
- Display identity: `createApp()` `name` and `title` are both `pixoo-mcp-server`.

## The design system (what makes output good)

This is the heart of the redesign. The archived server's compose tool was a thin pass-through to canvas primitives; producing good output required the agent to know pixel-craft (hand-drawn block letterforms for thick text, centering formulas, palette discipline, shading rules). That knowledge now lives server-side:

### Styled text engine

`text` elements (and `pixoo_display_text`) accept a `style` block instead of just a color:

- **`palette`** — named gradient presets applied as vertical color ramps across the glyph rows (the hand-built trick that made text look designed, now automatic): `ember` (gold→deep orange), `ice` (white→blue), `neon` (green→blue), `fire` (yellow→red), `lavender` (white→lavender), `claude` (warm orange ramp), `mono` (single color). Custom: `{ from, to }` color stops.
- **`shadow`** — drop shadow, auto-offset +1/+1, color derived from the background (dark-tinted, never pure black) or explicit.
- **`outline`** — 1px contrasting rim for legibility against low-contrast backgrounds.
- **`scale`** — integer multiplier; scale ≥2 produces the chunky block-letter weight.
- **Auto-fit** — `overflow: 'auto' | 'shrink' | 'scroll' | 'wrap' | 'truncate'`. Auto tries 5×7 → 3×5 → scroll effect; every fit decision is reported in the output (`layout[]`), never silent.
- Tight proportional metrics, `letterSpacing`, `measureText`-driven alignment come from the toolkit.

### Semantic layout

Every positioned element accepts `x: int | 'left' | 'center' | 'right'` and `y: int | 'top' | 'center' | 'bottom'`, plus optional `dx`/`dy` nudge offsets. Centering math (`(64 - chars×scale)/2`) is dead.

### Themes and palettes

Named scene themes set a background gradient + default text style + accent palette in one word: `midnight`, `ember`, `claude`, `ice`, `neon`, `forest`, `mono`. Registry lives in `src/renderer/themes.ts`, surfaced via `pixoo://reference/themes` and `pixoo_design_brief`. Color values resolve through the toolkit's strict `resolveColor` (typos throw → `InvalidParams` listing valid names — never silently wrong colors).

### Element vocabulary (`pixoo_compose_scene`)

Discriminated union, rendered back-to-front:

| Type | What it adds over the archive | Backed by |
|:-----|:------------------------------|:----------|
| `text` | Full styled text engine (above) | toolkit fonts + ramp renderer |
| `icon` | Built-in named icons or custom SVG path. `name` values live in the icon registry, listed at `pixoo://reference/icons` (categories: weather, arrows, status, media); custom icons pass `{ d, viewBox }` where `viewBox` defaults to `"0 0 16 16"` (toolkit default — pass `"0 0 24 24"` for lucide-style sources); fill color/palette | `renderSvgPath` (even-odd fill, holes, Béziers) |
| `rect` | `gradient` fill option, optional `borderColor` | `fillRect`/`drawRect`/`gradientV/H` |
| `circle` | unchanged | `fillCircle`/`drawCircle` |
| `line` | unchanged | `drawLine` |
| `progress` | Dashboard widget: value/max bar, gradient fill, track color, optional label | rects + text engine |
| `sparkline` | Dashboard widget: `data[]` → mini line or bar chart, auto-scaled to its box | `drawLine`/rects |
| `bitmap` | unchanged (palette indices + row strings — proven for custom art) | `setPixel` |
| `pixels` | unchanged (sparse dots: stars, particles) | `setPixel` |
| `image` | local path or https URL (URL sources are fetched to a temp file server-side — `loadImage` accepts local paths only) | `loadImage` (alpha-preserving) |
| `sprite` | unchanged (sprite-sheet downsample + recolor) | `downsampleSprite`/`renderSprite` |

Per-element: `visible`, `opacity` (0–100, composited via scratch canvas + alpha blend — the RGBA canvas makes true layering work; black pixels land, undrawn stays transparent), and motion (below).

### Motion: presets first, keyframes for control

- **`effect`** — named animation presets compiled to keyframes server-side: `float` (gentle y bob), `scroll-left`/`scroll-right`, `pulse` (color ramp), `blink`, `twinkle` (sparse color wobble for `pixels`), `drift` (slow x wander), `fade-in`/`fade-out` (opacity ramp). Each takes minimal params (amplitude, period).
- **`animate`** — raw `{ prop: [[frame, value], ...] }` keyframes, kept from the archive (numbers lerp, colors lerp through RGB, booleans snap; hold before first/after last). One of `effect` or `animate` per element.
- Scene-level `frames` (1–40, default 1) and `speed` (ms/frame, default 150). 20×150 ≈ 3s loop is the documented sweet spot.

## Tool detail

### `pixoo_display_text`

Carved out of compose because it's the dominant ask ("show X on the display") and deserves a zero-thought quality path. Input: `text` (string or lines array), `theme?`, `background?` (color | gradient — overrides theme), `style?` (palette/shadow/outline/scale), `font?`, `position?`, `align?`, `effect?` (`none | auto | scroll | float | pulse`; `auto` = scroll only when text overflows), `push` (default true), `brightness?` (convenience — applied before the push; a brightness failure surfaces as an enrichment warning and does not block the render or push). Output: image content block of the render, `layout[]` fit report (font/scale chosen, overflow action taken), `pushed` (device-acknowledged), `deviceState` post-push, `outputFiles?`.

### `pixoo_compose_scene`

Input: `background` (color | `{ gradient }` | `{ theme }`), `elements[]` (vocabulary above), `frames`, `speed`, `push` (default true), `output?` (explicit save path). Pipeline: validate → preload async assets once (images, sprites) → render frames (pure) → encode preview → push if requested (ensure Custom channel, paced) → read back device state. Output: preview image block (static: single PNG; animation: labeled contact-sheet PNG of up to 5 frames + GIF saved to disk with path returned), `frames`, `layout[]`, `pushed`, `deviceState`, `outputFiles`.

### `pixoo_push_image`

Input: `source` (absolute path or https URL), `fit` (`contain | cover | fill`), `kernel` (`nearest | lanczos3 | mitchell` — nearest for pixel art, lanczos3 for photos), `push`. URL sources require a service-layer step: fetch to a temp file, pass the path to `loadImage`, clean up after render — the toolkit accepts local paths only. Output: preview image block of the actual 64×64 result (the agent sees exactly what downsampling did), `pushed`, `deviceState`.

### `pixoo_overlay_text`

Kept narrow and honest: device-rendered marquee text (115 built-in device fonts addressed by opaque ID), overlays persist across channel switches until cleared, cannot be previewed. Useful for tickers over pushed scenes and long scrolling text without burning animation frames. Input: `mode` (`set | clear`), `id` (0–19), `text`, `x`, `y`, `font` (0–114; 0 default, 18 arrows, 20 °C/°F), `color`, `speed`, `direction` (`left | right` → device `dir` `0 | 1`), `align` (`left | center | right` → device `1 | 2 | 3`), `width?`. String enums in the schema; the service maps to the device integer codes. Output: device-acknowledged action. Description warns about persistence + non-previewability and points to `pixoo_display_text` for styled text.

### `pixoo_control_device`

All params optional; bare call = status read. `channel` is a string enum `faces | cloud | visualizer | custom`, mapped at the service boundary to the toolkit's `Channel` numeric enum (0–3). Channel state read via `getChannel()` (reliable `SelectIndex`) — **not** `getConfig()`, whose `SelectIndex` is absent on current Pixoo-64 firmware (a live bug in the archived server, which reported `unknown(undefined)`). Output: `reachable`, `brightness`, `channel`, `screenOn`, `clockId?`, `applied[]`.

### `pixoo_discover_devices`

Wraps `PixooClient.discover()` (POST to Divoom's cloud — documented egress, throws → `discovery_failed`). Output: `devices[] { name, id, ip }`, `configuredIp` match flag, recovery hint when empty ("check the device is on the same LAN / set PIXOO_IP manually").

### `pixoo_design_brief`

Instruction tool: static craft content per `topic` (`text | scene | dashboard | animation | pixel-art | troubleshooting`) merged with live diagnostics (display size from config, reachable, channel, brightness, screen) and `nextToolSuggestions` with pre-filled args (e.g. troubleshooting + screen off → `pixoo_control_device { screen: "on" }`). The craft content is the distillation of what previously lived in per-task prompts: legibility floors (1px features vanish at viewing distance; eyes ≥1–2px; limb gaps ≥2 rows), palette discipline (4–6 colors, value contrast over hue contrast, warm whites `#f0ead6` over pure white), layout zones, motion budget (one hero motion + ≤2 ambient effects), parallax speeds.

## Error contract

| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `device_unreachable` | `ServiceUnavailable` | toolkit result kind `network`/`timeout` | yes |
| `device_http_error` | `ServiceUnavailable` | kind `http` — non-2xx from the device's HTTP server (busy, rebooting) | yes |
| `device_rejected` | `ServiceUnavailable` | kind `device` — firmware returned non-zero `error_code`; message includes the device code | no |
| `no_device_configured` | `InvalidParams` | device tool called without `PIXOO_IP` — recovery: run `pixoo_discover_devices` | no |
| `asset_not_found` | `NotFound` | image/sprite path or URL unreadable | no |
| `invalid_color` | `InvalidParams` | strict `resolveColor` throw — the toolkit's message names the offending value and accepted formats; the server appends the valid color names (from `NAMED_COLORS`) and points to `pixoo://reference/themes` for palettes | no |
| `unknown_icon` | `InvalidParams` | icon name not in registry — message lists categories | no |
| `discovery_failed` | `ServiceUnavailable` | Divoom cloud unreachable | yes |

Text overflow is **not** an error — it's a reported fit decision in `layout[]`. Validation failures (frame cap, malformed keyframes) bubble as standard `ValidationError`.

## Output design

- **Preview-as-content is the contract.** Render tools put the upscaled render (scale 8 → 512px PNG, legible to vision models) in `content[]` as an image block alongside the markdown summary; `structuredContent` carries the data twin (minus raw image bytes — it gets `outputFiles` paths and the layout report). Animations: contact-sheet PNG (first/¼/½/¾/last frames, labeled) in content + full GIF written to disk.
- `pushed` reflects the device ACK, never intent. When `push: false`, output says so plainly (`pushed: false`, preview returned).
- `deviceState` after any push: `{ channel, brightness, screenOn }` — with enrichment notices when the render won't be visible: screen off, brightness ≤ 10, wrong channel after a failed switch.
- `layout[]` communicates every silent decision the renderer made (font fallback, truncation, scroll engaged, element clipped at canvas edge). Entry shape:

  ```ts
  {
    element: number | 'background',   // index into elements[]; display_text uses 0
    type: string,                     // element type ('text', 'icon', ...)
    box: { x, y, w, h },              // resolved bounding box after layout
    fits: boolean,
    action: 'none' | 'shrunk-to-compact' | 'scrolling' | 'wrapped' | 'truncated' | 'clipped',
    font?: 'standard' | 'compact',    // text only — the font actually used
    scale?: number                    // text only — the scale actually used
  }
  ```

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `PixooService` | toolkit `PixooClient` — init from config (lazy; absent `PIXOO_IP` only fails device tools), command serialization + min-interval pacing, `ensureCustomChannel()` (switch + verify via `getChannel`), result→error-contract mapping, status snapshot | all device-touching tools, status resource |

Rendering is pure — `src/renderer/` is a plain module (no DI ceremony): element renderers, styled-text engine, layout resolver, theme/palette registry, icon registry (curated SVG path data), effect compiler (presets → keyframes), keyframe interpolation, preview encoding (PNG/contact-sheet/GIF). Independently unit-testable without a device.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `PIXOO_IP` | For device tools | Device IP on the local network. Discovery + pure-render (`push: false`) work without it. |
| `PIXOO_SIZE` | No (default `64`) | `16 \| 32 \| 64` |
| `PIXOO_OUTPUT_DIR` | No | Auto-save directory for preview PNG/GIF files |
| `PIXOO_PUSH_MIN_INTERVAL_MS` | No (default `1000`) | Pacing floor between device pushes |

`src/config/server-config.ts`, own Zod schema.

## Workflow analysis — `pixoo_compose_scene` push path

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 1 | preload assets (`loadImage`/`downsampleSprite`) | once per element, before frame loop | elements present |
| 2 | render frames + encode previews | pure, no device | always |
| 3 | `getChannel()` | skip switch if already Custom | `push` |
| 4 | `setChannel(Custom)` + verify | content must be on Custom to display | `push` ∧ not already |
| 5 | `push()` / `pushAnimation()` | paced; result checked | `push` |
| 6 | `getChannel()` + `getConfig()` | post-state for response — channel from `getChannel()` only, `getConfig()` solely for brightness/screen (its `SelectIndex` is absent on current firmware) | `push` |

Failure at 4–5 → typed error with the preview still attached (the agent keeps the render even when the device is down). Step 6 failures degrade to a warning, never tank the call.

## Implementation order

1. Config + `PixooService` (pacing, result mapping, status)
2. Renderer core: layout resolver, themes, styled-text engine, keyframes + effect compiler, preview encoding
3. `pixoo_display_text` (exercises the whole quality path end-to-end)
4. `pixoo_compose_scene` (element vocabulary, widgets, icons)
5. `pixoo_push_image`, `pixoo_control_device`, `pixoo_overlay_text`, `pixoo_discover_devices`
6. `pixoo_design_brief` + resources
7. Prompt (optional)

Each step independently testable; renderer tests need no device.

## Design Decisions

- **Previews return as image content, not just file paths.** The archived server saved PNGs the model never looked at. Vision-capable models reviewing their own render is the single biggest quality lever available; file paths remain for humans and downstream use.
- **`pixoo_display_text` exists despite `pixoo_compose_scene` covering it.** The 80% ask gets a surface where quality is the default and the schema is small. Compose remains the power tool.
- **Styled text replaces hand-drawn letterforms.** The archive's best text output required authoring bitmap letterform rows in JSON (a documented internal technique). The gradient-ramp + shadow + outline engine produces the same result from `{ palette: "ember", shadow: true }`.
- **`destructiveHint: false` on push tools.** Pushing replaces ephemeral display content the agent itself produced; nothing unrecoverable is lost. Pacing protects the hardware. (The archive marked these destructive — friction without protection.)
- **Device overlay text kept but de-emphasized.** It's the only persistent-marquee capability and costs nothing to keep; the description routes styled-text asks to `pixoo_display_text`.
- **Effects compile to keyframes** rather than a second animation engine — presets are sugar, the interpolator (ported concept from the archive: lerp numbers, lerp colors, snap booleans) stays the single source of motion truth.
- **Contact sheet over inline GIF** for animation previews — MCP image-block support for GIF is inconsistent across clients; a labeled PNG strip is universally visible, the real GIF goes to disk.
- **No DataCanvas, no mirror, no app tools** — nothing here is analytical row data, and the human-facing surface is the physical display itself.

## Known Limitations

- ≤40 animation frames; ~1 push/sec pacing; ~5s device "Loading.." overlay when a new animation starts.
- Device text overlays (`pixoo_overlay_text`) render on-device: no preview possible, and they persist invisibly across channel switches until cleared.
- `getConfig()` field availability varies by firmware (Pixoo-64 omits `SelectIndex`) — channel reads go through `getChannel()`.
- Discovery requires internet (Divoom cloud endpoint) even though device control is fully local.
- No dithering on image downsampling (kernel choice only) — possible future toolkit addition.
- Local transports only (`sharp` won't run on Workers).

## Examples (target schemas, for build reference)

The archive's best-saved composition ("Hello from Claude", stylized) required ~150 lines: two hand-drawn letterform bitmaps + manual shadow copies + manual centering. Target equivalent:

```json
{
  "background": { "theme": "midnight" },
  "frames": 20,
  "elements": [
    { "type": "text", "text": "HELLO", "y": 0, "x": "center",
      "style": { "palette": "lavender", "shadow": true, "scale": 2 },
      "effect": { "name": "float", "amplitude": 2 } },
    { "type": "text", "text": "from", "y": 11, "x": "center", "color": "#9890B0" },
    { "type": "text", "text": "CLAUDE", "y": 18, "x": "center",
      "style": { "palette": "claude", "shadow": true, "scale": 2 },
      "effect": { "name": "float", "amplitude": 2, "phase": 0.5 } },
    { "type": "sprite", "path": "assets/clawd.png", "cols": 10, "rows": 8,
      "scale": 4, "x": "center", "y": 30, "bodyColor": "#E69646",
      "effect": { "name": "float", "amplitude": 3 } },
    { "type": "pixels", "data": [ { "x": 2, "y": 28, "color": "gold" } ],
      "effect": { "name": "twinkle" } }
  ]
}
```

Status dashboard (static):

```json
{
  "background": { "gradient": { "type": "v", "from": "#0a1020", "to": "#000000" } },
  "elements": [
    { "type": "text", "text": "BUILD", "x": 2, "y": 2, "style": { "palette": "ice" } },
    { "type": "icon", "name": "check-circle", "x": "right", "dx": -2, "y": 2, "color": "green" },
    { "type": "progress", "x": 2, "y": 14, "w": 60, "h": 5, "value": 87, "max": 100,
      "palette": "neon", "label": "87%" },
    { "type": "sparkline", "x": 2, "y": 26, "w": 60, "h": 14, "data": [3,5,4,8,7,9,12],
      "color": "claude" },
    { "type": "text", "text": "12 min ago", "x": "center", "y": 56, "font": "compact",
      "color": "#8090a0" }
  ]
}
```
