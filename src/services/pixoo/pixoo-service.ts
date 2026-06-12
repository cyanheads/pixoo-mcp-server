/**
 * @fileoverview PixooService — wraps PixooClient with pacing, result mapping, and status helpers.
 * @module services/pixoo/pixoo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  type Canvas,
  Channel,
  type DiscoveredDevice,
  PixooClient,
  type PixooResult,
  type PixooSize,
} from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';

/** Device state snapshot returned after operations. */
export interface DeviceStateSnapshot {
  brightness?: number;
  channel?: string;
  clockId?: number;
  reachable: boolean;
  screenOn?: boolean;
}

/** Channel name ↔ enum mapping. */
const CHANNEL_NAMES: Record<string, Channel> = {
  faces: Channel.Faces,
  cloud: Channel.Cloud,
  visualizer: Channel.Visualizer,
  custom: Channel.Custom,
};

const CHANNEL_ENUM_TO_NAME: Record<number, string> = {
  [Channel.Faces]: 'faces',
  [Channel.Cloud]: 'cloud',
  [Channel.Visualizer]: 'visualizer',
  [Channel.Custom]: 'custom',
};

/** Map a PixooResult failure to the appropriate MCP error. */
function mapFailure(fail: {
  ok: false;
  kind: string;
  message: string;
  deviceCode?: number;
}): never {
  switch (fail.kind) {
    case 'network':
    case 'timeout':
      throw serviceUnavailable(`Device unreachable: ${fail.message}`, {
        reason: 'device_unreachable',
        recovery: {
          hint: 'Check that the device is powered on and on the same network as this server.',
        },
      });
    case 'http':
      throw serviceUnavailable(`Device HTTP error: ${fail.message}`, {
        reason: 'device_http_error',
        recovery: { hint: 'The device may be busy or rebooting; wait a few seconds and retry.' },
      });
    case 'device':
      throw serviceUnavailable(
        `Device rejected command (error_code ${fail.deviceCode ?? '?'}): ${fail.message}`,
        {
          reason: 'device_rejected',
          deviceCode: fail.deviceCode,
          recovery: { hint: 'Check the device error code in the Pixoo documentation.' },
        },
      );
    default:
      throw serviceUnavailable(`Device error: ${fail.message}`, {
        reason: 'device_unreachable',
      });
  }
}

export class PixooService {
  private client: PixooClient | undefined;
  private lastPushTime = 0;
  private pushQueue: Promise<void> = Promise.resolve();

