/**
 * @fileoverview Tool definition for 'pixoo_text'.
 * Pushes native on-device scrolling text via Draw/SendHttpText, or clears
 * a text overlay slot. Text overlays persist across channel switches.
 * @module src/mcp-server/tools/definitions/pixoo-text.tool
 */
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
import { resolveColor } from '@cyanheads/pixoo-toolkit';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
const TOOL_NAME = 'pixoo_text';
const TOOL_TITLE = 'Pixoo Text';
const TOOL_DESCRIPTION =
  "Push native on-device scrolling text overlay via the device's built-in fonts. Overlays render on top of the current display content and persist across channel switches. Use different IDs (0–19) to stack multiple overlays. Set clear=true to remove an overlay.";

const TOOL_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------
// Direction / Align mappings
// ---------------------------------------------------------------------------
const DIRECTION_MAP = { left: 0, right: 1 } as const;
const ALIGN_MAP = { left: 1, center: 2, right: 3 } as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const InputSchema = z
  .object({
    text: z.string().min(1).describe('Text string to display.'),
    id: z
      .number()
      .int()
      .min(0)
      .max(19)
      .default(0)
      .describe(
        'Text overlay ID (0–19). Use different IDs to stack multiple overlays.',
      ),
    x: z.number().int().default(0).describe('X position in pixels.'),
    y: z.number().int().default(0).describe('Y position in pixels.'),
    direction: z
      .enum(['left', 'right'])
      .default('left')
      .describe("Scroll direction ('left' | 'right')."),
    font: z
      .number()
      .int()
      .min(0)
      .max(114)
      .default(0)
      .describe(
        'Device font ID (0–114). Notable: 18 = arrow glyphs, 20 = °C/°F symbols.',
      ),
    width: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Scrolling area width in pixels. Defaults to display size.'),
    speed: z
      .number()
      .int()
      .min(0)
      .default(50)
      .describe('Scroll speed (higher = faster).'),
    color: z
      .string()
      .default('white')
      .describe("Text color (hex '#RRGGBB' or named color)."),
    align: z
      .enum(['left', 'center', 'right'])
      .default('left')
      .describe("Text alignment ('left' | 'center' | 'right')."),
    clear: z
      .boolean()
      .default(false)
      .describe(
        'If true, clears the text overlay at the given ID instead of setting it.',
      ),
  })
  .describe('Push scrolling text overlay to the Pixoo device.');

const OutputSchema = z
  .object({
    id: z.number().describe('Text overlay slot used.'),
    action: z
      .enum(['set', 'cleared'])
      .describe('Whether text was set or cleared.'),
    text: z.string().optional().describe('Text that was displayed.'),
  })
  .describe('Result of the text overlay operation.');

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------
async function textLogic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const client = container.resolve(PixooClientToken);
  const config = container.resolve(AppConfig);

  logger.debug('pixoo_text invoked', { ...appContext, toolInput: input });

  if (input.clear) {
    await client.clearText(input.id);
    return { id: input.id, action: 'cleared' };
  }

  const color = resolveColor(input.color);

  await client.sendText({
    id: input.id,
    x: input.x,
    y: input.y,
    text: input.text,
    dir: DIRECTION_MAP[input.direction],
    font: input.font,
    width: input.width ?? config.pixoo.size,
    speed: input.speed,
    color,
    align: ALIGN_MAP[input.align],
  });

  return { id: input.id, action: 'set', text: input.text };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------
function responseFormatter(result: Output): ContentBlock[] {
  const msg =
    result.action === 'cleared'
      ? `Cleared text overlay ${result.id}`
      : `Set text overlay ${result.id}: "${result.text}"`;
  return [{ type: 'text', text: msg }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const pixooTextTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:pixoo:write'], textLogic),
  responseFormatter,
};
