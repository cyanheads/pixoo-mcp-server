/**
 * @fileoverview pixoo_design_brief tool — craft guidance per topic with live device context.
 * @module mcp-server/tools/definitions/pixoo-design-brief.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { DIM_BRIGHTNESS } from '@/mcp-server/tools/device-push.js';
import { getIconsByCategory } from '@/renderer/icons.js';
import { THEME_NAMES } from '@/renderer/themes.js';
import {
  BROWSER_UNAVAILABLE_RECOVERY,
  discoverBrowser,
} from '@/services/browser/browser-renderer.js';
import { type DeviceStateSnapshot, getPixooService } from '@/services/pixoo/pixoo-service.js';

const CRAFT_CONTENT: Record<string, string> = {
  text: `## Text Display Guidance

**Legibility floors:** At 64px viewing distance, 1px features vanish. Minimum eye size: 1–2px. Minimum limb gaps: 2 rows. Use standard font (5×7) as the default; compact font (3×5) only when standard doesn't fit.

**Symbols:** standard and compact draw printable ASCII plus \`° ← ↑ → ↓ ▲ ▼ ♥ · …\`, so \`72°F\`, \`▲3 ▼2\`, and \`← BACK\` print as written. Any other character draws as \`?\` — \`€\`, \`×\`, typographic quotes and dashes (\`’ —\`), a newline inside one string, and the invisible U+FE0F that often follows \`♥\` — and the response notice names each one with its code point and element index. Spell them in ASCII (\`EUR\`, \`x\`, \`'\`, \`-\`), and pass multi-line text as an array of lines.

**Numerals:** \`font: "numerals"\` is an 11×18 face for clocks and big readouts. It draws 0–9, space, and \`: . - + / % ° ?\` only, every digit on one 13px advance so a changing time keeps its width; text holding any other character is rejected. \`12:45\` is 58×18 at scale 1, and at scale 2 (116px) it overflows a 64px panel. Auto-fit never picks numerals — set it explicitly, and put units and labels in a standard or compact text element beside it with pixoo_compose_scene.

**Scale for impact:** scale: 2 produces chunky block-letter weight (14px tall). Use for headlines. Scale 3+ is decorative — verify it fits before pushing.

**Palette discipline:** Use the styled text engine's vertical color ramps instead of flat colors:
- \`ember\` (gold → deep orange): warmth, alerts, energy
- \`ice\` (white → blue): cool, technical, calm
- \`claude\` (warm orange ramp): Claude/AI assistant branding
- \`neon\` (green → blue): hacker, matrix, digital
- \`fire\` (yellow → red): danger, heat, excitement
- \`lavender\` (white → lavender): gentle, premium, night sky

**Shadow + outline:** Add \`shadow: true\` for dark backgrounds; \`outline: true\` for legibility against low-contrast backgrounds.

**Auto-fit:** Single-line text tries the standard font, then compact; set \`font\` to keep one font, and text too wide for it overflows instead of shrinking. Every fit decision appears in \`layout[]\`. Text still too wide shows only its opening characters — set \`effect: "auto"\` to scroll it across the display instead, or \`effect: "scroll"\` to scroll any text.

**Motion:** \`effect: "float"\` (gentle bob) or \`effect: "pulse"\` (breathing brightness) loops over 20 frames. Motion reads best on short headlines; keep long text static or scrolling.

**Multi-line stacking:** For 3 lines at scale 2: (14px + 1px gap) × 3 = 45px. Leaves 9.5px margin above and below on a 64px canvas — plan your vertical budget. \`align: "left"\` or \`"right"\` lines up the edges of the lines; \`position.x\` places the block.`,

  scene: `## Scene Composition Guidance

**Design system:** Every element renders back-to-front in array order. Background → fill elements → widgets → text headline → foreground details.

**Layout zones:**
- Top strip (y: 0–15): status icons, indicators, small labels
- Middle band (y: 16–47): hero content (main text scale: 2, charts, sprites)
- Bottom strip (y: 48–63): captions, small metrics, timestamps

**Color budget (4–6 colors):** Value contrast over hue contrast. Background should be very dark (lightness < 20%). Warm whites (#f0ead6) read better than pure white (#ffffff) against LEDs.

**Icon + text pairing:** Icon at right or left edge, text with matching palette filling the remaining width.

**Glow:** Place a larger, dimmer copy of a bright shape just before it in \`elements\` with \`blend: "add"\` — a radius-6 \`#402000\` circle beneath a radius-3 \`#ffb000\` one. Added light never darkens what it overlaps, so the halo lifts the background around the shape instead of covering it. Lower its \`opacity\` for a fainter halo, or use \`blend: "screen"\` for a gentler lift. The same trick makes light beams: a wide, dim \`line\` (\`strokeWidth\` 3–5) blended add under a bright 1px one.

**Status dashboard pattern:**
1. Gradient background (v gradient, very dark)
2. Title text (scale 2, top, palette matching the theme)
3. Status icon (check-circle/x-circle, right edge, color red/green)
4. Progress bar (middle band, matching palette)
5. Sparkline (full width, lower third)
6. Caption text (compact font, bottom)`,

  dashboard: `## Dashboard Design Guidance

**Widget hierarchy:** One focal metric per dashboard. Everything else is supporting context.

**Progress bar sizing:** 60px wide × 5–8px tall is optimal for readability. Leave at least 2px gap between elements.

**Sparkline guidance:** 60px wide × 12–16px tall. Auto-scales to data range. Use \`kind: "bar"\` for discrete events, \`kind: "line"\` for continuous trends.

**Color coding:** Use semantic colors — green for good/up, red for bad/down, orange for warning, blue for neutral metrics. Match colors to palettes for visual consistency.

**Metric text:** \`font: "numerals"\` (11×18) for the hero metric or clock — it draws 0–9, space, and \`: . - + / % ° ?\` only, so its unit or label goes in a separate standard or compact text element beside it. \`font: "standard"\` scale 2 when the hero value needs letters. \`font: "compact"\` (3×5) for secondary numbers.

**Units and trends:** standard and compact draw \`° ← ↑ → ↓ ▲ ▼ ♥ · …\` — \`72°F\`, \`▲3 ▼2\`, \`↑ 12%\`.

**Update frequency:** Don't push faster than 1/sec. For live dashboards, push on data change events.`,

  animation: `## Animation Guidance

**Budget:** Up to 40 frames push frame by frame. Past 40, pixoo_compose_scene, pixoo_push_image, and pixoo_render_html play one GIF of up to 800 frames that the device downloads from this host, so the device must reach it (behind NAT or a firewall, set PIXOO_SERVE_HOST and PIXOO_SERVE_PORT), and speed rounds to 10 ms. pixoo_display_text stays at 40 or fewer. 20 frames at 150ms = 3s loop. 10 frames at 100ms = 1s loop. Device shows a "Loading..." overlay for ~5s when a new animation starts.

**Motion hierarchy:** One hero motion + ≤ 2 ambient effects. More creates visual noise at 64px.

**Effect presets (compile to keyframes server-side):**
- \`float\`: gentle y bob — ideal for sprites and headline text
- \`pulse\`: opacity ramp — breathing effect, ambient indicators
- \`scroll-left/right\`: horizontal pan — text that doesn't fit, scene transitions
- \`blink\`: visibility toggle — alerts, status indicators
- \`twinkle\`: irregular opacity flicker — stars, particles, sparkle elements
- \`drift\`: slow x wander — background objects, atmospheric depth

**Parallax:** Use different \`amplitude\` and \`phase\` values for depth: hero element amplitude=4, mid-ground amplitude=2, background amplitude=1.

**Timing rule:** Float period = totalFrames (default). Phase = 0.5 staggers second element by half a cycle.`,

  'pixel-art': `## Pixel Art Guidance

**Color system:** Max 4–6 colors for clean pixel art. Use the palette array in bitmap elements. To bring a photo or image down to a small or fixed palette, pass \`finish\` on pixoo_push_image or a scene \`image\` element: \`colors\` (2–256, built from the image) or \`palette\` (your own colors), with \`dither\` \`bayer4\` (ordered pattern) or \`floyd-steinberg\` (diffused, smoothest on photos).

**Scale rules:** At 64px, 1px = 1 LED. Minimum recognizable feature: 2px. Eyes: at least 2×2. Limbs: 2px minimum. Scale ≥ 2 for any detail that needs to read clearly.

**bitmap element:** Use for custom art with explicit palette control. Rows as hex index strings, palette as hex color array. Space or dot = transparent.

**Sprite technique:** \`downsampleSprite\` collapses a sprite sheet to body/dark cell grids — best for character sprites with solid fills. Works from any PNG with transparent background.

**Dark backgrounds:** LEDs don't emit light for unlit pixels. Design with dark backgrounds; your art pops against unlit black.

**Anti-aliasing:** Pixel art keeps hard edges, and 45-degree diagonals at scale 1 look stairstepped. Where a smooth edge reads better, a scene \`line\` or outline \`circle\` takes \`antialias: true\`, shading each edge pixel by how much of it the stroke covers, and \`strokeWidth\` for a thicker stroke. Bitmaps, sprites, and filled shapes stay hard-edged.`,

  html: `## HTML Page Guidance

pixoo_render_html lays out a page in a square viewport, one CSS pixel per LED (64×64 on a Pixoo-64), and captures it: anything HTML, CSS, SVG, Canvas, or WebGL draws. \`htmlRenderer\` in this brief says whether it can render here: \`available\`, \`disabled\` (PIXOO_HTML_ENABLED=false), or \`no_browser\`.

**The page is the panel:** \`body\` has no margin, scrollbars are hidden, and a page that paints no background renders on black, which the panel shows as unlit. The page's own CSS overrides each — \`body { margin: 4px }\`, a \`background\` on \`html\` or \`body\`. Design on black: a white page lights every LED at once.

**Seamless loops:** Define \`window.render(t, frame)\`. It runs before each capture with \`t = frame / frames\`, from 0 up to (frames − 1) / frames, so motion periodic in \`t\` — \`Math.cos(2 * Math.PI * t)\` — closes the loop with no seam. It may be async. If it throws or rejects, the call fails \`page_error\` naming the frame.

**Virtual clock:** Each frame advances the clock by \`speed\` ms, so frames are deterministic and two calls capture the same pixels. \`requestAnimationFrame\` callbacks run once per frame; \`setTimeout\` and \`setInterval\` fire on virtual time, a nested or repeating timer waiting at least 4 ms; \`performance.now()\` reads 0 at load and \`frame × speed\` at each frame; \`Date\` starts at the real time and then follows the virtual clock. CSS animations and transitions are paused and seeked to the same time. \`requestIdleCallback\` and iframes keep real time, so don't drive motion with them. Workers are blocked.

**No network:** Nothing loads from a network URL — no web fonts, CDN scripts, or remote images. Inline scripts, styles, and SVG, and use \`data:\` or \`blob:\` URLs for assets. A blocked request's URL appears in \`pageErrors\`. Navigating the page away is blocked and reported as \`Blocked navigation: <url>\`; a popup is blocked without its URL being reported.

**Frames:** \`frames\` is 1–800. Up to 40 push frame by frame; more play as one GIF the device downloads from this host, as on pixoo_compose_scene, so the device must reach it (behind NAT or a firewall, set PIXOO_SERVE_HOST and PIXOO_SERVE_PORT), and \`speed\` rounds to 10 ms.

**Thin strokes vanish:** At 64px, a 1px line or border that straddles two LEDs, or small browser text, averages into a dim smear or disappears. Use strokes of 2px or more and solid fills. Browser fonts anti-alias at this size; for crisp pixel text use \`pixoo.text\`, below.

**Sampling:** \`native\` (default) captures one CSS pixel per LED: crisp, with positions snapped to whole LEDs. \`supersample\` renders at 8× and averages each 8×8 block into one LED, smoothing transforms, text, SVG, and canvas. Chromium snaps a plain box's edges to whole CSS pixels before scaling, so a box at \`left: 0.5px\` still lands on one LED; move it with \`transform\` for sub-pixel motion.

**Pixel text and icons:** Every page gets a \`pixoo\` global before its own scripts run, a \`<head>\` script included. \`pixoo.context()\` returns the 2D context of one transparent panel-size canvas fixed over the page, the same one on every call. \`pixoo.text(ctx, text, x, y, { font, color, palette, scale, shadow, outline })\` draws the bitmap fonts of pixoo_display_text and returns the \`{ x, y, w, h }\` it drew; \`x\` takes pixels, \`left\`, \`center\`, or \`right\`, and \`y\` pixels, \`top\`, \`center\`, or \`bottom\`, as on a scene \`text\` element. \`pixoo.icon(ctx, name, x, y, { w, h, color, palette })\` draws a registry icon, 12×12 by default. \`pixoo.palettes\` holds the 7 palettes as \`{ from, to }\` stops; \`palette\` takes one's name, and text also takes a stop. \`pixoo.size\` is the panel size. Each lit pixel is one 1×1 \`fillRect\`, and the context is scaled by \`devicePixelRatio\` with smoothing off, so one unit stays one panel pixel under \`supersample\` and the output matches pixoo_compose_scene pixel for pixel. An unknown palette, font, icon, or color throws naming it, as does \`numerals\` text holding a character that font lacks.

**Palette:** \`finish\` reduces the frames to a palette before the preview and push, as on pixoo_push_image: \`colors\` builds one palette shared by every frame, while \`palette\` and \`dither\` apply per frame.`,

  troubleshooting: `## Troubleshooting Guide

**Device unreachable:**
- Check PIXOO_IP matches the device's current IP (run pixoo_discover_devices)
- Verify the device and this server are on the same network/subnet
- Try rebooting the device (unplug/replug)
- Check the Divoom app shows the device as connected

**Display not updating:**
- Check the channel — custom content requires channel = custom
- Use pixoo_control_device to read current state
- Screen off? Set screen: "on" with pixoo_control_device
- Low brightness? Set brightness: 80+ to verify visibility

**push: false → inspect before pushing:**
- All render tools return a preview image regardless of push setting
- Use push: false to iterate on designs without affecting the display

**Animation stutters:**
- Reduce frame count
- Increase speed parameter (fewer, slower frames = smoother)
- Avoid more than 3 simultaneous animated elements

**Animation past 40 frames fails with gif_serve_failed:**
- The device downloads it from this host, at the address and port the error names; make sure the device can reach them, and behind NAT or a firewall set PIXOO_SERVE_HOST and PIXOO_SERVE_PORT
- Or keep it to 40 frames or fewer, which push frame by frame with no download

**Color not as expected:**
- Use #RRGGBB hex, or a named color (names are case-insensitive)
- resolveColor throws on typos; check the error message for the accepted formats
- On a Pixoo-64 at brightness 100, channel levels 0–4 stay dark, and mid-levels render darker than on an sRGB monitor, shifting muted warm colors toward red (#D97757 reads red)`,
};

/**
 * A follow-up call with its arguments pre-filled — the `{ toolName, reason, args }`
 * shape other suggestion-emitting servers use, declared here until the framework
 * exports it (cyanheads/mcp-ts-core#478).
 */
