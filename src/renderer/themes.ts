/**
 * @fileoverview Theme and palette registry for the Pixoo renderer.
 * @module renderer/themes
 */

import type { ColorLike } from '@cyanheads/pixoo-toolkit';

/** A gradient stop pair (from → to). */
export interface GradientStop {
  from: ColorLike;
  to: ColorLike;
}

/** A named palette — either a preset name or a custom gradient stop. */
export type PaletteName = 'ember' | 'ice' | 'neon' | 'fire' | 'lavender' | 'claude' | 'mono';

export const PALETTE_NAMES: PaletteName[] = [
  'ember',
  'ice',
  'neon',
  'fire',
  'lavender',
  'claude',
  'mono',
];

/** Palette gradient stops: top color → bottom color applied as vertical ramp. */
export const PALETTES: Record<PaletteName, GradientStop> = {
  ember: { from: '#ffd700', to: '#cc3300' },
  ice: { from: '#ffffff', to: '#2266cc' },
  neon: { from: '#00ff88', to: '#0044ff' },
  fire: { from: '#ffee00', to: '#cc0000' },
  lavender: { from: '#ffffff', to: '#8866cc' },
  claude: { from: '#ff9955', to: '#cc5522' },
  mono: { from: '#ffffff', to: '#ffffff' },
};

/** A named scene theme. */
export interface ThemeDefinition {
  /** Accent color for icons/highlights. */
  accent: ColorLike;
  /** Background gradient (top → bottom). */
  background:
    | { type: 'gradient-v'; from: ColorLike; to: ColorLike }
    | { type: 'solid'; color: ColorLike };
  /** Default shadow enabled. */
  shadow: boolean;
  /** Default text palette name. */
  textPalette: PaletteName;
}

export type ThemeName = 'midnight' | 'ember' | 'claude' | 'ice' | 'neon' | 'forest' | 'mono';

export const THEME_NAMES: ThemeName[] = [
  'midnight',
  'ember',
  'claude',
  'ice',
  'neon',
  'forest',
  'mono',
];

export const THEMES: Record<ThemeName, ThemeDefinition> = {
  midnight: {
    background: { type: 'gradient-v', from: '#0a0a1e', to: '#000000' },
    textPalette: 'lavender',
    accent: '#6644cc',
    shadow: true,
  },
  ember: {
    background: { type: 'gradient-v', from: '#1a0800', to: '#000000' },
    textPalette: 'ember',
    accent: '#ff6600',
    shadow: true,
  },
  claude: {
    background: { type: 'gradient-v', from: '#1a0d00', to: '#000000' },
    textPalette: 'claude',
    accent: '#ff9955',
    shadow: true,
  },
  ice: {
    background: { type: 'gradient-v', from: '#001030', to: '#000820' },
    textPalette: 'ice',
    accent: '#4488ff',
    shadow: true,
  },
  neon: {
    background: { type: 'gradient-v', from: '#001810', to: '#000000' },
    textPalette: 'neon',
    accent: '#00ff88',
    shadow: true,
  },
  forest: {
    background: { type: 'gradient-v', from: '#001800', to: '#000800' },
    textPalette: 'neon',
    accent: '#44cc44',
    shadow: false,
  },
  mono: {
    background: { type: 'solid', color: '#000000' },
    textPalette: 'mono',
    accent: '#ffffff',
    shadow: false,
  },
};
