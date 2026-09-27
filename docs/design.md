# pixoo-mcp-server — Design

Ground-up redesign of the Pixoo MCP server on `@cyanheads/mcp-ts-core`, with `@cyanheads/pixoo-toolkit` `^0.10.0` as the device/rendering layer. The prior generation (now archived as `pixoo-mcp-server-archive`) proved the declarative compose model but left all visual craft to the calling agent — hand-drawn bitmap letterforms for styled text, manual centering math, palette discipline carried in prompts — and never checked device results, so `pushed: true` meant "I tried."

**North star: end-result quality.** Every design choice optimizes for what actually shows on the 64×64 LED matrix — legible, deliberately styled, colored, animated when it helps. Three pillars:

1. **See what you ship.** Render tools return the rendered output as an image content block in the tool response. The model looks at its own render, immediately, every time — the render → inspect → refine loop is native, not an act of faith about a PNG on disk.
2. **The server carries the craft.** Styled text (gradients, shadows, outlines), semantic layout (`x: "center"`), themes/palettes, icons, dashboard widgets, and animation presets are server capabilities. Agents describe intent; the server knows how to make it look good at 64px.
3. **Truth in, truth out.** Every device call checks its `PixooResult`. `pushed: true` means the device acknowledged `error_code: 0` (and, for an animation past 40 frames, requested the GIF, whose whole file was then handed to the OS to send). Failures map to a typed error contract with recovery guidance.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `pixoo_display_text` | The 80% case: render styled text (theme, gradient, shadow, outline, auto-fit) and push it. Returns the render as an image. | `text`, `theme`/`style`, `font`, `position`, `align`, `effect`, `push`, `brightness?` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_compose_scene` | Full scene composition: layered elements (styled text, icons, widgets, shapes, bitmaps, images, sprites) with per-element effects/keyframes, static or animated. Returns the render as an image. | `background`, `elements[]`, `frames`, `speed`, `push` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_push_image` | Load an image (absolute local path or https URL), resize for the LED grid, push — an animated GIF or WebP as an animation. Returns the downsampled render as an image. | `source`, `fit`, `kernel`, `speed?`, `maxFrames`, `finish?`, `push` | `idempotentHint: true, destructiveHint: false, openWorldHint: true` (URL fetch) |
| `pixoo_render_html` | Render an HTML page (CSS, SVG, Canvas, WebGL) in a headless browser at the panel size, frame by frame on a virtual clock, and push it. Returns the render as an image. On by default; `PIXOO_HTML_ENABLED=false` removes it. | `html`, `frames`, `speed`, `sampling`, `finish?`, `push`, `output?` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_overlay_text` | Device-native scrolling text overlay (`Draw/SendHttpText`) — persists over any channel content until cleared. Not previewable (device-rendered). | `mode` (set/clear), `id`, `text`, `font`, `color`, `speed` | `idempotentHint: true, destructiveHint: false` |
| `pixoo_control_device` | Read or change device state: brightness, screen on/off, channel, clock face. No params = status read. | `brightness?`, `screen?`, `channel?`, `clockFaceId?` | `idempotentHint: true` |
| `pixoo_discover_devices` | Find Pixoo devices on the LAN (via Divoom's cloud discovery endpoint — needs internet). Setup utility. | `timeoutMs?` | `readOnlyHint: true, openWorldHint: true` |
| `pixoo_design_brief` | Instruction tool: craft guidance for a topic (text, scene, dashboard, animation, pixel-art, html, troubleshooting) merged with live device state and whether the HTML renderer can run, with pre-filled next-tool suggestions. | `topic` | `readOnlyHint: true` |

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

Prompt is optional scope — deferred past 1.0: the 7-tool surface (with `pixoo_design_brief` covering orientation) shipped without it. Candidate for a follow-up release.

## Overview

Local-network MCP server for Divoom Pixoo LED matrix displays (16/32/64; primary target Pixoo-64). The server is the source of truth for rendering — all composition happens in an RGBA canvas pipeline (pixoo-toolkit) on the host, with the device receiving final RGB frames over its local HTTP API. No external APIs besides the device itself and Divoom's optional cloud discovery endpoint. The one inbound connection is the device's own download of an animation longer than 40 frames, from a one-shot listener on this host.

Audience: agents producing display-quality output — status dashboards, ambient scenes, pixel art, notifications, stylized messages — and verifying the result visually before/after it hits the physical display.

## Requirements

- Device communication exclusively through `@cyanheads/pixoo-toolkit` `^0.10.0` (`PixooClient`, RGBA `Canvas`, fonts, SVG paths, gradients, image loading, PNG/GIF encoding). No wrapper interface around the toolkit client — it is the abstraction.
- Every `PixooResult` checked. No fire-and-forget device calls anywhere in the codebase.
- Render tools return preview images in the tool response (see Output design). Previews also auto-save to `PIXOO_OUTPUT_DIR` when configured.
- Push pacing: device tolerates ~1 push/sec and freezes after ~300 rapid pushes — the service serializes device commands with a minimum inter-push interval (default 1000ms).
- Up to 40 animation frames push one `Draw/SendHttpGif` request each (the device turns unstable past about 40 frame pushes). Past 40, `pixoo_compose_scene` (`frames` up to 800) and `pixoo_push_image` (`maxFrames` 1–800, default 40, sampling a longer GIF or WebP evenly down to it) encode one panel-size GIF that the device downloads from a one-shot listener on this host and loops (`Device/PlayTFGif`). `pixoo_display_text` stays within 40, so its calls never need the device to reach this host.
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
- **`font`** — `standard` (the toolkit's 5×7) and `compact` (3×5) draw printable ASCII plus `° ← ↑ → ↓ ▲ ▼ ♥ · …`, and draw any other character as `?`; the render tools name each such character in their `notice` (see Output design). `numerals` (`FONT_DIGITS_11x18`) draws 11×18 digits on one 13-px advance plus space and `: . - + / % ° ?`; text in `numerals` holding any other character fails input validation (`-32602`, naming the characters) instead of drawing the face's `?`. One variant→face map (`FONT_FACES` in `src/renderer/text-engine.ts`) serves both tools.
- **Auto-fit** — single-line text tries 5×7 → 3×5; text still too wide draws from x 0, cut at the right edge, and reports `fits: false` with action `none`. `pixoo_display_text`'s `effect: "auto"` scrolls it instead, and only then reports `scrolling`. Auto-fit never selects `numerals`. An explicit `font` skips the 3×5 fallback: the text overflows, or scrolls under `auto`, in the font asked for. Every fit decision is reported in the output (`layout[]`), never silent.
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
| `icon` | Built-in named icons or custom SVG path. `name` values live in the icon registry, listed at `pixoo://reference/icons` (categories: weather, arrows, status, media); custom icons pass `{ d, viewBox }` where `viewBox` defaults to `"0 0 16 16"` (toolkit default — pass `"0 0 24 24"` for lucide-style sources); `w`/`h` 1–256 (default 12); `color` (default white), or a `palette` painted as a top-to-bottom ramp from the icon's top ink row (`from`) to its bottom ink row (`to`), the way a text palette paints glyphs — `palette` wins over `color`. Each registry icon records which parts fill and which stroke: `sun` and `rain` fill the disk/cloud and stroke the rays/drops, the arrows fill the head and stroke the shaft, `snow`, `wind`, and the four status badges (`check-circle`, `x-circle`, `alert-circle`, `info`) are all stroke; custom `d` paths fill | `renderSvgPath` — even-odd fill (holes, Béziers) for filled parts, `mode: 'stroke'` 1-px lines for stroked parts |
| `rect` | `gradient` fill option, optional `borderColor` with a `strokeWidth` border (default 1) that grows inward; the layout box stays `w × h`. `strokeWidth` without `borderColor` fails validation | `fillRect`/`drawRect`/`gradientV/H` |
| `circle` | `fill: false` outlines take `strokeWidth` (whole pixels, centered on the circle, default 1) and `antialias` (edge pixels shaded by coverage, default false); either field on a filled circle fails validation, naming it. A wide or anti-aliased ring reports a layout box covering every pixel it draws | `fillCircle`/`drawCircle` |
| `line` | `strokeWidth` (whole pixels, centered on the line, default 1) and `antialias`. A wide or anti-aliased line reports a layout box covering every pixel it draws, so `fits` sees a stroke crossing an edge | `drawLine` |
| `progress` | Dashboard widget: value/max bar, gradient fill, track color, optional label | rects + text engine |
| `sparkline` | Dashboard widget: `data[]` → mini line or bar chart, auto-scaled to its box — a line runs from the box's first column to its last and from its bottom row to its top, filling exactly `w × h` | `drawLine`/rects |
| `bitmap` | unchanged (palette indices + row strings — proven for custom art) | `setPixel` |
| `pixels` | unchanged (sparse dots: stars, particles) | `setPixel` |
| `image` | absolute local path or https URL (a URL source is downloaded into memory and its bytes passed to `loadImage`, so nothing is written to disk and it renders exactly as the same file from a local path), loaded onto a canvas of the configured display size, so an image with no `w`/`h` fits the display; `w`/`h` 1–256; `finish` (as on `pixoo_push_image`) reduces the loaded image to a palette before it is drawn, on a copy of the cached load, so elements differing only in `finish` share the decode | `loadImage` (alpha-preserving), `quantize` |
| `sprite` | unchanged (sprite-sheet downsample + recolor); `path` an absolute local path; `cols`/`rows` 1–64, `scale` 1–64 | `downsampleSprite`/`renderSprite` |