const NextToolSuggestionSchema = z
  .object({
    toolName: z.string().describe('Tool to call next.'),
    reason: z.string().describe('Why this step is recommended given the current device state.'),
    args: z
      .object({})
      .passthrough()
      .describe('Pre-filled arguments for the call; {} when the tool needs none.'),
  })
  .describe('A recommended follow-up call with its arguments pre-filled.');

type NextToolSuggestion = z.infer<typeof NextToolSuggestionSchema>;

const HTML_RENDERER_STATES = ['available', 'disabled', 'no_browser'] as const;
type HtmlRendererState = (typeof HTML_RENDERER_STATES)[number];

/** What each state means for the caller, appended to its line in format(). */
const HTML_RENDERER_NOTES: Record<HtmlRendererState, string> = {
  available: ' — pixoo_render_html can render pages.',
  disabled: ' — PIXOO_HTML_ENABLED=false, so pixoo_render_html is not listed.',
  no_browser: ` — pixoo_render_html fails browser_unavailable until a browser is found. ${BROWSER_UNAVAILABLE_RECOVERY}`,
};

/**
 * Whether pixoo_render_html can render here. Discovery only looks for the executable —
 * the brief never launches a browser.
 */
function htmlRendererState(cfg: ServerConfig): Promise<HtmlRendererState> {
  if (!cfg.pixooHtmlEnabled) return Promise.resolve('disabled');
  return discoverBrowser({ browserPath: cfg.pixooBrowserPath }).then(
    () => 'available',
    (err: unknown) => {
      if (err instanceof McpError && err.data?.['reason'] === 'browser_unavailable') {
        return 'no_browser';
      }
      throw err;
    },
  );
}

