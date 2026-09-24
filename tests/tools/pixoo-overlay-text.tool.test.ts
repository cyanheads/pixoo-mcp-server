/**
 * @fileoverview Tests for the pixoo_overlay_text tool handler.
 * @module tests/tools/pixoo-overlay-text.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { pixooOverlayText } from '@/mcp-server/tools/definitions/pixoo-overlay-text.tool.js';
import { getPixooService, initPixooService } from '@/services/pixoo/pixoo-service.js';
import { expectDeviceFailure, resultText } from '../helpers/device-failure.js';
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

    it.each([
      ['set', 503],
      ['clear', 404],
    ] as const)(
      'device_http_error — computed from an HTTP failure in %s mode',
      async (mode, status) => {
        const failure = { ok: false, kind: 'http', status, message: `HTTP ${status}` } as never;
        vi.spyOn(getPixooService(), 'sendText').mockResolvedValue(failure);
        vi.spyOn(getPixooService(), 'clearText').mockResolvedValue(failure);
        const result = await runToolContract(pixooOverlayText, { mode, id: 1, text: 'Hi' });
        expectForwardedRecovery(result, pixooOverlayText.errors, 'device_http_error');
      },
    );
  });

  describe('retryability reaches both surfaces', () => {
    it.each([
      [{ kind: 'network', message: 'ECONNREFUSED' }, 'device_unreachable', true],
      [{ kind: 'timeout', message: 'Request timed out' }, 'device_unreachable', true],
      [{ kind: 'http', status: 503, message: 'HTTP 503' }, 'device_http_error', true],
      [{ kind: 'http', status: 404, message: 'HTTP 404' }, 'device_http_error', false],
      [{ kind: 'device', deviceCode: 1, message: 'error_code 1' }, 'device_rejected', undefined],
    ])('%o → %s, retryable: %s', async (failure, reason, retryable) => {
      vi.spyOn(getPixooService(), 'sendText').mockResolvedValue({
        ok: false,
        ...failure,
      } as never);
      const result = await runToolContract(pixooOverlayText, { mode: 'set', id: 0, text: 'Hi' });
      expectDeviceFailure(result, pixooOverlayText.errors, reason, retryable);
    });
  });

  describe('x/y bounds follow PIXOO_SIZE', () => {
    function useSize(size: number) {
      resetServerConfig();
      process.env['PIXOO_SIZE'] = String(size);
    }

    it.each([16, 32, 64])('size %i: x/y at size - 1 reach the device', async (size) => {
      useSize(size);
      const sendText = vi
        .spyOn(getPixooService(), 'sendText')
        .mockResolvedValue({ ok: true } as never);
      const result = await runToolContract(pixooOverlayText, {
        mode: 'set',
        id: 0,
        text: 'Hi',
        x: size - 1,
        y: size - 1,
      });
      expect(result.isError).toBeFalsy();
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ x: size - 1, y: size - 1 }),
        expect.anything(),
      );
    });

    it.each(
      [16, 32, 64].flatMap((size) => [
        [size, 'x'],
        [size, 'y'],
      ]),
    )('size %i: %s at size is rejected naming the valid range, never sent', async (size, axis) => {
      useSize(size as number);
      const sendText = vi
        .spyOn(getPixooService(), 'sendText')
        .mockResolvedValue({ ok: true } as never);
      const result = await runToolContract(pixooOverlayText, {
        mode: 'set',
        id: 0,
        text: 'Hi',
        [axis as string]: size,
      });
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain(`${axis} must be 0–${(size as number) - 1}`);
      expect(resultText(result)).toContain(`${axis} must be 0–${(size as number) - 1}`);
      expect(sendText).not.toHaveBeenCalled();
    });

    it.each([16, 32, 64])(
      'size %i: width up to the display width is sent; wider is rejected, never sent',
      async (size) => {
        useSize(size);
        const sendText = vi
          .spyOn(getPixooService(), 'sendText')
          .mockResolvedValue({ ok: true } as never);
        const accepted = await runToolContract(pixooOverlayText, {
          mode: 'set',
          id: 0,
          text: 'Hi',
          width: size,
        });
        expect(accepted.isError).toBeFalsy();
        expect(sendText).toHaveBeenCalledWith(
          expect.objectContaining({ width: size }),
          expect.anything(),
        );

        sendText.mockClear();
        const rejected = await runToolContract(pixooOverlayText, {
          mode: 'set',
          id: 0,
          text: 'Hi',
          width: size + 1,
        });
        expect(rejected.isError).toBe(true);
        const error = (rejected.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toContain(`width must be 0–${size}`);
        expect(resultText(rejected)).toContain(`width must be 0–${size}`);
        expect(sendText).not.toHaveBeenCalled();
      },
    );

    it('size 16: a value far past the edge is rejected; clear mode ignores x/y', async () => {
      useSize(16);
      const sendText = vi
        .spyOn(getPixooService(), 'sendText')
        .mockResolvedValue({ ok: true } as never);
      const clearText = vi
        .spyOn(getPixooService(), 'clearText')
        .mockResolvedValue({ ok: true } as never);
      const rejected = await runToolContract(pixooOverlayText, {
        mode: 'set',
        id: 0,
        text: 'hi',
        x: 50,
        y: 50,
      });
      expect(rejected.isError).toBe(true);
      expect(sendText).not.toHaveBeenCalled();

      const cleared = await runToolContract(pixooOverlayText, { mode: 'clear', id: 0, x: 50 });
      expect(cleared.isError).toBeFalsy();
      expect(clearText).toHaveBeenCalledOnce();
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
