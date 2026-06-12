#!/usr/bin/env node
/**
 * @fileoverview pixoo-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
// Resources
import { pixooDesignGuideResource } from './mcp-server/resources/definitions/pixoo-design-guide.resource.js';
import { pixooDeviceStatusResource } from './mcp-server/resources/definitions/pixoo-device-status.resource.js';
import { pixooIconsResource } from './mcp-server/resources/definitions/pixoo-icons.resource.js';
import { pixooThemesResource } from './mcp-server/resources/definitions/pixoo-themes.resource.js';
// Tools
import { pixooComposeScene } from './mcp-server/tools/definitions/pixoo-compose-scene.tool.js';
import { pixooControlDevice } from './mcp-server/tools/definitions/pixoo-control-device.tool.js';
import { pixooDesignBrief } from './mcp-server/tools/definitions/pixoo-design-brief.tool.js';
import { pixooDiscoverDevices } from './mcp-server/tools/definitions/pixoo-discover-devices.tool.js';
import { pixooDisplayText } from './mcp-server/tools/definitions/pixoo-display-text.tool.js';
import { pixooOverlayText } from './mcp-server/tools/definitions/pixoo-overlay-text.tool.js';
import { pixooPushImage } from './mcp-server/tools/definitions/pixoo-push-image.tool.js';
import { initPixooService } from './services/pixoo/pixoo-service.js';

await createApp({
  name: 'pixoo-mcp-server',
  title: 'pixoo-mcp-server',
  tools: [
    pixooDisplayText,
    pixooComposeScene,
    pixooPushImage,
    pixooOverlayText,
    pixooControlDevice,
    pixooDiscoverDevices,
    pixooDesignBrief,
  ],
  resources: [
    pixooDeviceStatusResource,
    pixooThemesResource,
    pixooIconsResource,
    pixooDesignGuideResource,
  ],
  prompts: [],
  setup(core) {
    initPixooService(core.config, core.storage);
  },
  instructions:
    'Pixoo LED matrix display server. Use pixoo_design_brief(topic) first to orient on craft guidelines. ' +
    'pixoo_display_text is the 80% case for styled text. pixoo_compose_scene for layered scenes, widgets, and animations. ' +
    'All render tools return a preview image so you can inspect the result before it hits the display.',
});
