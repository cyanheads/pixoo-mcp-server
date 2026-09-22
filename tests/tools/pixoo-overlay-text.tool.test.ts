/**
 * @fileoverview Tests for the pixoo_overlay_text tool handler.
 * @module tests/tools/pixoo-overlay-text.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooOverlayText } from '@/mcp-server/tools/definitions/pixoo-overlay-text.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';
import { expectForwardedRecovery } from '../helpers/expect-forwarded-recovery.js';

const fakeConfig = {} as Parameters<typeof initPixooService>[0];
const fakeStorage = {} as Parameters<typeof initPixooService>[1];

describe('pixooOverlayText', () => {
  beforeEach(() => {
    resetServerConfig();
    process.env['PIXOO_SIZE'] = '64';
    process.env['PIXOO_PUSH_MIN_INTERVAL_MS'] = '0';
    process.env['PIXOO_IP'] = '10.0.0.1';
    initPixooService(fakeConfig, fakeStorage);
  });

  afterEach(() => {
    delete process.env['PIXOO_IP'];
    delete process.env['PIXOO_SIZE'];
    delete process.env['PIXOO_PUSH_MIN_INTERVAL_MS'];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  function stubSendText(result = { ok: true as const }) {
    vi.spyOn(getPixooService(), 'sendText').mockResolvedValue(result as never);
  }

  function stubClearText(result = { ok: true as const }) {
    vi.spyOn(getPixooService(), 'clearText').mockResolvedValue(result as never);
  }

  it('set mode — happy path: acknowledged:true, mode:"set", correct id', async () => {
    stubSendText();
    const ctx = createMockContext({ errors: pixooOverlayText.errors });
    const input = pixooOverlayText.input.parse({
      mode: 'set',
      id: 0,
      text: 'Hello World',
      color: '#ff8800',
    });
    const result = await pixooOverlayText.handler(input, ctx);

    expect(result.acknowledged).toBe(true);
    expect(result.mode).toBe('set');
    expect(result.id).toBe(0);
  });

  it('clear mode — happy path: acknowledged:true, mode:"clear", correct id', async () => {
    stubClearText();
    const ctx = createMockContext({ errors: pixooOverlayText.errors });
    const input = pixooOverlayText.input.parse({
      mode: 'clear',
      id: 5,
    });
    const result = await pixooOverlayText.handler(input, ctx);

    expect(result.acknowledged).toBe(true);
    expect(result.mode).toBe('clear');
    expect(result.id).toBe(5);
  });

  it('no_device_configured error when PIXOO_IP absent', async () => {
    resetServerConfig();
    delete process.env['PIXOO_IP'];
    initPixooService(fakeConfig, fakeStorage);

    const ctx = createMockContext({ errors: pixooOverlayText.errors });
    const input = pixooOverlayText.input.parse({ mode: 'set', id: 0, text: 'Test' });
    await expect(pixooOverlayText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_device_configured' },
    });
  });

  it('device_unreachable error when sendText returns network failure', async () => {
    vi.spyOn(getPixooService(), 'sendText').mockResolvedValue({
      ok: false,
      kind: 'network',
      message: 'ECONNREFUSED',
    } as never);

    const ctx = createMockContext({ errors: pixooOverlayText.errors });
    const input = pixooOverlayText.input.parse({ mode: 'set', id: 0, text: 'Fail' });
    await expect(pixooOverlayText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'device_unreachable' },
    });
  });

  it('a named color resolves — overlays accept the same colors as the render tools', async () => {
    const sendText = vi
      .spyOn(getPixooService(), 'sendText')
      .mockResolvedValue({ ok: true } as never);
    const result = await runToolContract(pixooOverlayText, {
      mode: 'set',
      id: 0,
      text: 'Hi',
      color: 'Orange',
    });

    expect(result.isError).toBeFalsy();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ color: [255, 165, 0] }),
      expect.anything(),
    );
  });

  describe('forwards the declared recovery on both surfaces', () => {
    it('invalid_color', async () => {
      const result = await runToolContract(pixooOverlayText, {
        mode: 'set',
        id: 0,
        text: 'Hi',
        color: 'notacolor',
      });
      expectForwardedRecovery(result, pixooOverlayText.errors, 'invalid_color');
    });

    it('device_unreachable — computed from a network failure in set mode', async () => {
      vi.spyOn(getPixooService(), 'sendText').mockResolvedValue({
        ok: false,
        kind: 'network',
        message: 'ECONNREFUSED',
      } as never);
      const result = await runToolContract(pixooOverlayText, { mode: 'set', id: 0, text: 'Hi' });
      expectForwardedRecovery(result, pixooOverlayText.errors, 'device_unreachable');
    });

    it('device_rejected — computed from a firmware failure in clear mode', async () => {
      vi.spyOn(getPixooService(), 'clearText').mockResolvedValue({
        ok: false,
        kind: 'device',
        message: 'error_code 1',
      } as never);
      const result = await runToolContract(pixooOverlayText, { mode: 'clear', id: 2 });
      expectForwardedRecovery(result, pixooOverlayText.errors, 'device_rejected');
    });
  });

  it('format() returns text block with overlay id and mode', () => {
    const output = { acknowledged: true, mode: 'set', id: 3 };
    const blocks = pixooOverlayText.format!(output);
    expect(blocks.length).toBeGreaterThan(0);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('3');
    expect(text).toContain('set');
  });
});
