/**
 * @fileoverview pixoo_discover_devices tool — find Pixoo devices on the LAN.
 * @module mcp-server/tools/definitions/pixoo-discover-devices.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getPixooService } from '@/services/pixoo/pixoo-service.js';

export const pixooDiscoverDevices = tool('pixoo_discover_devices', {
  title: 'pixoo_discover_devices',
  description:
    "Find Pixoo devices on the local network via Divoom's cloud discovery endpoint (requires internet — queries app.divoom-gz.com). Run once during initial setup to find device IPs; set PIXOO_IP in server configuration to enable all other tools. For ongoing device control use pixoo_control_device.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(30000)
      .default(5000)
      .describe('Discovery timeout in milliseconds (default: 5000ms).'),
  }),

  output: z.object({
    devices: z
      .array(
        z
          .object({
            name: z.string().describe('Device display name (e.g. "Pixoo64").'),
            id: z
              .number()
              .describe('Divoom device numeric ID (informational; use ip for PIXOO_IP).'),
            ip: z
              .string()
              .describe('Device IP address on the local network. Set this as PIXOO_IP.'),
          })
          .describe('A discovered Pixoo device on the local network.'),
      )
      .describe('Discovered Pixoo devices on the local network.'),
    configuredIp: z
      .string()
      .optional()
      .describe('Currently configured PIXOO_IP value (absent if not set).'),
    configuredIpFound: z
      .boolean()
      .optional()
      .describe(
        'True if PIXOO_IP matches a discovered device; false signals an IP mismatch. Absent when PIXOO_IP is not set.',
      ),
  }),

  enrichment: {
    notice: z.string().optional().describe('Recovery hint when no devices found or IP mismatch.'),
  },

  errors: [
    {
      reason: 'discovery_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Divoom cloud discovery endpoint is unreachable.',
      retryable: true,
      recovery:
        'Ensure this server has internet access. If the device is on a different subnet, set PIXOO_IP manually.',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const svc = getPixooService();

    const devices = await svc.discoverDevices(input.timeoutMs, ctx);

    const configuredIp = cfg.pixooIp;
    let configuredIpFound: boolean | undefined;

    if (configuredIp) {
      configuredIpFound = devices.some((d) => d.ip === configuredIp);
      if (!configuredIpFound) {
        ctx.enrich.notice(
          `PIXOO_IP is set to "${configuredIp}" but that IP was not found in discovery results. ` +
            `Check the device is on and connected to the same network, or update PIXOO_IP to one of the discovered IPs above.`,
        );
      }
    } else if (devices.length === 0) {
      ctx.enrich.notice(
        'No devices found. Check the device is powered on and connected to the same network as this server. ' +
          "If discovery fails consistently, set PIXOO_IP manually to the device's local IP address.",
      );
    } else {
      const firstIp = devices[0]?.ip ?? '';
      ctx.enrich.notice(
        `Found ${devices.length} device(s). Set PIXOO_IP=${firstIp} to configure the server.`,
      );
    }

    return {
      devices,
      configuredIp,
      configuredIpFound,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.devices.length === 0) {
      lines.push('No Pixoo devices found on the local network.');
    } else {
      lines.push(`Found **${result.devices.length}** device(s):\n`);
      for (const d of result.devices) {
        lines.push(`- **${d.name}** (ID: ${d.id}) — IP: \`${d.ip}\``);
      }
    }

    if (result.configuredIp) {
      lines.push(
        `\n**Configured PIXOO_IP:** \`${result.configuredIp}\`` +
          (result.configuredIpFound !== undefined
            ? ` (${result.configuredIpFound ? '✓ found in results' : '✗ not found in results'})`
            : ''),
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
