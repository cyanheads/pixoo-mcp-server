/**
 * @fileoverview pixoo://reference/design-guide resource — long-form 64px craft guide.
 * @module mcp-server/resources/definitions/pixoo-design-guide.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

const DESIGN_GUIDE = `# Pixoo Display Design Guide

## Legibility Floors

At typical viewing distance for a 64×64 LED display:

- **1px features vanish** — single-pixel details are not reliably visible at arm's length
- **Minimum eye size:** 1–2px across; 2×2 fills are more reliable than single pixels
- **Minimum limb gap:** 2 rows between horizontal elements prevents blur
- **Font choices:**
  - Standard (5×7): default for all text. Readable at 1× scale. Excellent at 2× (10px tall = chunky block letters)
  - Compact (3×5): secondary text, captions, labels when space is tight
  - Scale ≥2: decorative or hero use only — verify fit before pushing

## Palette Discipline

**4–6 colors maximum** for clean, intentional designs. More creates visual noise at this resolution.

**Value contrast over hue contrast.** Two colors with similar brightness blur into each other on LED displays even if their hues differ dramatically. Always check light/dark contrast, not just color difference.

**Warm whites (#f0ead6) outperform pure white (#ffffff)** against the warm tint of LED panels. Pure white can appear cold or wash out.

**Background darkness rule:** LED pixels only add light; black = unlit. Design with very dark backgrounds (lightness < 20%). Art and text pop against unlit black in ways impossible on lit screens.

**Named palettes (vertical gradient ramps):**
- \`ember\`: gold → deep orange — warmth, energy, alerts
- \`ice\`: white → blue — cool, calm, technical
- \`neon\`: green → blue — digital, matrix, hacker
- \`fire\`: yellow → red — heat, danger, excitement
- \`lavender\`: white → lavender — gentle, night sky, premium
- \`claude\`: warm orange ramp — AI assistant branding
- \`mono\`: single color (no gradient) — flat emphasis

## Layout Zones (64×64)

| Zone | Rows | Use |
|------|------|-----|
| Top strip | 0–15 | Status icons, small indicators, labels |
| Middle band | 16–47 | Hero content: large text, sprites, charts |
| Bottom strip | 48–63 | Captions, timestamps, small metrics |

**Semantic positioning:** Use \`x: "center"\`, \`x: "right"\`, \`y: "bottom"\` instead of manual pixel math. The renderer handles alignment automatically.

## Animation Budget

- **40 frames maximum** — device becomes unstable beyond this
- **20 frames at 150ms ≈ 3s loop** — documented sweet spot for ambient scenes
- **10 frames at 100ms ≈ 1s loop** — snappy, responsive animations
- **~5s device "Loading..." overlay** when a new animation starts — expected behavior

**Motion hierarchy (one hero + ≤2 ambient effects):**
- Hero motion: the main focal element (large text, central sprite)
- Ambient: background elements, accent particles, status indicators
- More than 3 simultaneous animated elements creates visual noise at 64px

**Parallax depth with staggered phases:**
\`\`\`json
{ "effect": { "name": "float", "amplitude": 4 } }   // foreground hero
{ "effect": { "name": "float", "amplitude": 2, "phase": 0.25 } }  // midground
{ "effect": { "name": "float", "amplitude": 1, "phase": 0.5 } }   // background
\`\`\`

**Parallax speeds:** foreground amplitude 4, midground 2, background 1. Phase offsets create natural breathing motion.

## Effect Preset Reference

| Effect | Best For | Key Params |
|--------|----------|------------|
| \`float\` | Sprites, headlines | amplitude (px bob), period (frames), phase (0–1) |
| \`scroll-left/right\` | Long text, scene pans | amplitude (speed multiplier) |
| \`pulse\` | Indicators, emphasis | amplitude, period |
| \`blink\` | Alerts, status | period |
| \`twinkle\` | Stars, particles | amplitude, period |
| \`drift\` | Background objects | amplitude (x wander) |
| \`fade-in\` | Scene intros | — |
| \`fade-out\` | Scene exits | — |

## Pixel Art Rules

- **Max 4–6 colors** per sprite/bitmap for clean art
- **Minimum 2×2 for any recognizable feature** — eyes, buttons, icons
- **45-degree diagonals staircase** at scale 1. Scale 2 softens this. Plan for hard edges.
- **Use bitmap elements** for custom art with full palette control
- **Use sprite elements** for character sprites from PNG source files
- **Transparent backgrounds** on source PNGs allow clean compositing over scene backgrounds

## Push Pacing

- **~1 push per second** is the device's comfortable rate
- **~300 rapid pushes** can cause the device to freeze — restart fixes it
- **Server enforces minimum interval** (default: 1000ms) between pushes
- **Animations** count as one push regardless of frame count

## Known Device Behaviors

- **Channel must be Custom** to display pushed content. The server auto-switches when pushing.
- **getConfig() omits SelectIndex** on current Pixoo-64 firmware — use getChannel() for reliable channel reads
- **Text overlays (pixoo_overlay_text)** persist across channel switches until explicitly cleared
- **Discovery requires internet** — Divoom cloud endpoint even for local device control
`;

export const pixooDesignGuideResource = resource('pixoo://reference/design-guide', {
  name: 'design-guide',
  title: 'Pixoo Design Guide',
  description:
    'Long-form 64px craft guide: legibility floors, palette discipline, layout zones, animation budget, pixel art rules, and known device behaviors. Read this before composing scenes or troubleshooting display quality.',
  mimeType: 'text/markdown',
  params: z.object({}),

  handler(_params, _ctx) {
    return DESIGN_GUIDE;
  },

  list: async () => ({
    resources: [
      {
        uri: 'pixoo://reference/design-guide',
        name: 'design-guide',
        mimeType: 'text/markdown',
        description:
          'Long-form 64px craft guide: legibility, palettes, layout, animation, pixel art.',
      },
    ],
  }),
});