  /** Get or lazily create the PixooClient. Throws no_device_configured if PIXOO_IP is absent. */
  private getClient(): PixooClient {
    if (!this.client) {
      const cfg = getServerConfig();
      if (!cfg.pixooIp) {
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          'No device configured — PIXOO_IP is not set. Run pixoo_discover_devices to find your device IP.',
          {
            reason: 'no_device_configured',
            recovery: {
              hint: 'Run pixoo_discover_devices to find your device IP, then set PIXOO_IP.',
            },
          },
        );
      }
      this.client = new PixooClient(cfg.pixooIp, {
        size: cfg.pixooSize as PixooSize,
        timeout: 5000,
        retries: 1,
      });
    }
    return this.client;
  }

  /** Get a read-only status snapshot, tolerating failures gracefully. */
  async getStatus(ctx: Context): Promise<DeviceStateSnapshot> {
    const cfg = getServerConfig();
    if (!cfg.pixooIp) {
      return { reachable: false };
    }
    const client = this.getClient();

    try {
      const channelRes = await client.getChannel();
      if (!channelRes.ok) {
        ctx.log.warning('Failed to read channel during status check', { kind: channelRes.kind });
        return { reachable: false };
      }
      const channelName = CHANNEL_ENUM_TO_NAME[channelRes.data.SelectIndex] ?? 'unknown';

      const configRes = await client.getConfig();
      if (!configRes.ok) {
        return { reachable: true, channel: channelName };
      }

      const cfg_ = configRes.data;
      const snapshot: DeviceStateSnapshot = { reachable: true, channel: channelName };
      if (cfg_.Brightness !== undefined) snapshot.brightness = cfg_.Brightness;
      if (cfg_.LightSwitch !== undefined) snapshot.screenOn = cfg_.LightSwitch === 1;
      if (cfg_.CurClockId !== undefined) snapshot.clockId = cfg_.CurClockId;
      return snapshot;
    } catch {
      return { reachable: false };
    }
  }

  /** Push a single canvas frame, respecting the minimum interval pacing. */
  async pushFrame(canvas: Canvas, ctx: Context): Promise<DeviceStateSnapshot> {
    const client = this.getClient();
    const result = await this.pacedPush(() => client.push(canvas), ctx);
    return result;
  }

  /** Push an animation (multi-frame), respecting the minimum interval pacing. */
  async pushAnimation(frames: Canvas[], speed: number, ctx: Context): Promise<DeviceStateSnapshot> {
    const client = this.getClient();
    const result = await this.pacedPush(() => client.pushAnimation(frames, speed), ctx);
    return result;
  }

  /** Serialized, paced device push with Custom channel enforcement. */
  private async pacedPush(
    fn: () => Promise<PixooResult>,
    ctx: Context,
  ): Promise<DeviceStateSnapshot> {
    // Serialize pushes through a queue
    let resolve!: () => void;
    const token = new Promise<void>((r) => (resolve = r));
    const prev = this.pushQueue;
    this.pushQueue = prev.then(() => token);

    try {
      await prev;

      // Enforce minimum interval
      const cfg = getServerConfig();
      const minInterval = cfg.pixooPushMinIntervalMs;
      const elapsed = Date.now() - this.lastPushTime;
      if (elapsed < minInterval) {
        await new Promise((r) => setTimeout(r, minInterval - elapsed));
      }

      // Ensure Custom channel
      await this.ensureCustomChannel(ctx);

      // Execute the push
      const pushResult = await fn();
      if (!pushResult.ok) {
        mapFailure(pushResult);
      }
      this.lastPushTime = Date.now();

      // Read back device state (degrade gracefully on failure)
      return await this.readStateAfterPush(ctx);
    } finally {
      resolve();
    }
  }

  /** Switch to Custom channel if not already there. */
  async ensureCustomChannel(ctx: Context): Promise<void> {
    const client = this.getClient();
    const channelRes = await client.getChannel();
    if (!channelRes.ok) {
      ctx.log.warning('Could not read channel before push — proceeding anyway', {
        kind: channelRes.kind,
      });
      return;
    }
    if (channelRes.data.SelectIndex !== Channel.Custom) {
      const switchRes = await client.setChannel(Channel.Custom);
      if (!switchRes.ok) {
        ctx.log.warning('Channel switch failed — push may not display on Custom channel', {
          kind: switchRes.kind,
        });
      } else {
        // Verify
        const verifyRes = await client.getChannel();
        if (verifyRes.ok && verifyRes.data.SelectIndex !== Channel.Custom) {
          ctx.log.warning('Channel verification failed after switch');
        }
      }
    }
  }

  /** Read device state post-push, degrading gracefully. */
  private readStateAfterPush(ctx: Context): Promise<DeviceStateSnapshot> {
    return this.getStatus(ctx);
  }

  /** Set brightness on the device. */
  setBrightness(brightness: number, ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    ctx.log.debug('Setting brightness', { brightness });
    return client.setBrightness(brightness);
  }

  /** Set screen on/off. */
  setScreen(on: boolean, ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    ctx.log.debug('Setting screen', { on });
    return client.setScreen(on);
  }

  /** Set channel. */
  setChannel(channelName: string, ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    const ch = CHANNEL_NAMES[channelName.toLowerCase()];
    if (ch === undefined) {
      throw invalidParams(
        `Unknown channel "${channelName}". Valid values: faces, cloud, visualizer, custom.`,
      );
    }
    ctx.log.debug('Setting channel', { channel: channelName });
    return client.setChannel(ch);
  }

  /** Set clock face. */
  setClock(clockFaceId: number, ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    ctx.log.debug('Setting clock face', { clockFaceId });
    return client.setClock(clockFaceId);
  }

  /** Send a text overlay. */
  sendText(opts: Parameters<PixooClient['sendText']>[0], ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    ctx.log.debug('Sending text overlay', { id: opts.id });
    return client.sendText(opts);
  }

  /** Clear a text overlay. */
  clearText(id: number, ctx: Context): Promise<PixooResult> {
    const client = this.getClient();
    ctx.log.debug('Clearing text overlay', { id });
    return client.clearText(id);
  }

  /** Discover devices on LAN. */
  async discoverDevices(timeoutMs: number, ctx: Context): Promise<DiscoveredDevice[]> {
    ctx.log.info('Discovering Pixoo devices on LAN', { timeoutMs });
    try {
      return await PixooClient.discover(timeoutMs);
    } catch {
      throw serviceUnavailable(
        'Divoom cloud discovery endpoint unreachable — check internet connectivity.',
        {
          reason: 'discovery_failed',
          recovery: {
            hint: 'Ensure this server has internet access for the Divoom discovery endpoint, or set PIXOO_IP manually.',
          },
        },
      );
    }
  }
}

// --- Init/accessor pattern ---

let _service: PixooService | undefined;

export function initPixooService(_config: AppConfig, _storage: StorageService): void {
  _service = new PixooService();
}

export function getPixooService(): PixooService {
  if (!_service) {
    throw new Error('PixooService not initialized — call initPixooService() in setup()');
  }
  return _service;
}
