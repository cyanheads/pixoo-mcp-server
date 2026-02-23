/**
 * @fileoverview Tool definition for 'pixoo_control'.
 * Reads or changes device settings (brightness, screen, channel, clock face).
 * Call with no parameters to read current config.
 * @module src/mcp-server/tools/definitions/pixoo-control.tool
 */
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/index.js';
import { PixooClientToken } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/index.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { type RequestContext, logger, markdown } from '@/utils/index.js';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
const TOOL_NAME = 'pixoo_control';
const TOOL_TITLE = 'Pixoo Control';
const TOOL_DESCRIPTION =
  'Read or change Pixoo device settings. Call with no parameters to read current config. Returns current config (brightness, channel, screen state, display size) regardless of whether changes were made.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  idempotentHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------
// Channel mapping
// ---------------------------------------------------------------------------
const CHANNELS = ['faces', 'cloud', 'visualizer', 'custom'] as const;
type ChannelName = (typeof CHANNELS)[number];
const CHANNEL_INDEX: Record<ChannelName, number> = {
  faces: 0,
  cloud: 1,
  visualizer: 2,
  custom: 3,
};
const CHANNEL_NAME_BY_INDEX: Record<number, ChannelName> = {
  0: 'faces',
  1: 'cloud',
  2: 'visualizer',
  3: 'custom',
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const InputSchema = z
  .object({
    brightness: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Display brightness (0–100).'),
    screen: z
      .enum(['on', 'off'])
      .optional()
      .describe("Turn display on or off ('on' | 'off')."),
    channel: z
      .enum(CHANNELS)
      .optional()
      .describe(
        "Active channel ('faces' | 'cloud' | 'visualizer' | 'custom').",
      ),
    clock_face_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Clock face ID (only applies on faces channel).'),
  })
  .describe('Read or change Pixoo device settings.');

const OutputSchema = z
  .object({
    brightness: z.number().describe('Current brightness (0–100).'),
    channel: z.string().describe('Current active channel name.'),
    channelIndex: z.number().describe('Current active channel index.'),
    screenOn: z.boolean().describe('Whether the display is on.'),
    clockId: z.number().describe('Current clock face ID.'),
    applied: z
      .array(z.string())
      .describe('List of settings that were changed.'),
  })
  .describe('Current device config after applying any changes.');

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------
async function controlLogic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const client = container.resolve(PixooClientToken);
  const applied: string[] = [];

  logger.debug('pixoo_control invoked', { ...appContext, toolInput: input });

  if (input.brightness !== undefined) {
    await client.setBrightness(input.brightness);
    applied.push(`brightness=${input.brightness}`);
  }

  if (input.screen !== undefined) {
    await client.setScreen(input.screen === 'on');
    applied.push(`screen=${input.screen}`);
  }

  if (input.channel !== undefined) {
    await client.setChannel(CHANNEL_INDEX[input.channel]);
    applied.push(`channel=${input.channel}`);
  }

  if (input.clock_face_id !== undefined) {
    await client.setClock(input.clock_face_id);
    applied.push(`clock_face_id=${input.clock_face_id}`);
  }

  const config = await client.getConfig();

  return {
    brightness: config.Brightness,
    channel:
      CHANNEL_NAME_BY_INDEX[config.SelectIndex] ??
      `unknown(${config.SelectIndex})`,
    channelIndex: config.SelectIndex,
    screenOn: config.LightSwitch === 1,
    clockId: config.CurClockId,
    applied,
  };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------
function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown()
    .text(`Brightness: ${result.brightness}%`)
    .text(`\nChannel: ${result.channel} (${result.channelIndex})`)
    .text(`\nScreen: ${result.screenOn ? 'on' : 'off'}`)
    .text(`\nClock ID: ${result.clockId}`);

  md.when(result.applied.length > 0, () => {
    md.text(`\nApplied: ${result.applied.join(', ')}`);
  });

  return [{ type: 'text', text: md.build() }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const pixooControlTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:pixoo:read'], controlLogic),
  responseFormatter,
};
