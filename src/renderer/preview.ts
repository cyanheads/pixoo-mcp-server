/**
 * @fileoverview Preview encoding utilities: PNG content blocks, contact sheets, and the
 * PNG/GIF preview files written to PIXOO_OUTPUT_DIR or a temp directory.
 * @module renderer/preview
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Canvas, canvasToPng, saveAnimationGif, savePng } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';

/** MCP image content block. */
export interface ImageContentBlock {
  data: string;
  mimeType: 'image/png' | 'image/gif';
  type: 'image';
}

/** Writes a render's preview file into `dir` and resolves to the file's path. */
export type PreviewWriter = (dir: string) => Promise<string>;

/** Edge length, in pixels, a preview image is scaled toward. */
const PREVIEW_BUDGET_PX = 512;

/** Gutter between contact-sheet tiles, which also fills the grid's unused cells. */
const SHEET_GAP_PX = 2;
const SHEET_GAP_COLOR = { r: 48, g: 48, b: 48 };

/** Encode a single canvas as a base64 PNG content block (8× upscaled → 512px). */
export function encodePreviewBlock(canvas: Canvas): ImageContentBlock {
  const pngBuffer = canvasToPng(canvas, 8);
  const base64 = Buffer.from(pngBuffer).toString('base64');
  return { type: 'image', data: base64, mimeType: 'image/png' };
}

/**
 * Build a contact-sheet preview: every frame, in order, tiled left-to-right and
 * top-to-bottom in a `ceil(sqrt(n))`-column grid, each tile an integer upscale that
 * keeps the sheet within the 512px preview budget. A single frame encodes exactly as
 * {@link encodePreviewBlock} does.
 */
export async function buildContactSheet(frames: Canvas[]): Promise<ImageContentBlock> {
  const [first] = frames;
  if (!first || frames.length === 1) return encodePreviewBlock(first ?? new Canvas(64));

  const cols = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / cols);
  const scale = Math.max(
    1,
    Math.floor((PREVIEW_BUDGET_PX - (cols - 1) * SHEET_GAP_PX) / (cols * first.width)),
  );
  const pitch = first.width * scale + SHEET_GAP_PX;

  const { default: sharp } = await import('sharp');
  const png = await sharp({
    create: {
      width: cols * pitch - SHEET_GAP_PX,
      height: rows * pitch - SHEET_GAP_PX,
      channels: 3,
      background: SHEET_GAP_COLOR,
    },
  })
    .composite(
      frames.map((frame, i) => ({
        input: Buffer.from(canvasToPng(frame, scale)),
        left: (i % cols) * pitch,
        top: Math.floor(i / cols) * pitch,
      })),
    )
    .png()
    .toBuffer();
  return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
}

/** Save a canvas as an 8× upscaled PNG in `dir`; returns the saved path. */
export async function savePngPreview(
  canvas: Canvas,
  dir: string,
  baseName: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${baseName}.png`);
  await savePng(canvas, filePath, 8);
  return filePath;
}

/** Save animation frames as an 8× upscaled GIF in `dir`; returns the saved path. */
export async function saveGifPreview(
  frames: Canvas[],
  speed: number,
  dir: string,
  baseName: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${baseName}.gif`);
  await saveAnimationGif(frames, filePath, speed, 8);
  return filePath;
}

/** Write the preview into PIXOO_OUTPUT_DIR when one is configured; returns the paths written. */
export async function autoSavePreview(write: PreviewWriter): Promise<string[]> {
  const dir = getServerConfig().pixooOutputDir;
  return dir ? [await write(dir)] : [];
}

/** Write the preview into a fresh directory under the OS temp dir; returns its path. */
export async function saveTempPreview(write: PreviewWriter): Promise<string> {
  return write(await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-preview-')));
}
