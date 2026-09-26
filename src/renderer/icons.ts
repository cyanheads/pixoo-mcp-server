/**
 * @fileoverview Built-in icon registry with SVG path data by category.
 * @module renderer/icons
 */

/**
 * An icon's SVG path data, split by how each part draws. `fill` subpaths rasterize with the
 * even-odd rule; `stroke` subpaths draw as 1-pixel lines along their segments — the parts
 * designed as outlines, since a line has no area for a fill to cover.
 */
export type IconPaths = { fill: string; stroke?: string } | { fill?: undefined; stroke: string };

/** A single icon entry. */
export type IconEntry = IconPaths & {
  category: string;
  name: string;
  /** viewBox string (default "0 0 16 16"). */
  viewBox: string;
};

/** The circle every status badge is drawn around, as a stroke. */
const STATUS_RING = 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z';

/** All icons indexed by name. */
export const ICONS: Record<string, IconEntry> = {
  // --- weather ---
  sun: {
    name: 'sun',
    category: 'weather',
    fill: 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    stroke:
      'M8 1v2M8 13v2M3.22 3.22l1.41 1.41M11.37 11.37l1.41 1.41M1 8h2M13 8h2M3.22 12.78l1.41-1.41M11.37 4.63l1.41-1.41',
    viewBox: '0 0 16 16',
  },
  cloud: {
    name: 'cloud',
    category: 'weather',
    fill: 'M13 10a3 3 0 0 0-3-3h-.5A4.5 4.5 0 1 0 3 10h10z',
    viewBox: '0 0 16 16',
  },
  rain: {
    name: 'rain',
    category: 'weather',
    fill: 'M13 8a3 3 0 0 0-3-3h-.5A4.5 4.5 0 1 0 3 8h10z',
    stroke: 'M5 12l-1 3M8 12v3M11 12l1 3',
    viewBox: '0 0 16 16',
  },
  snow: {
    name: 'snow',
    category: 'weather',
    stroke: 'M8 1v14M3.5 4l9 8M12.5 4l-9 8M1 8h14M3 5.5l-2-2M13 5.5l2-2M3 10.5l-2 2M13 10.5l2 2',
    viewBox: '0 0 16 16',
  },
  wind: {
    name: 'wind',
    category: 'weather',
    stroke: 'M1 6h8a2 2 0 1 0-2-2M1 10h12a2 2 0 1 1-2 2M1 8h6',
    viewBox: '0 0 16 16',
  },
  lightning: {
    name: 'lightning',
    category: 'weather',
    fill: 'M9 1L4 9h5l-2 6 7-8H9z',
    viewBox: '0 0 16 16',
  },
  // --- arrows: a filled head on a stroked shaft ---
  'arrow-up': {
    name: 'arrow-up',
    category: 'arrows',
    fill: 'M3 7l5-5 5 5',
    stroke: 'M8 2L8 14',
    viewBox: '0 0 16 16',
  },
  'arrow-down': {
    name: 'arrow-down',
    category: 'arrows',
    fill: 'M3 9l5 5 5-5',
    stroke: 'M8 14L8 2',
    viewBox: '0 0 16 16',
  },
  'arrow-left': {
    name: 'arrow-left',
    category: 'arrows',
    fill: 'M7 3L2 8l5 5',
    stroke: 'M2 8L14 8',
    viewBox: '0 0 16 16',
  },
  'arrow-right': {
    name: 'arrow-right',
    category: 'arrows',
    fill: 'M9 3L14 8l-5 5',
    stroke: 'M14 8L2 8',
    viewBox: '0 0 16 16',
  },
  // --- status: a stroked ring around a stroked mark, so the mark shows ---
  'check-circle': {
    name: 'check-circle',
    category: 'status',
    stroke: `${STATUS_RING}M5 8l2 2 4-4`,
    viewBox: '0 0 16 16',
  },
  'x-circle': {
    name: 'x-circle',
    category: 'status',
    stroke: `${STATUS_RING}M5 5l6 6M11 5l-6 6`,
    viewBox: '0 0 16 16',
  },
  'alert-circle': {
    name: 'alert-circle',
    category: 'status',
    stroke: `${STATUS_RING}M8 5v4M8 11v1`,
    viewBox: '0 0 16 16',
  },
  info: {
    name: 'info',
    category: 'status',
    stroke: `${STATUS_RING}M8 8v4M8 5v1`,
    viewBox: '0 0 16 16',
  },
  heart: {
    name: 'heart',
    category: 'status',
    fill: 'M8 13S1 9 1 4.5a3.5 3.5 0 0 1 7 0 3.5 3.5 0 0 1 7 0C15 9 8 13 8 13z',
    viewBox: '0 0 16 16',
  },
  star: {
    name: 'star',
    category: 'status',
    fill: 'M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5z',
    viewBox: '0 0 16 16',
  },
  // --- media ---
  play: {
    name: 'play',
    category: 'media',
    fill: 'M3 2l10 6-10 6z',
    viewBox: '0 0 16 16',
  },
  pause: {
    name: 'pause',
    category: 'media',
    fill: 'M5 2h2v12H5zM9 2h2v12H9z',
    viewBox: '0 0 16 16',
  },
  stop: {
    name: 'stop',
    category: 'media',
    fill: 'M3 3h10v10H3z',
    viewBox: '0 0 16 16',
  },
  music: {
    name: 'music',
    category: 'media',
    fill: 'M12 2v7a2 2 0 1 1-2-2V4l-6 1v5a2 2 0 1 1-2-2V3z',
    viewBox: '0 0 16 16',
  },
};

export const ICON_NAMES = Object.keys(ICONS);

export const ICON_CATEGORIES = [...new Set(Object.values(ICONS).map((i) => i.category))];

/** Get icons grouped by category. */
export function getIconsByCategory(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const icon of Object.values(ICONS)) {
    if (!result[icon.category]) result[icon.category] = [];
    result[icon.category]?.push(icon.name);
  }
  return result;
}
