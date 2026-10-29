---
name: pixoo-guide
description: Gates and workflows for the pixoo_* tools that drive a Divoom Pixoo LED panel — preview before pushing, what a push takes over and how to restore it, keeping a clock or live data current, device-native overlays, and getting an unconfigured or unreachable panel working. Use when asked to show, display, scroll, or animate something on the Pixoo, or when a pixoo_* call fails or the panel shows nothing.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The server draws on the machine it runs on and pushes finished frames to one Pixoo on the local network. It fetches no content: weather, prices, scores, and calendar data come from elsewhere, and this server only draws them.

Nothing it pushes refreshes itself. A push shows the frames rendered at call time until the next push or a channel change, and the server keeps no schedule.

Design craft (legibility floors, palettes, layout zones, motion budget, HTML page authoring) lives in pixoo_design_brief, per topic, and the `pixoo://reference/design-guide` resource. This skill does not repeat it.

## Identifiers

| Value | Where it comes from |
|:------|:--------------------|
| Icon names | `iconCategories` from pixoo_design_brief, or `pixoo://reference/icons`. The registry is small (weather has `sun`, `cloud`, `rain`, `snow`, `wind`, `lightning`); a guessed name such as `cloudy` fails `unknown_icon` in pixoo_compose_scene, while inside an HTML page `pixoo.icon` throws into `pageErrors` and the frame renders without it. A shape outside it is an icon element's `d` path or a `bitmap` element |
| Named colors | Listed nowhere except an `invalid_color` error message. Use `#RRGGBB` hex |
| Image `source`, sprite `path` | Image `source`: an absolute path on the machine the server runs on, or an https URL. Sprite `path`: an absolute local path only; a URL fails `asset_not_found`. A file that exists only on your side is invisible to a server running elsewhere |
| Panel size | `displaySize` in the brief's `deviceContext` or `pixoo://device/status`. Coordinates are panel pixels and never scale: a layout written for 64 px runs off a 32 px panel |
| Device IP | `ip` from pixoo_discover_devices, set as `PIXOO_IP` in the server's environment. No tool sets it |
| Clock face ID | No tool lists them. The current one is `clockId` from pixoo_control_device called with no arguments, present while the channel is `faces` |
| Overlay slot (0–19) | No tool reports which slots hold text. Track every `id` you set |
| Overlay font (0–114) | Only 0 (default), 18 (arrows), and 20 (°C/°F) are documented; the rest are opaque device fonts. Use 0 unless the user names one |

## Gates

1. **Tell "not configured" from "unreachable" before pushing.** The brief's `reachable: false` covers both. `pixoo://device/status` returns `configuredIp: null` when no device is configured, and then every push, overlay, and pixoo_control_device change fails `no_device_configured` (a bare pixoo_control_device read just returns `reachable: false`). You cannot fix that from a tool: run pixoo_discover_devices, give the user the `ip`, and ask them to set `PIXOO_IP` in the server's configuration and restart the server, which reads its environment once at startup. Until then, render with `push: false` only.
2. **Preview with `push: false` until the result is right, then push.** The render tools default to `push: true`. Before pushing, check the image and the response: a `layout` entry with `fits: false` runs off the panel (pixoo_compose_scene never refits an element), a notice naming a character drawn as `?`, and `pageErrors` from pixoo_render_html, where a blocked network asset is reported and the page still renders without it. Then repeat the same call with `push: true`. The same arguments render the same pixels, so the push matches the preview, except for an HTML page that calls `Math.random` or reads the start time through `Date`: each call draws those anew. When the pushed page must match the preview, use a seeded generator.
3. **A failed push returns no image.** The error carries the saved preview's path in `data.outputFiles`, and the image block is dropped. When the device is not confirmed reachable, preview with `push: false` first so you still see the render.
4. **Judge dark and muted colors with the panel in mind.** The preview shows the sRGB values pushed. On a Pixoo-64 at brightness 100, channel levels 0–4 stay unlit and muted warm tones read redder (`#D97757` reads red), so a near-black accent that shows in the preview can vanish on the panel.
5. **A push takes over the panel.** It switches the device to the `custom` channel and replaces whatever was showing, a clock face included; the server never switches back. When the user wants the previous display back afterward ("flash this, then go back"), call pixoo_control_device with no arguments first and keep `channel` and `clockId`. Restore with `channel`, plus `clockFaceId` when the channel was `faces`: one call applies the channel before the clock face.
6. **Push on change, not in a tight loop.** Pushes run one at a time, spaced by `PIXOO_PUSH_MIN_INTERVAL_MS` (default 1000 ms), and a few hundred rapid pushes can freeze the device until it restarts.

