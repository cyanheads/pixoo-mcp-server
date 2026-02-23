/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

import { pixooComposeTool } from './pixoo-compose.tool.js';
import { pixooControlTool } from './pixoo-control.tool.js';
import { pixooPushImageTool } from './pixoo-push-image.tool.js';
import { pixooTextTool } from './pixoo-text.tool.js';

/**
 * An array containing all tool definitions for easy iteration.
 */
export const allToolDefinitions = [
  pixooComposeTool,
  pixooControlTool,
  pixooPushImageTool,
  pixooTextTool,
];