/** An animated scene: the animation topic's suggestion, and the html topic's when HTML is off. */
function animatedSceneArgs(push: boolean): NextToolSuggestion['args'] {
  return {
    background: { theme: 'midnight' },
    elements: [
      {
        type: 'text',
        text: 'HELLO',
        x: 'center',
        y: 'center',
        style: { palette: 'claude', shadow: true, scale: 2 },
        effect: { name: 'float', amplitude: 2 },
      },
    ],
    frames: 20,
    speed: 150,
    push,
  };
}

/** A dot orbiting the panel center once per loop, drawn in SVG so it fits any panel size. */
const ORBIT_PAGE =
  '<svg viewBox="0 0 64 64" style="display:block;width:100vw;height:100vh"><circle id="dot" r="6" fill="#ffb000"/></svg><script>const dot = document.getElementById("dot"); window.render = (t) => { const a = 2 * Math.PI * t; dot.setAttribute("cx", 32 + 20 * Math.cos(a)); dot.setAttribute("cy", 32 + 20 * Math.sin(a)); };</script>';

export const pixooDesignBrief = tool('pixoo_design_brief', {
  title: 'pixoo_design_brief',
  description:
    'Return craft guidance and live device context for a design topic. Covers legibility rules, palette discipline, layout zones, animation budget, HTML page authoring, and pre-filled next-tool suggestions based on current device state. The orientation tool to run before authoring a scene, dashboard, animation, or HTML page — or when troubleshooting display issues.',
  annotations: { readOnlyHint: true },

  input: z.object({
    topic: z
      .enum(['text', 'scene', 'dashboard', 'animation', 'pixel-art', 'html', 'troubleshooting'])
      .describe(
        'Design topic: text (styled text guidance), scene (composition + layout zones), dashboard (widgets + metrics), animation (motion budget + effects), pixel-art (bitmap + sprite guidance), html (pixoo_render_html pages: loops, clock, sampling), troubleshooting (device + display issues).',
      ),
  }),

  output: z.object({
    topic: z.string().describe('The topic that was requested.'),
    craftGuidance: z
      .string()
      .describe(
        'Markdown-formatted craft rules: legibility floors, palette discipline, layout zones, and technique guidance specific to the topic.',
      ),
    deviceContext: z
      .object({
        displaySize: z
          .number()
          .describe(
            'Configured display canvas size in pixels (16, 32, or 64). Design coordinates scale to this value.',
          ),
        reachable: z
          .boolean()
          .describe(
            'True if device is currently reachable. When false, push: false is implied for all render tools.',
          ),
        channel: z.string().optional().describe('Current device channel. Absent when unreachable.'),
        brightness: z
          .number()
          .optional()
          .describe('Current device brightness (0–100). Absent when unreachable.'),
        screenOn: z.boolean().optional().describe('True if screen is on. Absent when unreachable.'),
      })
      .describe('Live device state snapshot at the time of the request.'),
    htmlRenderer: z
      .enum(HTML_RENDERER_STATES)
      .describe(
        'Whether pixoo_render_html can render: available; disabled (PIXOO_HTML_ENABLED=false, so the tool is not listed); or no_browser (no browser found, so the tool fails browser_unavailable until one is installed).',
      ),
    nextToolSuggestions: z
      .array(NextToolSuggestionSchema)
      .describe('Suggested next steps based on topic and device state.'),
    availableThemes: z
      .array(z.string())
      .describe(
        'Available named scene themes (e.g. "midnight", "ember"). Use in background.theme or pixoo_display_text theme param.',
      ),
    iconCategories: z
      .record(z.string(), z.array(z.string()))
      .describe(
        'Built-in icon names grouped by category (weather, arrows, status, media). Use names in pixoo_compose_scene icon elements.',
      ),
  }),

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const svc = getPixooService();

    // Get device state (don't fail if device unreachable) and the HTML renderer's state
    const [deviceStatus, htmlRenderer] = await Promise.all([
      svc.getStatus(ctx).catch((): DeviceStateSnapshot => ({ reachable: false })),
      htmlRendererState(cfg),
    ]);

    // Build next-tool suggestions based on topic + device state
    const suggestions: NextToolSuggestion[] = [];

    if (input.topic === 'text') {
      suggestions.push({
        toolName: 'pixoo_display_text',
        reason: 'The primary tool for styled text rendering.',
        args: {
          text: 'HELLO',
          theme: 'midnight',
          style: { palette: 'lavender', shadow: true, scale: 2 },
          push: deviceStatus.reachable,
        },
      });
      if (!deviceStatus.reachable) {
        suggestions.push({
          toolName: 'pixoo_discover_devices',
          reason: 'Device is not reachable — find it on the network first.',
          args: {},
        });
      }
    } else if (input.topic === 'scene') {
      suggestions.push({
        toolName: 'pixoo_compose_scene',
        reason: 'Full scene composition with layered elements.',
        args: {
          background: { theme: 'midnight' },
          elements: [
            {
              type: 'text',
              text: 'HELLO',
              x: 'center',
              y: 'center',
              style: { palette: 'lavender', shadow: true, scale: 2 },
            },
          ],
          frames: 1,
          push: deviceStatus.reachable,
        },
      });
    } else if (input.topic === 'dashboard') {
      suggestions.push({
        toolName: 'pixoo_compose_scene',
        reason: 'Compose a status dashboard with widgets.',
        args: {
          background: { gradient: { type: 'v', from: '#0a1020', to: '#000000' } },
          elements: [
            { type: 'text', text: 'STATUS', x: 2, y: 2, style: { palette: 'ice' } },
            { type: 'icon', name: 'check-circle', x: 'right', dx: -2, y: 2, color: 'green' },
            { type: 'progress', x: 2, y: 14, w: 60, h: 5, value: 75, max: 100, palette: 'neon' },
          ],
          frames: 1,
          push: deviceStatus.reachable,
        },
      });
    } else if (input.topic === 'animation') {
      suggestions.push({
        toolName: 'pixoo_compose_scene',
        reason: 'Compose an animated scene.',
        args: animatedSceneArgs(deviceStatus.reachable),
      });
    } else if (input.topic === 'html') {
      if (htmlRenderer === 'disabled') {
        suggestions.push({
          toolName: 'pixoo_compose_scene',
          reason:
            'pixoo_render_html is turned off (PIXOO_HTML_ENABLED=false); compose layered scenes and animations instead.',
          args: animatedSceneArgs(deviceStatus.reachable),
        });
      } else {
        suggestions.push({
          toolName: 'pixoo_render_html',
          reason:
            htmlRenderer === 'no_browser'
              ? `Render a seamless loop once a browser is installed: ${BROWSER_UNAVAILABLE_RECOVERY}`
              : 'Render a seamless loop: window.render(t) moves a dot once around the panel over 20 frames.',
          args: {
            html: ORBIT_PAGE,
            frames: 20,
            speed: 100,
            sampling: 'supersample',
            push: deviceStatus.reachable,
          },
        });
      }
    } else if (input.topic === 'troubleshooting') {
      if (!deviceStatus.reachable) {
        suggestions.push({
          toolName: 'pixoo_discover_devices',
          reason: 'Device is not reachable — discover it on the network.',
          args: {},
        });
      } else if (deviceStatus.screenOn === false) {
        suggestions.push({
          toolName: 'pixoo_control_device',
          reason: 'Screen appears to be off.',
          args: { screen: 'on' },
        });
      } else if (
        deviceStatus.brightness !== undefined &&
        deviceStatus.brightness <= DIM_BRIGHTNESS
      ) {
        suggestions.push({
          toolName: 'pixoo_control_device',
          reason: 'Brightness is very low — content may not be visible.',
          args: { brightness: 80 },
        });
      } else {
        suggestions.push({
          toolName: 'pixoo_control_device',
          reason: 'Read full device state.',
          args: {},
        });
      }
    } else {
      suggestions.push({
        toolName: 'pixoo_display_text',
        reason: 'Start with text display to verify the pipeline works end-to-end.',
        args: { text: 'TEST', push: false },
      });
    }

    const craftGuidance = CRAFT_CONTENT[input.topic] ?? 'No guidance available for this topic.';

    return {
      topic: input.topic,
      craftGuidance,
      deviceContext: {
        displaySize: cfg.pixooSize,
        reachable: deviceStatus.reachable,
        channel: deviceStatus.channel,
        brightness: deviceStatus.brightness,
        screenOn: deviceStatus.screenOn,
      },
      htmlRenderer,
      nextToolSuggestions: suggestions,
      availableThemes: THEME_NAMES,
      iconCategories: getIconsByCategory(),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Design Brief: ${result.topic}`);
    lines.push('');
    lines.push(result.craftGuidance);
    lines.push('');
    lines.push('## Device Context');
    lines.push(
      `Display size: **${result.deviceContext.displaySize}px** | Reachable: **${result.deviceContext.reachable}**`,
    );
    if (result.deviceContext.channel) lines.push(`Channel: ${result.deviceContext.channel}`);
    if (result.deviceContext.brightness !== undefined)
      lines.push(`Brightness: ${result.deviceContext.brightness}`);
    if (result.deviceContext.screenOn !== undefined)
      lines.push(`Screen: ${result.deviceContext.screenOn ? 'On' : 'Off'}`);
    lines.push(
      `HTML renderer: **${result.htmlRenderer}**${HTML_RENDERER_NOTES[result.htmlRenderer]}`,
    );
    lines.push('');
    lines.push('## Next Steps');
    for (const s of result.nextToolSuggestions) {
      lines.push(`**${s.toolName}**: ${s.reason}`);
      if (Object.keys(s.args).length > 0) {
        lines.push('```json');
        lines.push(JSON.stringify(s.args, null, 2));
        lines.push('```');
      }
    }
    lines.push('');
    lines.push('## Available Themes');
    lines.push(result.availableThemes.join(', '));
    lines.push('');
    lines.push('## Icons by Category');
    for (const [cat, names] of Object.entries(result.iconCategories)) {
      lines.push(`**${cat}:** ${(names as string[]).join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
