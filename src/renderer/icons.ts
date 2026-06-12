/**
 * @fileoverview Built-in icon registry with SVG path data by category.
 * @module renderer/icons
 */

/** A single icon entry. */
export interface IconEntry {
  category: string;
  /** SVG d attribute for the icon path. */
  d: string;
  name: string;
  /** viewBox string (default "0 0 16 16"). */
  viewBox: string;
}

/** All icons indexed by name. */
export const ICONS: Record<string, IconEntry> = {
  // --- weather ---
  sun: {
    name: 'sun',
    category: 'weather',
    d: 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1v2M8 13v2M3.22 3.22l1.41 1.41M11.37 11.37l1.41 1.41M1 8h2M13 8h2M3.22 12.78l1.41-1.41M11.37 4.63l1.41-1.41',
    viewBox: '0 0 16 16',
  },
  cloud: {
    name: 'cloud',
    category: 'weather',
    d: 'M13 10a3 3 0 0 0-3-3h-.5A4.5 4.5 0 1 0 3 10h10z',
    viewBox: '0 0 16 16',
  },
  rain: {
    name: 'rain',
    category: 'weather',
    d: 'M13 8a3 3 0 0 0-3-3h-.5A4.5 4.5 0 1 0 3 8h10zM5 12l-1 3M8 12v3M11 12l1 3',
    viewBox: '0 0 16 16',
  },
  snow: {
    name: 'snow',
    category: 'weather',
    d: 'M8 1v14M3.5 4l9 8M12.5 4l-9 8M1 8h14M3 5.5l-2-2M13 5.5l2-2M3 10.5l-2 2M13 10.5l2 2',
    viewBox: '0 0 16 16',
  },
  wind: {
    name: 'wind',
    category: 'weather',
    d: 'M1 6h8a2 2 0 1 0-2-2M1 10h12a2 2 0 1 1-2 2M1 8h6',
    viewBox: '0 0 16 16',
  },
  lightning: {
    name: 'lightning',
    category: 'weather',
    d: 'M9 1L4 9h5l-2 6 7-8H9z',
    viewBox: '0 0 16 16',
  },
  // --- arrows ---
  'arrow-up': {
    name: 'arrow-up',
    category: 'arrows',
    d: 'M8 2L8 14M3 7l5-5 5 5',
    viewBox: '0 0 16 16',
  },
  'arrow-down': {
    name: 'arrow-down',
    category: 'arrows',
    d: 'M8 14L8 2M3 9l5 5 5-5',
    viewBox: '0 0 16 16',
  },
  'arrow-left': {
    name: 'arrow-left',
    category: 'arrows',
    d: 'M2 8L14 8M7 3L2 8l5 5',
    viewBox: '0 0 16 16',
  },
  'arrow-right': {
    name: 'arrow-right',
    category: 'arrows',
    d: 'M14 8L2 8M9 3L14 8l-5 5',
    viewBox: '0 0 16 16',
  },
  // --- status ---
  'check-circle': {
    name: 'check-circle',
    category: 'status',
    d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM5 8l2 2 4-4',
    viewBox: '0 0 16 16',
  },
  'x-circle': {
    name: 'x-circle',
    category: 'status',
    d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM5 5l6 6M11 5l-6 6',
    viewBox: '0 0 16 16',
  },
  'alert-circle': {
    name: 'alert-circle',
    category: 'status',
    d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM8 5v4M8 11v1',
    viewBox: '0 0 16 16',
  },
  info: {
    name: 'info',
    category: 'status',
    d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM8 7v5M8 5v1',
    viewBox: '0 0 16 16',
  },
  heart: {
    name: 'heart',
    category: 'status',
    d: 'M8 13S1 9 1 4.5a3.5 3.5 0 0 1 7 0 3.5 3.5 0 0 1 7 0C15 9 8 13 8 13z',
    viewBox: '0 0 16 16',
  },
  star: {
    name: 'star',
    category: 'status',
    d: 'M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5z',
    viewBox: '0 0 16 16',
  },
  // --- media ---
  play: {
    name: 'play',
    category: 'media',
    d: 'M3 2l10 6-10 6z',
    viewBox: '0 0 16 16',
  },
  pause: {
    name: 'pause',
    category: 'media',
    d: 'M5 2h2v12H5zM9 2h2v12H9z',
    viewBox: '0 0 16 16',
  },
  stop: {
    name: 'stop',
    category: 'media',
    d: 'M3 3h10v10H3z',
    viewBox: '0 0 16 16',
  },
  music: {
    name: 'music',
    category: 'media',
    d: 'M12 2v7a2 2 0 1 1-2-2V2l-6 1v7a2 2 0 1 1-2-2V3z',
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
