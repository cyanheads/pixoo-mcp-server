/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

// Pixoo device tools
import { pixooComposeTool } from './pixoo-compose.tool.js';
import { pixooControlTool } from './pixoo-control.tool.js';
import { pixooPushImageTool } from './pixoo-push-image.tool.js';
import { pixooTextTool } from './pixoo-text.tool.js';
// Template tools
import { catFactTool } from './template-cat-fact.tool.js';
import { codeReviewSamplingTool } from './template-code-review-sampling.tool.js';
import { echoTool } from './template-echo-message.tool.js';
import { imageTestTool } from './template-image-test.tool.js';
import { madlibsElicitationTool } from './template-madlibs-elicitation.tool.js';
// Task tools (experimental)
import { asyncCountdownTaskTool } from './template-async-countdown.task-tool.js';
// App tools (MCP Apps extension)
import { dataExplorerAppTool } from './template-data-explorer.app-tool.js';

/**
 * An array containing all tool definitions for easy iteration.
 * Includes both regular tools and task-based tools (experimental).
 */
export const allToolDefinitions = [
  // Pixoo device tools
  pixooComposeTool,
  pixooControlTool,
  pixooPushImageTool,
  pixooTextTool,
  // Template tools
  catFactTool,
  codeReviewSamplingTool,
  echoTool,
  imageTestTool,
  madlibsElicitationTool,
  // Task tools (experimental)
  asyncCountdownTaskTool,
  // App tools (MCP Apps extension)
  dataExplorerAppTool,
];
