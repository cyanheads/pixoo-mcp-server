/**
 * @fileoverview pixoo_design_brief tool — craft guidance per topic with live device context.
 * @module mcp-server/tools/definitions/pixoo-design-brief.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getIconsByCategory } from '@/renderer/icons.js';
import { THEME_NAMES } from '@/renderer/themes.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

const CRAFT_CONTENT: Record<string, string> = {
  text: `## Text Display Guidance

**Legibility floors:** At 64px viewing distance, 1px features vanish. Minimum eye size: 1–2px. Minimum limb gaps: 2 rows. Use standard font (5×7) as the default; compact font (3×5) only when standard doesn't fit.

**Scale for impact:** scale: 2 produces chunky block-letter weight (10px tall). Use for headlines. Scale 3+ is decorative — verify it fits before pushing.

**Palette discipline:** Use the styled text engine's vertical color ramps instead of flat colors:
- \`ember\` (gold → deep orange): warmth, alerts, energy
- \`ice\` (white → blue): cool, technical, calm
- \`claude\` (warm orange ramp): Claude/AI assistant branding
- \`neon\` (green → blue): hacker, matrix, digital
- \`fire\` (yellow → red): danger, heat, excitement
- \`lavender\` (white → lavender): gentle, premium, night sky

**Shadow + outline:** Add \`shadow: true\` for dark backgrounds; \`outline: true\` for legibility against low-contrast backgrounds.

**Auto-fit:** Set \`overflow: "auto"\` and let the renderer choose font size and scroll. Every fit decision appears in \`layout[]\`.

**Multi-line stacking:** For 3 lines at scale 2: 10px + 1px gap × 3 = 33px. Leaves 15.5px margin each side for a 64px canvas — plan your vertical budget.`,

  scene: `## Scene Composition Guidance

**Design system:** Every element renders back-to-front in array order. Background → fill elements → widgets → text headline → foreground details.

**Layout zones:**
- Top strip (y: 0–15): status icons, indicators, small labels
- Middle band (y: 16–47): hero content (main text scale: 2, charts, sprites)
- Bottom strip (y: 48–63): captions, small metrics, timestamps

**Color budget (4–6 colors):** Value contrast over hue contrast. Background should be very dark (lightness < 20%). Warm whites (#f0ead6) read better than pure white (#ffffff) against LEDs.

**Icon + text pairing:** Icon at right or left edge, text with matching palette filling the remaining width.

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

**Metric text:** \`font: "compact"\` (3×5) for secondary numbers. \`font: "standard"\` scale 2 for the hero metric.

**Update frequency:** Don't push faster than 1/sec. For live dashboards, push on data change events.`,

  animation: `## Animation Guidance

**Budget:** 40 frames max. 20 frames at 150ms = 3s loop. 10 frames at 100ms = 1s loop. Device shows a "Loading..." overlay for ~5s when a new animation starts.

**Motion hierarchy:** One hero motion + ≤ 2 ambient effects. More creates visual noise at 64px.

**Effect presets (compile to keyframes server-side):**
- \`float\`: gentle y bob — ideal for sprites and headline text
- \`pulse\`: opacity ramp — breathing effect, ambient indicators
- \`scroll-left/right\`: horizontal pan — text that doesn't fit, scene transitions
- \`blink\`: visibility toggle — alerts, status indicators
- \`twinkle\`: sparse color wobble — stars, particles, sparkle elements
- \`drift\`: slow x wander — background objects, atmospheric depth

**Parallax:** Use different \`amplitude\` and \`phase\` values for depth: hero element amplitude=4, mid-ground amplitude=2, background amplitude=1.

**Timing rule:** Float period = totalFrames (default). Phase = 0.5 staggers second element by half a cycle.`,

  'pixel-art': `## Pixel Art Guidance

**Color system:** Max 4–6 colors for clean pixel art. Use the palette array in bitmap elements. Dithering patterns not supported — use value steps instead.

**Scale rules:** At 64px, 1px = 1 LED. Minimum recognizable feature: 2px. Eyes: at least 2×2. Limbs: 2px minimum. Scale ≥ 2 for any detail that needs to read clearly.

**bitmap element:** Use for custom art with explicit palette control. Rows as hex index strings, palette as hex color array. Space or dot = transparent.

**Sprite technique:** \`downsampleSprite\` collapses a sprite sheet to body/dark cell grids — best for character sprites with solid fills. Works from any PNG with transparent background.

**Dark backgrounds:** LEDs don't emit light for unlit pixels. Design with dark backgrounds; your art pops against unlit black.

**Anti-aliasing:** Not available — plan for hard edges. 45-degree diagonals at scale 1 look stairstepped. Scale 2 softens this effect.`,

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
- Reduce frame count (stay at or below 40)
- Increase speed parameter (fewer, slower frames = smoother)
- Avoid more than 3 simultaneous animated elements

**Color not as expected:**
- Use #RRGGBB hex format — named colors are case-sensitive
- resolveColor throws on typos; check the error message for the accepted formats
- LEDs don't reproduce very dark colors (< #202020) well`,
};

export const pixooDesignBrief = tool('pixoo_design_brief', {
  title: 'pixoo_design_brief',
  description:
    'Return craft guidance and live device context for a design topic. Covers legibility rules, palette discipline, layout zones, animation budget, and pre-filled next-tool suggestions based on current device state. The orientation tool to run before authoring a scene, dashboard, or animation — or when troubleshooting display issues.',
  annotations: { readOnlyHint: true },

  input: z.object({
    topic: z
      .enum(['text', 'scene', 'dashboard', 'animation', 'pixel-art', 'troubleshooting'])
      .describe(
        'Design topic: text (styled text guidance), scene (composition + layout zones), dashboard (widgets + metrics), animation (motion budget + effects), pixel-art (bitmap + sprite guidance), troubleshooting (device + display issues).',
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
    nextToolSuggestions: z
      .array(
        z
          .object({
            tool: z.string().describe('Tool name to try next.'),
            rationale: z.string().describe('Why this tool is relevant given current state.'),
            suggestedArgs: z
              .object({})
              .passthrough()
              .optional()
              .describe('Pre-filled argument suggestions as a key-value object.'),
          })
          .describe('A suggested next-step tool with rationale and optional pre-filled args.'),
      )
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

    // Get device state (don't fail if device unreachable)
    const deviceStatus = await svc
      .getStatus(ctx)
      .catch((): import('@/services/pixoo/pixoo-service.js').DeviceStateSnapshot => ({
        reachable: false,
      }));

    // Build next-tool suggestions based on topic + device state
    const suggestions: Array<{
      tool: string;
      rationale: string;
      suggestedArgs?: Record<string, unknown>;
    }> = [];

    if (input.topic === 'text') {
      suggestions.push({
        tool: 'pixoo_display_text',
        rationale: 'The primary tool for styled text rendering.',
        suggestedArgs: {
          text: 'HELLO',
          theme: 'midnight',
          style: { palette: 'lavender', shadow: true, scale: 2 },
          push: deviceStatus.reachable,
        },
      });
      if (!deviceStatus.reachable) {
        suggestions.push({
          tool: 'pixoo_discover_devices',
          rationale: 'Device is not reachable — find it on the network first.',
        });
      }
    } else if (input.topic === 'scene') {
      suggestions.push({
        tool: 'pixoo_compose_scene',
        rationale: 'Full scene composition with layered elements.',
        suggestedArgs: {
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
        tool: 'pixoo_compose_scene',
        rationale: 'Compose a status dashboard with widgets.',
        suggestedArgs: {
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
        tool: 'pixoo_compose_scene',
        rationale: 'Compose an animated scene.',
        suggestedArgs: {
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
          push: deviceStatus.reachable,
        },
      });
    } else if (input.topic === 'troubleshooting') {
      if (!deviceStatus.reachable) {
        suggestions.push({
          tool: 'pixoo_discover_devices',
          rationale: 'Device is not reachable — discover it on the network.',
        });
      } else if (deviceStatus.screenOn === false) {
        suggestions.push({
          tool: 'pixoo_control_device',
          rationale: 'Screen appears to be off.',
          suggestedArgs: { screen: 'on' },
        });
      } else if (deviceStatus.brightness !== undefined && deviceStatus.brightness < 10) {
        suggestions.push({
          tool: 'pixoo_control_device',
          rationale: 'Brightness is very low — content may not be visible.',
          suggestedArgs: { brightness: 80 },
        });
      } else {
        suggestions.push({
          tool: 'pixoo_control_device',
          rationale: 'Read full device state.',
        });
      }
    } else {
      suggestions.push({
        tool: 'pixoo_display_text',
        rationale: 'Start with text display to verify the pipeline works end-to-end.',
        suggestedArgs: { text: 'TEST', push: false },
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
    lines.push('');
    lines.push('## Next Steps');
    for (const s of result.nextToolSuggestions) {
      lines.push(`**${s.tool}**: ${s.rationale}`);
      if (s.suggestedArgs) {
        lines.push('```json');
        lines.push(JSON.stringify(s.suggestedArgs, null, 2));
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
