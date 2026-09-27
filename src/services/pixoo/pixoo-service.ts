/**
 * @fileoverview PixooService — wraps PixooClient with pacing, result mapping, and status helpers.
 * @module services/pixoo/pixoo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { invalidParams, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  type Canvas,
  Channel,
  type DiscoveredDevice,
  PixooClient,
  type PixooFailure,
  type PixooResult,
  type PixooSize,
} from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import { encodePanelGif } from '@/renderer/preview.js';
import { openGifHost } from '@/services/pixoo/gif-host.js';

/**
 * Most frames an animation pushes as one `Draw/SendHttpGif` request each — the device
 * turns unstable past about 40. A longer one plays as a GIF the device downloads.
 */
export const MAX_FRAME_PUSH = 40;

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

/** Error-contract reasons a failed device call maps to. */
export type DeviceFailureReason = 'device_unreachable' | 'device_http_error' | 'device_rejected';

/** HTTP statuses a later attempt can clear — the device busy, rate-limited, or restarting. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify a failed device call into its error-contract reason and retryability.
 * `retryable` is absent for a firmware rejection, which makes no claim either way.
 *
 * Services cannot call `ctx.fail`, the only path that fills `data.retryable` from a
 * tool's contract, so every throw site writes the value this returns.
 */
export function classifyDeviceFailure(fail: PixooFailure): {
  reason: DeviceFailureReason;
  retryable?: boolean;
} {
  switch (fail.kind) {
    case 'http':
      return {
        reason: 'device_http_error',
        retryable: TRANSIENT_HTTP_STATUSES.has(fail.status ?? 0),
      };
    case 'device':
      return { reason: 'device_rejected' };
    default:
      return { reason: 'device_unreachable', retryable: true };
  }
}

/**
 * Map a PixooResult failure to the appropriate MCP error. The throw carries the reason
 * and retryability; the framework fills in the calling tool's declared recovery.
 */
function mapFailure(fail: PixooFailure): never {
  const { reason, retryable } = classifyDeviceFailure(fail);
  switch (reason) {
    case 'device_unreachable':
      throw serviceUnavailable(`Device unreachable: ${fail.message}`, { reason, retryable });
    case 'device_http_error':
      throw serviceUnavailable(`Device HTTP error: ${fail.message}`, { reason, retryable });
    case 'device_rejected':
      throw serviceUnavailable(
        `Device rejected command (error_code ${fail.deviceCode ?? '?'}): ${fail.message}`,
        { reason, deviceCode: fail.deviceCode },
      );
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
        throw invalidParams(
          'No device configured — PIXOO_IP is not set. Run pixoo_discover_devices to find your device IP.',
          { reason: 'no_device_configured' },
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

  /**
   * Push an animation. Up to {@link MAX_FRAME_PUSH} frames go one `Draw/SendHttpGif`
   * request each. Past that, the device downloads and loops the panel-size GIF from a
   * one-shot listener on this host: `gif` when the caller already encoded it from these
   * frames with `encodePanelGif`, so a caller that also saves it encodes once. The push
   * then succeeds only once the device has accepted the play and requested the file, and
   * the whole file has been handed to the OS to send — not confirmed receipt; a listener
   * that cannot open, a URL over 255 bytes, or a transfer that never completes fails
   * `gif_serve_failed`.
   */
  async pushAnimation(
    frames: Canvas[],
    speed: number,
    ctx: Context,
    gif?: Uint8Array,
  ): Promise<DeviceStateSnapshot> {
    const client = this.getClient();
    if (frames.length <= MAX_FRAME_PUSH) {
      return await this.pacedPush(() => client.pushAnimation(frames, speed), ctx);
    }
    const panelGif = gif ?? encodePanelGif(frames, speed);
    const cfg = getServerConfig();
    return await this.queued(async () => {
      // Opened before any device command, so a failed bind or an overlong URL sends none.
      const host = await openGifHost(panelGif, {
        deviceIp: client.ip,
        serveHost: cfg.pixooServeHost,
        servePort: cfg.pixooServePort,
        signal: ctx.signal,
      });
      try {
        return await this.pushNow(async () => {
          const played = await client.playGifUrl(host.url);
          // The device accepts the play before it downloads, even from a dead URL.
          if (played.ok) await host.served();
          return played;
        }, ctx);
      } finally {
        host.close();
      }
    });
  }

  /** Serialized, paced device push with Custom channel enforcement. */
  private pacedPush(fn: () => Promise<PixooResult>, ctx: Context): Promise<DeviceStateSnapshot> {
    return this.queued(() => this.pushNow(fn, ctx));
  }

  /** Run `task` once every push queued before it has settled — one device push at a time. */
  private async queued<T>(task: () => Promise<T>): Promise<T> {
    const { promise: token, resolve } = Promise.withResolvers<void>();
    const prev = this.pushQueue;
    this.pushQueue = prev.then(() => token);

    try {
      await prev;
      return await task();
    } finally {
      resolve();
    }
  }

  /** Pace, switch to the Custom channel, run the push, and read back device state. */
  private async pushNow(
    fn: () => Promise<PixooResult>,
    ctx: Context,
  ): Promise<DeviceStateSnapshot> {
    // Enforce minimum interval
    const cfg = getServerConfig();
    const minInterval = cfg.pixooPushMinIntervalMs;
    const elapsed = Date.now() - this.lastPushTime;
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }

    // Ensure Custom channel
    await this.ensureCustomChannel(ctx);

    // Cancelled during the wait or the channel switch: send no push command.
    ctx.signal.throwIfAborted();
    const pushResult = await fn();
    if (!pushResult.ok) {
      mapFailure(pushResult);
    }
    this.lastPushTime = Date.now();

    // Read back device state (degrade gracefully on failure)
    return await this.getStatus(ctx);
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
        { reason: 'discovery_failed', retryable: true },
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
