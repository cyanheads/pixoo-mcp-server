/**
 * @fileoverview The post-render push path shared by the three push tools: keep the
 * rendered preview when a push fails, and flag a successful push the panel won't show.
 * @module mcp-server/tools/device-push
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { type PreviewWriter, saveTempPreview } from '@/renderer/preview.js';
import type { DeviceStateSnapshot } from '@/services/pixoo/pixoo-service.js';

/** Brightness at or below this reads as dark on the panel. */
export const DIM_BRIGHTNESS = 10;

/**
 * Run a device push. A failed push rethrows its typed error — code, `reason`,
 * `retryable`, and recovery hint untouched — with the preview's path added as
 * `data.outputFiles` and named in the message: the files this call already saved, or
 * a copy written under the OS temp dir when it saved none. Error results carry no
 * `ctx.content` blocks, so the file is how the render outlives the failure.
 */
export async function pushKeepingPreview(
  push: () => Promise<DeviceStateSnapshot>,
  savedFiles: string[],
  writePreview: PreviewWriter,
): Promise<DeviceStateSnapshot> {
  try {
    return await push();
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    const outputFiles = savedFiles.length > 0 ? savedFiles : [await saveTempPreview(writePreview)];
    throw new McpError(
      err.code,
      `${err.message.replace(/[^.!?]$/, '$&.')} Rendered preview saved to ${outputFiles.join(', ')}.`,
      { ...err.data, outputFiles },
      { cause: err },
    );
  }
}

/**
 * Name every reason a pushed render may not show on the panel, each with the call
 * that fixes it. Undefined when the device reads as visible, or when the read-back
 * never reached it and there is nothing to judge.
 */
export function visibilityNotice(state: DeviceStateSnapshot): string | undefined {
  if (!state.reachable) return;
  const problems: string[] = [];
  if (state.screenOn === false) {
    problems.push('the screen is off (pixoo_control_device with screen: "on")');
  }
  if (state.brightness !== undefined && state.brightness <= DIM_BRIGHTNESS) {
    problems.push(`brightness is ${state.brightness} (pixoo_control_device with brightness: 80)`);
  }
  if (state.channel !== undefined && state.channel !== 'custom') {
    problems.push(
      `the device is on the ${state.channel} channel (pixoo_control_device with channel: "custom")`,
    );
  }
  if (problems.length === 0) return;
  return `Pushed, but the render may not be visible: ${problems.join('; ')}.`;
}
