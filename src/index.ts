#!/usr/bin/env node
/**
 * @fileoverview pixoo-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
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
import { pixooRenderHtml } from './mcp-server/tools/definitions/pixoo-render-html.tool.js';
import { getBrowserRenderer, initBrowserRenderer } from './services/browser/browser-renderer.js';
import { initPixooService } from './services/pixoo/pixoo-service.js';

/**
 * Under Node the framework, not the runtime, loads `.env`, on its first config read.
 * Reading it here guarantees that happens before the server config is parsed and
 * cached, so PIXOO_HTML_ENABLED and every other PIXOO_* value in `.env` apply.
 */
void config.environment;
const { pixooHtmlEnabled } = getServerConfig();

await createApp({
  name: 'pixoo-mcp-server',
  title: 'pixoo-mcp-server',
  tools: [
    pixooDisplayText,
    pixooComposeScene,
    pixooPushImage,
    pixooHtmlEnabled
      ? pixooRenderHtml
      : disabledTool(pixooRenderHtml, {
          reason: 'HTML rendering is turned off in this deployment.',
          hint: 'Set PIXOO_HTML_ENABLED=true to enable.',
        }),
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
  // No handler requests input mid-call, so nothing needs a 2025-era session.
  sessionMode: 'stateless',
  /**
   * The tool and resource surface is fixed at build time — nothing registers or
   * retires a definition at runtime — so the list results are safe for shared
   * caches to hold. Per-resource `resources/read` lifetimes are declared on the
   * definitions themselves; the live device-status resource declares none.
   */
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  setup(core) {
    initPixooService(core.config, core.storage);
    initBrowserRenderer();
  },
  // The HTML renderer's browser, if one is running, exits and takes its temp profile with it.
  async teardown() {
    await getBrowserRenderer().close();
  },
  instructions: `Run pixoo_design_brief with a topic first for craft guidance and live device state, then render with pixoo_display_text for styled text or pixoo_compose_scene for layered scenes, widgets, and animations${pixooHtmlEnabled ? '; pixoo_render_html draws anything HTML, CSS, or Canvas can, including generative animation' : ''}. Every render tool returns a preview image, so pass push: false to inspect a design before it reaches the Pixoo display.`,
});
