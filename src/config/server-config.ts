/**
 * @fileoverview Server-specific environment variable configuration for pixoo-mcp-server.
 * @module config/server-config
 */

import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  pixooIp: z.string().optional().describe('Device IP on the local network.'),
  pixooSize: z.coerce
    .number()
    .refine((v) => v === 16 || v === 32 || v === 64, {
      message: 'Must be 16, 32, or 64',
    })
    .default(64)
    .describe('Display size in pixels (16, 32, or 64).'),
  pixooOutputDir: z
    .string()
    .transform((dir) => path.resolve(dir))
    .optional()
    .describe(
      'Auto-save directory for preview PNG/GIF files. A relative path resolves against the working directory the server was launched from, so every saved path it reports is absolute.',
    ),
  pixooPushMinIntervalMs: z.coerce
    .number()
    .int()
    .min(0)
    .default(1000)
    .describe('Pacing floor between device pushes in milliseconds.'),
  pixooServeHost: z
    .string()
    .optional()
    .describe(
      'Host advertised in the URL the device downloads an animation GIF from, in place of the local address the OS routes to PIXOO_IP. The listener still binds that routed address.',
    ),
  pixooServePort: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('Fixed port for the animation GIF listener; a free port when unset.'),
  pixooBrowserPath: z
    .string()
    .transform((file) => path.resolve(file))
    .optional()
    .describe(
      "Browser executable for HTML rendering. When set, the only browser tried: a path that is not an executable file fails rather than falling back. When unset, the newest chrome-headless-shell in Puppeteer's cache (~/.cache/puppeteer). A relative path resolves against the launch directory, never against PATH.",
    ),
  pixooHtmlEnabled: z
    .stringbool()
    .default(true)
    .describe(
      'Offer pixoo_render_html (default: true). false keeps it registered but disabled, so it leaves tools/list.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    pixooIp: 'PIXOO_IP',
    pixooSize: 'PIXOO_SIZE',
    pixooOutputDir: 'PIXOO_OUTPUT_DIR',
    pixooPushMinIntervalMs: 'PIXOO_PUSH_MIN_INTERVAL_MS',
    pixooServeHost: 'PIXOO_SERVE_HOST',
    pixooServePort: 'PIXOO_SERVE_PORT',
    pixooBrowserPath: 'PIXOO_BROWSER_PATH',
    pixooHtmlEnabled: 'PIXOO_HTML_ENABLED',
  });
  return _config;
}

/** Reset cached config (for testing). */
export function resetServerConfig(): void {
  _config = undefined;
}
