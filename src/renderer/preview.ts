/**
 * @fileoverview Preview encoding utilities: PNG content blocks, contact sheets, GIF saving.
 * @module renderer/preview
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Canvas, canvasToPng, saveAnimationGif } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';

/** MCP image content block. */
export interface ImageContentBlock {
  data: string;
  mimeType: 'image/png' | 'image/gif';
  type: 'image';
}

/** Output files record. */
export interface OutputFiles {
  gif?: string;
  preview?: string;
}

/** Encode a single canvas as a base64 PNG content block (8× upscaled → 512px). */
export function encodePreviewBlock(canvas: Canvas): ImageContentBlock {
  const pngBuffer = canvasToPng(canvas, 8);
  const base64 = Buffer.from(pngBuffer).toString('base64');
  return { type: 'image', data: base64, mimeType: 'image/png' };
}

/**
 * Build a contact-sheet preview from animation frames.
 * Returns the middle frame encoded as a PNG (works universally across MCP clients).
 */
export function buildContactSheet(frames: Canvas[]): ImageContentBlock {
  // Return the middle frame as a representative preview
  const midFrame = frames[Math.floor(frames.length / 2)] ?? frames[0];
  if (!midFrame) {
    // Empty frame set — return a black canvas
    const fallback = new Canvas(64);
    return encodePreviewBlock(fallback);
  }
  return encodePreviewBlock(midFrame);
}

/**
 * Optionally save a preview PNG to PIXOO_OUTPUT_DIR.
 * Returns the saved path, or undefined if no output dir is configured.
 */
export async function savePngPreview(
  canvas: Canvas,
  baseName: string,
): Promise<string | undefined> {
  const cfg = getServerConfig();
  if (!cfg.pixooOutputDir) return;
  await fs.mkdir(cfg.pixooOutputDir, { recursive: true });
  const filePath = path.join(cfg.pixooOutputDir, `${baseName}.png`);
  const { savePng } = await import('@cyanheads/pixoo-toolkit');
  await savePng(canvas, filePath, 8);
  return filePath;
}

/**
 * Optionally save an animation GIF to PIXOO_OUTPUT_DIR.
 * Returns the saved path, or undefined if no output dir is configured.
 */
export async function saveGifPreview(
  frames: Canvas[],
  speed: number,
  baseName: string,
): Promise<string | undefined> {
  const cfg = getServerConfig();
  if (!cfg.pixooOutputDir) return;
  await fs.mkdir(cfg.pixooOutputDir, { recursive: true });
  const filePath = path.join(cfg.pixooOutputDir, `${baseName}.gif`);
  await saveAnimationGif(frames, filePath, speed, 8);
  return filePath;
}
