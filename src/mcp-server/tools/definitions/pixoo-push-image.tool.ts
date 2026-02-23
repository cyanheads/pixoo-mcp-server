/**
 * @fileoverview Tool definition for 'pixoo_push_image'.
 * Loads a single image file, resizes to the display grid, and pushes to device.
 * Automatically switches the device to the custom channel before pushing.
 * @module src/mcp-server/tools/definitions/pixoo-push-image.tool
 */
import { mkdir } from 'node:fs/promises';

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/index.js';
import { AppConfig, PixooClientToken } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/index.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { type RequestContext, logger } from '@/utils/index.js';
import {
  Channel,
  type PixooSize,
  loadImage,
  savePng,
} from '@cyanheads/pixoo-toolkit';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
const TOOL_NAME = 'pixoo_push_image';
const TOOL_TITLE = 'Pixoo Push Image';
const TOOL_DESCRIPTION =
  'Load a single image file (PNG, JPEG, WebP, GIF, AVIF, TIFF, SVG), resize to the display grid, and push to the Pixoo device. Automatically switches to the custom channel.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const FIT_OPTIONS = ['contain', 'cover', 'fill'] as const;
const KERNEL_OPTIONS = ['nearest', 'lanczos3', 'mitchell'] as const;

const InputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Absolute path to image file (PNG, JPEG, WebP, GIF, AVIF, TIFF, SVG).',
      ),
    fit: z
      .enum(FIT_OPTIONS)
      .default('contain')
      .describe(
        "Resize mode: 'contain' (default, fit within bounds), 'cover' (fill and crop), 'fill' (stretch).",
      ),
    kernel: z
      .enum(KERNEL_OPTIONS)
      .default('nearest')
      .describe(
        "Resize interpolation: 'nearest' (default, pixel art), 'lanczos3' (photos), 'mitchell' (balanced).",
      ),
  })
  .describe('Push a single image to the Pixoo display.');

const OutputSchema = z
  .object({
    path: z.string().describe('Path of the image that was loaded.'),
    size: z.number().describe('Display size in pixels.'),
    fit: z.string().describe('Resize mode used.'),
    kernel: z.string().describe('Interpolation kernel used.'),
    outputFile: z
      .string()
      .optional()
      .describe('Path of the auto-saved preview PNG.'),
  })
  .describe('Result after pushing image to device.');

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------
async function pushImageLogic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const client = container.resolve(PixooClientToken);
  const config = container.resolve(AppConfig);
  const size = config.pixoo.size as PixooSize;

  logger.debug('pixoo_push_image invoked', {
    ...appContext,
    toolInput: input,
  });

  // Switch to custom channel so pushed content is visible
  await client.setChannel(Channel.Custom);

  const canvas = await loadImage(input.path, {
    size,
    fit: input.fit,
    kernel: input.kernel,
  });

  await client.push(canvas);

  // Auto-save preview if output directory is configured
  let outputFile: string | undefined;
  if (config.pixoo.outputDir) {
    const dir = config.pixoo.outputDir;
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    outputFile = `${dir}/push-image-${ts}.png`;
    await savePng(canvas, outputFile);
  }

  return {
    path: input.path,
    size,
    fit: input.fit,
    kernel: input.kernel,
    outputFile,
  };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------
function responseFormatter(result: Output): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `Pushed image to ${result.size}x${result.size} display (fit=${result.fit}, kernel=${result.kernel})`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const pixooPushImageTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:pixoo:write'], pushImageLogic),
  responseFormatter,
};