## Workflows

### A clock or live data

A rendered clock shows the time it was rendered. For the time of day, the device's own clock faces stay live: pixoo_control_device with `channel: "faces"`. For a custom readout (a styled clock, the temperature, a build status), render and push again each time the value changes. The schedule belongs to the caller.

### Weather with an animated icon

Get the conditions from a weather source, map them to a registry icon, then compose: a dark background, the icon with an `effect` (`pulse`, `float`, or `twinkle`), and text elements for the reading. Set `frames` (say 20): the default is 1, and a single frame renders the effect static with no warning. pixoo_design_brief topic `dashboard` covers the numerals font and unit labels. Preview, then push. When the registry can't express the scene, pixoo_render_html draws it if the brief's `htmlRenderer` is `available`.

### A scrolling message

| Want | Use |
|:-----|:----|
| Styled, previewable text | pixoo_display_text with `effect: "scroll"`, or `"auto"` to scroll only when the text is too wide. Lines go in an array; a newline inside one string draws as `?` |
| Text in a scene with other elements | pixoo_compose_scene, the text element carrying `effect: { name: "scroll-left" }`. It moves 2 × `amplitude` px per frame from where the element is placed and never wraps, so start it at the right edge (`x` = panel size) and give it enough `frames` to cross: about (text width + panel size) ÷ (2 × `amplitude`). Read the text width from a static preview's `layout`. The scrolling element's own entry reports `fits: false`, which is expected. Long text runs past 40 frames, which the device must download (`gif_serve_failed` below): raise `amplitude`, or use pixoo_display_text `scroll`, which stays within 40 frames |
| A device-rendered ticker over what is already showing | pixoo_overlay_text (below) |

pixoo_overlay_text has no preview, and it does not switch the channel the way a push does: push the scene it should run over first. An overlay stays, including across channel switches, until cleared with `mode: "clear"` on the same `id`. Clear every slot you set when the user is done with it, since nothing lists them.

### The panel shows nothing, or a call fails

| Symptom | Next step |
|:--------|:----------|
| `no_device_configured` | Gate 1 |
| `device_unreachable` on repeated calls | pixoo_discover_devices. `configuredIpFound: false` means `PIXOO_IP` matches no panel discovery found; the user sets it to the discovered `ip` and restarts the server |
| `discovery_failed` | Discovery asks Divoom's cloud, so the server's machine needs internet. Otherwise the user finds the panel's IP in the router's client list |
| `pushed: true`, nothing visible | The response notice names the screen, brightness, or channel problem and the pixoo_control_device call that fixes it. Otherwise run pixoo_design_brief with topic `troubleshooting` |
| "Loading..." on the panel for a few seconds | Expected when a new animation starts |
| `gif_serve_failed` | Past 40 frames the device downloads the animation from the server's machine. Cut to 40 frames or fewer, which needs no download, or ask the user to set `PIXOO_SERVE_HOST` and `PIXOO_SERVE_PORT` (server in Docker or behind NAT) |
| `browser_unavailable` from pixoo_render_html | No headless browser on the server's machine. Compose the scene with pixoo_compose_scene instead |
