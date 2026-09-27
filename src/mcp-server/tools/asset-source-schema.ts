/**
 * @fileoverview Inputs that name an image asset: the image `source` of pixoo_push_image
 * and of a scene `image` element, and a scene `sprite` element's `path`. Each must be a
 * URL or an absolute local path — a relative path would resolve against the server's
 * working directory, which a caller cannot see.
 * @module mcp-server/tools/asset-source-schema
 */

import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { isRemoteSource } from '@/renderer/remote-image.js';

/**
 * True for a value that names the same asset whatever the server's working directory.
 * An http URL passes: the loaders refuse it as `asset_not_found` with a message naming
 * the https requirement, as they refuse a sprite path given as any URL.
 */
const namesAssetAbsolutely = (value: string): boolean =>
  isRemoteSource(value) || path.isAbsolute(value);

/** An image source: an absolute local path or an https URL. */
export const ImageSourceSchema = z.string().refine(namesAssetAbsolutely, {
  error:
    'Must be an absolute local path or an https URL, not a relative path, a ~ path, or a file:// URL.',
});

/** A sprite sheet path: an absolute local path. */
export const SpritePathSchema = z.string().refine(namesAssetAbsolutely, {
  error: 'Must be an absolute local path, not a relative path, a ~ path, or a file:// URL.',
});
