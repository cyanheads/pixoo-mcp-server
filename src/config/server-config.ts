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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    pixooIp: 'PIXOO_IP',
    pixooSize: 'PIXOO_SIZE',
    pixooOutputDir: 'PIXOO_OUTPUT_DIR',
    pixooPushMinIntervalMs: 'PIXOO_PUSH_MIN_INTERVAL_MS',
  });
  return _config;
}

/** Reset cached config (for testing). */
export function resetServerConfig(): void {
  _config = undefined;
}