Per-element: `visible`, `opacity` (0–100), `blend`, and motion (below). An element under `opacity` below 100 or a `blend` other than `normal` draws onto its own transparent layer, which is then composited onto the scene — the RGBA canvas makes true layering work; black pixels land, undrawn stays transparent. `normal` (the default, source-over) lands each layer pixel at its own alpha × `opacity`, so an anti-aliased or soft image edge keeps its falloff as the element fades. `add` (sums the light of both, clamped — glows and light beams), `screen`, and `multiply` scale the layer's alpha by `opacity`, then composite through the toolkit's `Canvas.blit({ mode })`. A cached image canvas is only ever copied onto the layer, never changed. An element at `opacity` 100 with no `blend` draws straight onto the scene.

### Motion: presets first, keyframes for control

- **`effect`** — named animation presets compiled to keyframes server-side: `float` (gentle y bob), `scroll-left`/`scroll-right`, `pulse` (opacity breathing, 50–100 by default), `blink`, `twinkle` (irregular opacity flicker, 40–100 by default; the jitter is fixed by the frame index and the element's position in the scene, so it differs between elements and identical scenes render identical frames), `drift` (slow x wander), `fade-in`/`fade-out` (opacity ramp). Each takes minimal params (`amplitude`, `period`, `phase`). `amplitude` is movement for `float` (bob height, px), `scroll-*` (2 × amplitude px per frame), and `drift` (up to 4 × amplitude px), default 2; for `pulse` and `twinkle` it is the 0–1 depth of the opacity dip below 100, default 0.5 and 0.6; `blink` and the fades ignore it.
- **`animate`** — raw `{ prop: [[frame, value], ...] }` keyframes, kept from the archive (numbers lerp, booleans snap; hold before first/after last). Values are checked and interpolated by property: `dx`, `dy`, and `opacity` take numbers or numeric strings, and a numeric string reads as its number, so `"000"` → `"100"` ramps exactly like `0` → `100`; `visible` takes `true` or `false` and switches at the midpoint between keyframes; only the `color` track lerps through RGB, reading each value as a color and returning `#rrggbb` between keyframes. Every track needs at least one keyframe. An empty track, a value of the wrong type, or a string on `dx`/`dy`/`opacity` that isn't a number fails input validation as `invalid_arguments`, naming the field. A track under any other key fails the same way, naming it by its full path (`elements.0.animate.y`), and so does a `color` track on `bitmap`, `progress`, `image`, or `sprite`, which have no color to drive. Animatable: `dx`, `dy`, `opacity`, `visible`, and `color` on every element that has a `color` field (`text`, `icon`, `rect`, `circle`, `line`, `sparkline`, and each point of `pixels`). A keyframed `color` stands in for the static `color`, so it yields where that does — to an icon or text `palette`, a text `style.color`, a rect `gradient`. Every value in a `color` track is resolved before any frame renders, so one that isn't a color fails as `invalid_color` even when its keyframe lies past the scene's last frame. An element takes `effect` or `animate`, not both: the renderer compiles `effect` only when `animate` is absent, so an element setting both fails input validation at `elements.<i>.effect` rather than dropping the preset.
- Scene-level `frames` (1–800, default 1; past 40 the scene plays as one device-downloaded GIF, whose frame delay is `speed` rounded to 10 ms) and `speed` (ms/frame, default 150). 20×150 ≈ 3s loop is the documented sweet spot.

## Tool detail

### `pixoo_display_text`

Carved out of compose because it's the dominant ask ("show X on the display") and deserves a zero-thought quality path. Input: `text` (string or lines array), `theme?`, `background?` (color | gradient — overrides theme), `style?` (palette/shadow/outline/scale), `font?` (`standard | compact | numerals`, used as given; omitted, single-line text auto-fits and multi-line text uses 5×7), `position?`, `align?` (multi-line: lines align `left | center | right` within the widest line and `position.x` places that block; omitted, each line is placed by `position.x` on its own), `effect?` (`none | auto | scroll | float | pulse`: `scroll` runs one full scroll cycle — in from the right edge, out through the left — in at most 40 frames, speeding up rather than cutting off for long text; `auto` does the same only when the text overflows; `float`/`pulse` compile to keyframes over 20 frames, as on a scene element; animated results push via `pushAnimation` at 150ms per frame), `push` (default true), `brightness?` (convenience — applied before the push; a brightness failure surfaces as an enrichment warning and does not block the render or push). Output: image content block of the render (a contact sheet when animated), `frames`, `layout[]` fit report (font/scale chosen, overflow action taken), `pushed` (device-acknowledged), `deviceState` post-push, `outputFiles?` (PNG, or GIF when animated). Omitting `effect` and `align` renders exactly the static output the tool produced before either existed.

### `pixoo_compose_scene`

Input: `background` (a color, or an object holding exactly one of `gradient` or `theme`), `elements[]` (vocabulary above), `frames`, `speed`, `push` (default true), `output?` (explicit PNG save path for the first frame — replaces the `PIXOO_OUTPUT_DIR` auto-save for that call). Pipeline: validate → preload async assets once (images, sprites) → render frames (pure) → encode preview → push if requested (ensure Custom channel, paced) → read back device state. Output: preview image block (static: single PNG; animation: contact-sheet PNG of the frames + GIF saved to disk with path returned — the 8× preview GIF, or past 40 frames the panel-size GIF the device downloads), `frames`, `layout[]`, `pushed`, `deviceState`, `outputFiles`.

### `pixoo_push_image`

Input: `source` (absolute path or https URL; a relative path, `~` path, or `file://` URL fails input validation), `fit` (`contain | cover | fill`), `kernel` (`nearest | lanczos3 | mitchell` — nearest for pixel art, lanczos3 for photos), `speed?` (10–2000 ms per frame, animations only), `maxFrames` (1–800, default 40, animations only), `push`. A URL source is downloaded into memory (10 MB cap, declared and streamed) and its bytes passed to the loader, so nothing touches the temp dir. The fetch runs under the request's abort signal, so a cancelled call tears the download down (in compose's asset preload too). A source the decoder reports as GIF or WebP — the content decides, not the extension — loads through `loadAnimation` with the caller's `maxFrames`, which samples a longer source evenly and sums the delays each kept frame stands in for; every other format loads through `loadImage`, so a multi-page TIFF shows its first page. More than one frame pushes via `pushAnimation` at one speed: the source's total duration over the pushed frame count, rounded and clamped to 10–2000 ms, so the loop keeps its length (150 ms, the render tools' default, when every delay is 0); `speed` overrides it, and a still ignores it. The median delay was rejected: it keeps motion speed but not loop length. `finish?` reduces the loaded frames to a palette through the toolkit's `quantize` before the preview, so the preview stays exactly what the device receives: exactly one of `colors` (2–256, a palette built from the image) or `palette` (1–256 hex or named colors), plus `dither` (`none` default, `bayer4`, `floyd-steinberg`). Transparent pixels stay unlit and don't count toward `colors`. On an animation, `colors` builds one palette from every kept frame — per-frame palettes let a shifting hue ramp at `colors: 4` hold 16 colors across the loop — while `palette` and `dither` apply per frame. The schema (`src/mcp-server/tools/finish-schema.ts`) and the application (`src/renderer/finish.ts`) are tool-agnostic, shared with the scene `image` element. An unresolvable `palette` entry fails as `invalid_color` before the source is read. A source that is read but does not decode fails as `invalid_image`, naming the source as passed and the decoder's reason. Output: preview image block of the actual display-size result (the agent sees exactly what downsampling did; a contact sheet for an animation), `frames` (1 for a still), `sourceFrames`, `speed` (animations only), `pushed`, `deviceState`, `outputFiles?` (PNG, or an 8× GIF at the pushed speed for an animation, or past 40 frames the panel-size GIF the device downloads — also the file a failed push keeps). The default `maxFrames` of 40 keeps a call that omits it on the frame-push path, so only a caller that asks for more needs the device to reach this host.

### `pixoo_render_html`

Input: `html` (a full document or a body fragment, ≤ 500,000 characters), `frames` (1–800, default 1), `speed` (10–2000 ms per frame, default 150), `sampling` (`native | supersample`), `finish?` (the `pixoo_push_image` schema and application), `push` (default true), `output?` (absolute, normalized PNG path for frame 0, replacing the auto-save). Pipeline: check `output` and the `finish` palette (`invalid_output_path`, `invalid_color`, both before a browser launches) → `BrowserRenderer.withPage(pageDocument(html), { inject: pageScripts(PIXOO_SIZE, runtime), sampling })`, where `pageScripts` (`src/renderer/page-scripts.ts`) injects the virtual clock, then `globalThis.__PIXOO_SIZE__`, then the `pixoo` runtime bundle `dist/page-runtime.js` (read once; missing, the call fails `ConfigurationError` naming the file before a browser launches) → per frame, evaluate `frameStepExpression(frame, frames, speed)`, then `capture()` → `finishFrames` → contact sheet → save → push through `device-push.ts`, past 40 frames as the panel-size GIF, as `pixoo_compose_scene` does. `pageDocument` prepends `<!doctype html>` and a style block that hides every scrollbar and sets `body{margin:0}` at type-selector specificity, so the page's own rule or inline style wins. The frame step (`src/renderer/virtual-clock.ts`) fires the timers due by `frame × speed` ms, runs one `requestAnimationFrame` round, awaits `window.render(t, frame)` with `t = frame / frames`, pauses every CSS and Web Animation and seeks it to the virtual time, and paints the root `#000` when neither the root nor the body paints a background. A `render` that throws or rejects fails `page_error` naming the frame and the page's message (≤ 500 characters); a timer or animation-frame callback that throws lands in `pageErrors` and the step continues. Output: preview image block (a contact sheet for an animation), `pushed`, `frames`, `pageErrors` (the renderer's reports in arrival order — the first 20, each cut to 500 characters, with a `notice` when more arrived), `deviceState`, `outputFiles?` (PNG for a still; the 8× GIF, or past 40 frames the panel-size GIF). `PIXOO_HTML_ENABLED=false` wraps the tool in `disabledTool()`, so it leaves `tools/list`; with no browser it stays listed and fails `browser_unavailable`. `pixoo_design_brief` topic `html` carries the authoring guidance.

### `pixoo_overlay_text`

Kept narrow and honest: device-rendered marquee text (115 built-in device fonts addressed by opaque ID), overlays persist across channel switches until cleared, cannot be previewed. Useful for tickers over pushed scenes and long scrolling text without burning animation frames. Input: `mode` (`set | clear`), `id` (0–19), `text`, `x`, `y` (0 to display size − 1, checked in the handler against `PIXOO_SIZE`), `font` (0–114; 0 default, 18 arrows, 20 °C/°F), `color`, `speed`, `direction` (`left | right` → device `dir` `0 | 1`), `align` (`left | center | right` → device `1 | 2 | 3`), `width?` (0 to display size, also checked in the handler). String enums in the schema; the service maps to the device integer codes. Output: device-acknowledged action. Description warns about persistence + non-previewability and points to `pixoo_display_text` for styled text.

### `pixoo_control_device`

All params optional; bare call = status read. `channel` is a string enum `faces | cloud | visualizer | custom`, mapped at the service boundary to the toolkit's `Channel` numeric enum (0–3). Channel state read via `getChannel()` (reliable `SelectIndex`) — **not** `getConfig()`, whose `SelectIndex` is absent on current Pixoo-64 firmware (a live bug in the archived server, which reported `unknown(undefined)`). Output: `reachable`, `brightness`, `channel`, `screenOn`, `clockId?`, `applied[]`.

### `pixoo_discover_devices`

Wraps `PixooClient.discover()` (POST to Divoom's cloud — documented egress, throws → `discovery_failed`). Output: `devices[] { name, id, ip }`, `configuredIp` match flag, recovery hint when empty ("check the device is on the same LAN / set PIXOO_IP manually").

### `pixoo_design_brief`

Instruction tool: static craft content per `topic` (`text | scene | dashboard | animation | pixel-art | html | troubleshooting`) merged with live diagnostics (display size from config, reachable, channel, brightness, screen), `htmlRenderer` (`disabled` when `PIXOO_HTML_ENABLED=false`, else `available` or `no_browser` from `discoverBrowser`, which stats the executable and never launches it), and `nextToolSuggestions` entries `{ toolName, reason, args }` with pre-filled args (e.g. troubleshooting + screen off → `pixoo_control_device { screen: "on" }`; `args: {}` when the tool takes none). The craft content is the distillation of what previously lived in per-task prompts: legibility floors (1px features vanish at viewing distance; eyes ≥1–2px; limb gaps ≥2 rows), palette discipline (4–6 colors, value contrast over hue contrast, warm whites `#f0ead6` over pure white), layout zones, motion budget (one hero motion + ≤2 ambient effects), parallax speeds.

## Error contract

| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `device_unreachable` | `ServiceUnavailable` | toolkit result kind `network`/`timeout` | yes |
| `device_http_error` | `ServiceUnavailable` | kind `http` — non-2xx from the device's HTTP server (busy, rebooting, or `PIXOO_IP` answering as something other than a Pixoo) | 408, 429, 500, 502–504 only |
| `device_rejected` | `ServiceUnavailable` | kind `device` — firmware returned non-zero `error_code`; message includes the device code | no |
| `gif_serve_failed` | `ServiceUnavailable` | an animation past 40 frames could not be served: the listener could not open (no route to `PIXOO_IP`, `PIXOO_SERVE_PORT` in use) or its URL ran past 255 bytes — both before any device command — or the device did not request the GIF, or stalled or dropped the download, for 10 s; the message names the URL, and the failed push keeps the panel-size GIF as `outputFiles` | no |
| `no_device_configured` | `InvalidParams` | device tool called without `PIXOO_IP` — recovery: run `pixoo_discover_devices` | no |
| `asset_not_found` | `NotFound` | image/sprite path or URL unreadable, or a sprite path given as a URL — the message names the failure (a missing file, a non-https or unreachable URL, a download over 10 MiB, a sprite URL: sprite sheets take an absolute local path); every occurrence carries the tool's declared recovery | no |
| `invalid_image` | `InvalidParams` | image source or sprite path read but not decodable (a text file, an HTML page, a truncated download) — message names the `source` or `path` as passed and the decoder's reason; recovery: the source must be a complete PNG, JPEG, GIF, WebP, AVIF, TIFF, or SVG image | no |
| `invalid_color` | `InvalidParams` | strict `resolveColor` throw — the toolkit's message names the offending value and accepted formats; the server appends the valid color names (from `NAMED_COLORS`) and points to `pixoo://reference/themes` for palettes. `pixoo_push_image` checks its `finish` palette entries before reading the source, and `pixoo_render_html` before loading the page, and names the entry the same way | no |
| `unknown_icon` | `InvalidParams` | icon name not in registry — message lists categories | no |
| `discovery_failed` | `ServiceUnavailable` | Divoom cloud unreachable | yes |
| `page_error` | `InvalidParams` | `pixoo_render_html`: the page's `window.render` threw or rejected — message names the frame and the page's error; nothing is pushed | no |
| `browser_unavailable` | `ConfigurationError` | `pixoo_render_html`, thrown by `BrowserRenderer` (Services): no browser found, `PIXOO_BROWSER_PATH` not an executable file, or the browser failed to start — recovery: the install command and `PIXOO_BROWSER_PATH` | no |
| `render_timeout` | `Timeout` | `pixoo_render_html`, thrown by `BrowserRenderer`: the render ran past 30 s, or the call was cancelled — recovery: fewer frames, native sampling, less work per frame | no |
| `render_crashed` | `ServiceUnavailable` | `pixoo_render_html`, thrown by `BrowserRenderer`: the browser or the page crashed; the next render relaunches the browser | yes |

Text overflow is **not** an error — it's a reported fit decision in `layout[]`. Input-schema failures (frame cap, malformed or empty keyframe tracks, `numerals` text holding characters outside the face, an image `source` or sprite `path` that is neither an absolute path nor an http(s) URL, an unknown key in any input object, an element setting both `effect` and `animate`, a `background` object without exactly one of `gradient` or `theme`) are rejected before the handler runs, as `-32602` with the framework's `invalid_arguments` reason and a hint naming the field. An unknown key's hint gives its full path and the keys its object accepts: `Unknown key elements.0.colour. elements.0 accepts: type, x, y, w, h, color, …` from `pixoo_compose_scene`, `Unknown key style.colour. style accepts: palette, shadow, outline, scale, color.` from `pixoo_display_text`. An unknown key does not hide the other failures: `pixoo_display_text` text in `numerals` holding characters outside the face reports both, and a `background.gradeint` typo also reports the missing `background.gradient`. An element holding an unknown key and both `effect` and `animate` reports the unknown key first, then the `effect` failure. A missing or mistyped field stops the element there: Zod runs the `effect`/`animate` check only once the element's fields parse, so fixing the reported field can surface it next.

## Output design

- **Preview-as-content is the contract.** Render tools put the upscaled render (scale 8 → 512px PNG, legible to vision models) in `content[]` as an image block alongside the markdown summary; `structuredContent` carries the data twin (minus raw image bytes — it gets `outputFiles` paths and the layout report). Animations: contact-sheet PNG in content — every frame while 1× tiles fit the 512px sheet (49 at 64px, 225 at 32px, 784 at 16px), an even sample of that many (`fit`) past it (frame `floor(k × n / fit)` of `n` in tile `k`, the toolkit's `loadAnimation` sampling), in order, in a `ceil(√tiles)`-column grid of integer-scaled tiles within the 512px budget — + full GIF written to disk (the 8× preview GIF, or past 40 frames the panel-size GIF the device downloads).
- `pushed` reflects the device ACK, never intent; past 40 frames it also requires the device's request for the GIF and the whole file handed to the OS to send, which is not confirmed receipt (Design Decisions). When `push: false`, output says so plainly (`pushed: false`, preview returned).
- `deviceState` after any push: `{ channel, brightness, screenOn }` — with one enrichment `notice` when the render won't be visible, naming every problem and the `pixoo_control_device` call that fixes it: screen off, brightness ≤ 10, device off the custom channel (a failed switch). No notice when the read-back couldn't reach the device.
- Characters drawn as `?`: when a `pixoo_display_text` line, a `pixoo_compose_scene` `text` element, or a `progress` `label` holds a character outside the standard and compact faces, the `notice` names each one quoted with its code point (`"€" (U+20AC)`, so `U+FE0F` and `U+00A0` are identifiable), once per element in first-appearance order, grouped by element index (the line index in `pixoo_display_text`), and states what the faces draw. Detection reads the input text, regardless of `visible`, effects, or frames, and fires with `push: false` too. The render is unchanged. `pixoo_overlay_text` is out of scope: the device draws it in fonts the server cannot inspect.
- One `notice` per call: `ctx.enrich.notice` is last-wins, so a tool joins its notices into one string — the fallback characters first, then (`pixoo_display_text`) a failed brightness set, then the visibility problems. No new output field and no `format()` change: the framework mirrors `notice` to both surfaces.
- `layout[]` communicates every silent decision the renderer made (font fallback, scroll engaged, element running off the canvas edge). Each tool advertises only the `action` values it returns: `pixoo_display_text` reports `shrunk-to-compact` when only the 3×5 font fits and `scrolling` when the returned frames scroll; `pixoo_compose_scene` places elements as given and never refits them, so its `action` is always `none` and `fits` carries the overflow. Entry shape:

  ```ts
  {
    element: number,                  // index into elements[]; display_text uses the line index
    type: string,                     // element type ('text', 'icon', ...)
    box: { x, y, w, h },              // pixels the element was placed over, dx/dy included
    fits: boolean,                    // the box lies wholly on the canvas
    action: 'none' | 'shrunk-to-compact' | 'scrolling',  // compose_scene: 'none' only
    font?: 'standard' | 'compact' | 'numerals',  // text only — the font actually used
    scale?: number                    // text only — the scale actually used
  }
  ```

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `PixooService` | toolkit `PixooClient` — init from config (lazy; absent `PIXOO_IP` only fails device tools), command serialization + min-interval pacing, `ensureCustomChannel()` (switch + verify via `getChannel`), result→error-contract mapping, status snapshot; past 40 frames, the one-shot GIF listener in `gif-host.ts` | all device-touching tools, status resource |
| `BrowserRenderer` | a headless chrome-headless-shell driven over the DevTools Protocol pipe (`cdp-pipe.ts`) — discovery, launch flags and profile, lifecycle, one browser context per render, the Fetch gate, capture | `pixoo_render_html`; `src/index.ts` (`initBrowserRenderer()` in `setup`, `close()` in `teardown`); `pixoo_design_brief` calls only `discoverBrowser` |

**`cdp-pipe.ts`** is the CDP client under `BrowserRenderer`. `spawnPiped` launches the browser with fds 3 and 4 as the pipe (NUL-delimited JSON) and resolves to its pid, the `CdpPipe`, its exit, and the last 8 KiB of its stderr. `CdpPipe.send` takes an optional session id and abort signal; `on` dispatches events synchronously in arrival order. A command fails as a `CdpError` of kind `protocol` (the browser's error, with its code), `closed` (the pipe closed, or a message was not JSON), or `detached` (its session detached). The transport works under Bun and Node, as parent and as child.

**`BrowserRenderer`** launches the browser on first use with a fresh temp profile (`pixoo-browser-<server pid>-XXXXXX` in the OS temp dir), reuses it for later renders, and closes it after 5 idle minutes (`IDLE_CLOSE_MS`) and on `close()`. The profile is deleted once the browser exits, however it exits, and a browser that crashed is relaunched by the next render. `withPage(html, { sampling, inject }, use, signal)` loads `html` in a new browser context, runs each `inject` script before the page's own in every document, and passes `use` a page:

- `evaluate(expression)` awaits the result and rejects with the page's exception;
- `capture()` returns one `PIXOO_SIZE` frame as a toolkit `Canvas`: the viewport is `PIXOO_SIZE` CSS px, captured at device scale factor 1 (`native`), or 8 (`supersample`) and area-averaged by the toolkit's `downsample`;
- `pageErrors` collects uncaught exceptions, `console.error` and `console.assert` failures, CSP violations, `Blocked request: <url>`, and `Blocked navigation: <url>`, capped at 100 entries of 1,000 characters each.

The context is disposed when `use` settles. One 30 s deadline (`RENDER_DEADLINE_MS`) covers the launch, the load, and `use`. An error `use` throws passes through unchanged; the renderer's own failures are:

| Reason | Code | When |
|:-------|:-----|:-----|
| `browser_unavailable` | `ConfigurationError` | no browser found, `PIXOO_BROWSER_PATH` not an executable file (the message names it), or the browser failed to start (it exited, or never answered `Fetch.enable`). `BROWSER_UNAVAILABLE_RECOVERY` is the recovery hint for a tool's `errors[]` entry: the install command and `PIXOO_BROWSER_PATH` |
| `render_timeout` | `Timeout` | past the deadline, or `signal` aborted; the message says which. The context is disposed, and a browser that cannot dispose it within 5 s is killed |
| `render_crashed` | `ServiceUnavailable`, `data.retryable: true` | the browser died (the pipe closed), the page crashed, or its session detached; the next render relaunches the browser |

Rendering is pure — `src/renderer/` is a plain module (no DI ceremony): element renderers, styled-text engine, layout resolver, theme/palette registry, icon registry (curated SVG path data), effect compiler (presets → keyframes), keyframe interpolation, preview encoding (PNG/contact-sheet/GIF). Independently unit-testable without a device.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `PIXOO_IP` | For device tools | Device IP on the local network. Discovery + pure-render (`push: false`) work without it. |
| `PIXOO_SIZE` | No (default `64`) | `16 \| 32 \| 64` |
| `PIXOO_OUTPUT_DIR` | No | Auto-save directory for preview PNG/GIF files; an explicit `output` on `pixoo_compose_scene` or `pixoo_render_html` replaces it for that call. A relative path resolves against the launch directory when the config is read, so every `outputFiles` entry is absolute |
| `PIXOO_PUSH_MIN_INTERVAL_MS` | No (default `1000`) | Pacing floor between device pushes |
| `PIXOO_SERVE_HOST` | No | Host advertised in the URL the device downloads an animation of more than 40 frames from, in place of the local address the OS routes to `PIXOO_IP` (NAT, a container, a DNS name). The listener binds the routed address either way |
| `PIXOO_SERVE_PORT` | No (default: a free port per play) | Fixed port for that listener, for firewall rules and container port publishing |
| `PIXOO_BROWSER_PATH` | No | Browser executable for HTML rendering. When set, the only candidate: a path that is not an executable file fails `browser_unavailable` naming it, with no fall-through. Unset, the newest chrome-headless-shell for this host in Puppeteer's cache (`~/.cache/puppeteer`). A relative path resolves against the launch directory, never against `PATH` |
| `PIXOO_HTML_ENABLED` | No (default `true`) | `z.stringbool()`. `false` wraps `pixoo_render_html` in `disabledTool()`, so it leaves `tools/list` and `pixoo_design_brief` reports `htmlRenderer: "disabled"`; a value that is not a boolean fails startup |

`src/config/server-config.ts`, own Zod schema.

## Workflow analysis — `pixoo_compose_scene` push path

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 1 | preload assets (`loadImage`/`downsampleSprite`) | before frame loop; each distinct load once, however many elements share it — a URL fetched once, a sprite sheet decoded once per path and grid, an image once per source and placement (`loadImage` decodes and places in one call) | elements present |
| 2 | render frames + encode previews | pure, no device | always |
| 3 | `getChannel()` | skip switch if already Custom | `push` |
| 4 | `setChannel(Custom)` + verify | content must be on Custom to display | `push` ∧ not already |
| 5 | `push()` / `pushAnimation()` | paced; result checked. Past 40 frames: open the one-shot GIF listener before any device command, `playGifUrl`, then wait for the device's request and the whole file's hand-off to the OS | `push` |
| 6 | `getChannel()` + `getConfig()` | post-state for response — channel from `getChannel()` only, `getConfig()` solely for brightness/screen (its `SelectIndex` is absent on current firmware) | `push` |

Failure at 4–5 → the service's typed error, unchanged in `reason` and `retryable` and carrying the tool's declared recovery hint, plus `data.outputFiles` naming the rendered preview on disk — the file this call already saved (`PIXOO_OUTPUT_DIR` auto-save or explicit `output`), otherwise a copy written to a fresh directory under the OS temp dir. The message names the same path for text-only clients. The framework drops `ctx.content` image blocks from error results, so the file path is how the agent keeps the render when the device is down; `cyanheads/mcp-ts-core#494` would let the image block ride the error result too. `pixoo_display_text`, `pixoo_push_image`, and `pixoo_render_html` follow the same path. Step 6 failures degrade to a warning, never tank the call.

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
- **Keyframes interpolate by property, not by value.** Only the `color` track lerps as colors; `dx`, `dy`, and `opacity` read numeric strings as numbers. Guessing from the value misreads a number that also parses as hex, such as `"100"`, as a color.
- **Nested input objects are closed.** In `pixoo_compose_scene`, every element, `style` and its palette stop, `effect`, `animate`, rect `gradient`, `pixels` point, and `background` object is a `z.strictObject`; in `pixoo_display_text`, so are `style` and its palette stop, `position`, and the `background` object and its `gradient`. A misspelled key (`colour`, `strokewidth`) or a key its object doesn't take fails by its full path; dropping it would render as if the key were absent. The root `input` stays a plain `z.object` because the framework closes the root itself. Compose's `background` is one object holding exactly one of `gradient` or `theme`, not a union of two closed objects: a union fails as a whole, so a typo'd key such as `background.gradeint` could not be named by path.
- **Keyframe value types are enforced in the input schema, per property.** The renderer coerces with `Number()` and `Boolean()`, so a word on `opacity`, `dx`, or `dy` became `NaN` (a silently wrong render, or an unclassified failure mid-render) and `"false"` on `visible` kept the element shown. The schema reuses the renderer's `numericValue` test, so it accepts exactly the strings the interpolator reads as numbers.
- **Contact sheet over inline GIF** for animation previews — MCP image-block support for GIF is inconsistent across clients; a PNG grid of the frames is universally visible and shows the motion a single frame hides, the real GIF goes to disk.
- **Image sources and sprite paths must be absolute, checked in the input schema.** A relative path resolved against the server's working directory, which a caller cannot see, so the same call found a file or failed depending on how the server was launched. The check passes any http(s) URL, so an `http://` source and a sprite `path` given as a URL still reach the loaders and fail there as `asset_not_found`, with messages naming the https and local-path requirements. Unlike `output`, a non-normalized absolute path (`..` segments) is accepted: it names a file to read, not where one is written.
- **An explicit `output` replaces the auto-save.** A caller that names its destination on every call (a live dashboard) would otherwise fill `PIXOO_OUTPUT_DIR` with copies it never asked for.
- **A failed push keeps its render as a file, not a success result.** Returning `pushed: false` with a notice would hide the device failure and drop the `retryable` signal callers key on.
- **Element sizes that drive render cost are capped in the schema.** An `image` is resized to exactly `w × h` and a `sprite` paints `scale²` pixels per cell, every one visited even off the canvas, so cost tracks the request rather than the display. `image`/`icon` `w`/`h` stop at 256 (four times the largest panel, room for crop and zoom placements); sprite `scale` stops at 64, where one cell already covers the largest panel, and sprite `cols`/`rows` stop at 64, where the grid already spans the largest panel at `scale: 1` — the downsampler allocates every cell, so the grid is capped on its own, not only through `scale`.
- **Registry icons declare their stroke parts.** The icon paths are outline-style, and a two-point subpath has no area to fill, so filling everything dropped rays, shafts, and marks. The status badges draw their ring as a stroke rather than a disk, because a mark stroked in the disk's own color would be invisible.
- **`fits` checks all four edges of the placed box, in both render tools.** An element pushed off the left or top edge is clipped just as one past the right or bottom is. `pixoo_display_text` and `pixoo_compose_scene` share one check (`boxFits`), so the same text placed the same way reports the same `fits` in either — a line too tall for the panel included, which the 18-px `numerals` face makes routine on a 16-px display.
- **`numerals` rejects characters outside its face** in the input schema rather than drawing the face's `?`: a readout that shows `72??` is worse than an error naming `F`. Units and labels go in their own `standard` or `compact` element. Auto-fit never selects `numerals`, since switching to it would reject text the caller never restricted.
- **`standard` and `compact` report their `?` fallbacks instead of rejecting them.** Most text holding one stray symbol (`20 €`, `it’s`) still reads acceptably, and rejecting it would break calls that render today. A `notice` naming each character by code point tells the caller without the preview inspection a model may not do closely enough to spot one substituted glyph. No lookalike substitution (`’` → `'`): the notice leaves the respelling to the caller.
- **`pixoo_overlay_text` checks `x`/`y` against `PIXOO_SIZE` in the handler.** Input schemas are built once at import, before the configured size is known, so the advertised `.max(64)` stays the absolute ceiling and the handler enforces the real edge.
- **Past 40 frames, the device downloads one GIF instead of taking frame pushes.** Each pushed frame costs a `Draw/SendHttpGif` request and the device turns unstable past about 40, while `Device/PlayTFGif` has the firmware download and loop a GIF itself. The listener (`src/services/pixoo/gif-host.ts`) binds only the local address the OS routes to `PIXOO_IP` (a UDP `connect`, which sends nothing), never `0.0.0.0`; it serves one `GET` at a random 128-bit path, then closes, as it also does on `ctx.signal` abort or after 10 s with no request or no transfer progress; a call cancelled before the play sends no `Device/PlayTFGif`. It is `node:http`, not `Bun.serve`, because MCPB and `npx` installs run under Node, and it is never an MCP route, so stdio and HTTP behave alike. `pushed: true` means the device accepted the play, requested the GIF, and the whole file was handed to the OS to send (the response's `finish` event): `Device/PlayTFGif` answers `error_code: 0` before it downloads, even for a 404, so its ACK alone proves nothing. HTTP gives the server no receipt, so `finish` is the last signal it has; a GIF smaller than the socket send buffer can finish before the device reads it. `PIXOO_SERVE_HOST` and `PIXOO_SERVE_PORT` change only what the URL advertises and which port is bound, never the bind address. Serving from another machine or over `https` is out of scope.
- **HTML renders in chrome-headless-shell over the DevTools Protocol pipe, with no Puppeteer or Playwright.** The renderer needs a handful of CDP commands; either library adds a heavy install and a bundled browser download. The pipe (`--remote-debugging-pipe`, fds 3 and 4) opens no DevTools port any local process could drive, and Chromium exits when the pipe closes, so a killed server leaves no browser behind.
- **Discovery is `PIXOO_BROWSER_PATH`, then chrome-headless-shell in Puppeteer's cache; system browsers are not searched.** Every browser discovery can return must pass the isolation suite, and only chrome-headless-shell was run through it. Only the `mac_arm` cache layout is confirmed on its own platform; the other layouts follow `@puppeteer/browsers` 3.2.2's source.
- **Isolation is enforced by the browser, not by page cooperation.** Each render gets its own browser context whose proxy is a dead loopback address, loopback included. `Fetch` runs on the browser session, so it sees every request of every target, popups and service workers included. The render's document is the one request fulfilled, served once at a random path on `https://pixoo.invalid/` with a `default-src 'none'` CSP; everything else fails as `BlockedByClient`. The exception is a navigation of the render's own page, which fails as `Aborted`: a `BlockedByClient` navigation replaces the document with Chrome's error page and never reports `load`, so the render would sit out its deadline. It is reported as `Blocked navigation: <url>`. WebRTC UDP is closed by both the launch flag and the profile preference, since either alone leaks on one browser family. Measured on chrome-headless-shell:
  - `dns-prefetch`, `preconnect`, and STUN hostnames never reach the net log, so no extra flag is needed.
  - `window.close()` does nothing on a render's page, since its history holds two entries, so a detached session is never the page's own doing.
  - A blocked iframe is reported by its origin only, and a blocked popup's URL is not reported at all. Neither reaches the network.
  - A busy-looping page's context disposes in milliseconds without killing the browser. The 5 s kill is the fallback.
- **Browser profiles are named after the server's pid.** A server killed with `SIGKILL` cannot delete its profile, so each launch first removes `pixoo-browser-<pid>-*` profiles whose pid is no longer running, never those of a live server.
- **HTML animation runs on a virtual clock injected ahead of the page's scripts, not on real time.** Capturing on the wall clock would tie each frame to machine load, so two calls could render different animations. `VIRTUAL_CLOCK_SOURCE` replaces `requestAnimationFrame`, `setTimeout`/`setInterval` (a 4 ms floor for nested and repeating timers, so a zero-delay loop cannot hang a step), `Date` (starting at the real time), and `performance.now()` (0 at load), and each frame step advances them by `speed` ms, so every frame is deterministic. `window.render(t, frame)` gets `t = frame / frames` so periodic motion closes the loop. Workers are blocked, since they keep real clocks; `requestIdleCallback` and iframes still run on real time, and the `html` design-brief topic tells authors not to drive motion with them.
- **The page is the panel.** The served document zeroes the body margin, hides scrollbars, and renders a page that paints no background on black: the browser's default 8 px margin takes a quarter of a 64 px panel, a scrollbar eats layout width, and the default white lights every LED where the panel's "nothing" is unlit. The margin and scrollbar rules come first, at universal- and type-selector specificity, and the black root applies only while neither the root nor the body paints a background, so the page's own CSS overrides each.
- **`supersample` renders at device scale factor 8 and area-averages, and does not promise sub-pixel box positions.** It smooths transforms, text, SVG, and canvas, but Chromium snaps a plain box's edges to whole CSS pixels before scaling, so a box at `left: 0.5px` lands on one LED; the `sampling` description and the `html` topic point sub-pixel motion at `transform`.
- **Pages get a `pixoo` runtime instead of reinventing pixel text in CSS.** Browsers anti-alias text, and at 64×64 that smears across LEDs. The runtime (`src/renderer/page-runtime.ts`) exposes `context`, `text`, `icon`, `palettes`, and `size`. It is bundled from the same code the render tools draw with: `drawPlacedText` in `text-engine.ts`, `drawPlacedIcon` in `icon-draw.ts`, and the theme and icon registries. The scene renderer calls those same functions, so parity with `pixoo_compose_scene` holds by construction, and the real-browser suite checks it byte for byte in both sampling modes. Each lit pixel is one 1×1 `fillRect` on a canvas scaled by `devicePixelRatio` with smoothing off, which keeps one panel pixel per pixel under `supersample`. `scene-renderer.ts` stays out of the bundle, since it reaches `node:fs`, `sharp`, and the remote-image fetch. `scripts/build-page-runtime.ts` typechecks the entry against the DOM lib in its own tsconfig, fails the build if `findNodeImports` reaches any Node built-in or `sharp`, and writes an IIFE to `dist/page-runtime.js`. A missing bundle fails the HTML render rather than server startup: the tool is optional, and a source checkout without a build keeps every other tool working.
- **`pixoo_render_html` takes 1–800 frames, the cap `pixoo_compose_scene` has.** Past 40 it plays through the same device-downloaded GIF path, so an HTML animation needs nothing a scene animation doesn't.
- **Suggestion entries use the `{ toolName, reason, args }` shape** other suggestion-emitting servers use, declared locally until `cyanheads/mcp-ts-core#478` exports it; `args` is always present so a client can execute an entry without a presence check.
- **No DataCanvas, no mirror, no app tools** — nothing here is analytical row data, and the human-facing surface is the physical display itself.

## Known Limitations

- ≤800 animation frames, and past 40 the device must reach this host to download the GIF (plain `http` from this machine only); `pixoo_display_text` stays within 40. ~1 push/sec pacing; ~5s device "Loading.." overlay when a new animation starts.
- Device text overlays (`pixoo_overlay_text`) render on-device: no preview possible, and they persist invisibly across channel switches until cleared.
- `getConfig()` field availability varies by firmware (Pixoo-64 omits `SelectIndex`) — channel reads go through `getChannel()`.
- Discovery requires internet (Divoom cloud endpoint) even though device control is fully local.
- Previews show the sRGB values pushed, not the panel's response: on a Pixoo-64 at brightness 100, levels 0–4 stay dark and mid-levels render darker than on a monitor, but only the dark floor and that qualitative shift are measured, so a simulated-panel preview (or panel correction of pushed frames) would render an invented curve.
- Local transports only (`sharp` won't run on Workers).
- The Docker image ships no browser, so HTML rendering there fails `browser_unavailable`.

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
    { "type": "sprite", "path": "/opt/pixoo/assets/clawd.png", "cols": 10, "rows": 8,
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
