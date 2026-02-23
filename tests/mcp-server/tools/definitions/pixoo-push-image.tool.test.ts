/**
 * @fileoverview Tests for the pixoo_push_image tool.
 * @module tests/mcp-server/tools/definitions/pixoo-push-image.tool.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.mock calls are hoisted to the top by Vitest
// ---------------------------------------------------------------------------

// Mock the config module to prevent parseConfig() side effect (requires PIXOO_IP env var)
vi.mock('@/config/index.js', () => ({
  config: {
    pkg: { name: 'pixoo-mcp-server', version: '0.0.0' },
    mcpServerName: 'pixoo-mcp-server',
    mcpServerVersion: '0.0.0',
    logLevel: 'silent',
    pixoo: { ip: '192.168.1.100', size: 64 },
  },
  parseConfig: vi.fn(),
  ConfigSchema: {},
}));

// Hoist the mock function so it's available inside the vi.mock factory
const { mockLoadImage } = vi.hoisted(() => ({
  mockLoadImage: vi.fn(),
}));

vi.mock('@cyanheads/pixoo-toolkit', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cyanheads/pixoo-toolkit')>();
  return {
    ...actual,
    loadImage: mockLoadImage,
  };
});

// Mock the auth wrapper to be a transparent pass-through
vi.mock('@/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: (_scopes: string[], fn: (...args: unknown[]) => unknown) => fn,
  withResourceAuth: (_scopes: string[], fn: (...args: unknown[]) => unknown) =>
    fn,
}));

// Now import real modules that depend on config (safe because config is mocked)
import { container } from '@/container/index.js';
import { AppConfig, PixooClientToken } from '@/container/core/tokens.js';
import { requestContextService } from '@/utils/index.js';
import { Channel } from '@cyanheads/pixoo-toolkit';

// ---------------------------------------------------------------------------
// DI mocks
// ---------------------------------------------------------------------------

const mockClient = {
  setChannel: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
};

const mockAppConfig = {
  pixoo: { ip: '192.168.1.100', size: 64 },
};

vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
  if (token === PixooClientToken) return mockClient as never;
  if (token === AppConfig) return mockAppConfig as never;
  throw new Error(`Unexpected token resolved: ${String(token)}`);
});

// Import the tool AFTER all mocks are in place
const { pixooPushImageTool } =
  await import('@/mcp-server/tools/definitions/pixoo-push-image.tool.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeCanvas = {
  width: 64,
  height: 64,
  data: new Uint8Array(64 * 64 * 4),
};

const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pixooPushImageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadImage.mockResolvedValue(fakeCanvas);
    // Re-apply container.resolve mock after clearAllMocks
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === PixooClientToken) return mockClient as never;
      if (token === AppConfig) return mockAppConfig as never;
      throw new Error(`Unexpected token resolved: ${String(token)}`);
    });
  });

  it('should switch to Custom channel before pushing', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/test.png',
    });

    await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(mockClient.setChannel).toHaveBeenCalledWith(Channel.Custom);
    // setChannel must be called before push
    const setChannelOrder = mockClient.setChannel.mock.invocationCallOrder[0]!;
    const pushOrder = mockClient.push.mock.invocationCallOrder[0]!;
    expect(setChannelOrder).toBeLessThan(pushOrder);
  });

  it('should call loadImage with correct path, size, fit, and kernel', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/photo.jpg',
      fit: 'cover',
      kernel: 'lanczos3',
    });

    await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(mockLoadImage).toHaveBeenCalledWith('/tmp/photo.jpg', {
      size: 64,
      fit: 'cover',
      kernel: 'lanczos3',
    });
  });

  it('should push the loaded canvas to the device', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/icon.png',
    });

    await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(mockClient.push).toHaveBeenCalledWith(fakeCanvas);
  });

  it('should default fit to contain and kernel to nearest', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/sprite.png',
    });

    await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(mockLoadImage).toHaveBeenCalledWith('/tmp/sprite.png', {
      size: 64,
      fit: 'contain',
      kernel: 'nearest',
    });
  });

  it('should return result with path, size, fit, and kernel', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/art.png',
      fit: 'fill',
      kernel: 'mitchell',
    });

    const result = await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(result).toEqual({
      path: '/tmp/art.png',
      size: 64,
      fit: 'fill',
      kernel: 'mitchell',
    });
  });

  it('should return defaults in result when fit and kernel are omitted', async () => {
    const ctx = requestContextService.createRequestContext();
    const input = pixooPushImageTool.inputSchema.parse({
      path: '/tmp/default.png',
    });

    const result = await pixooPushImageTool.logic(input, ctx, mockSdkContext);

    expect(result).toEqual({
      path: '/tmp/default.png',
      size: 64,
      fit: 'contain',
      kernel: 'nearest',
    });
  });

  describe('responseFormatter', () => {
    it('should produce readable text output', () => {
      const formatter = pixooPushImageTool.responseFormatter;
      expect(formatter).toBeDefined();

      const result = formatter!({
        path: '/tmp/test.png',
        size: 64,
        fit: 'contain',
        kernel: 'nearest',
      });

      expect(result).toHaveLength(1);
      const block = result[0];
      expect(block).toBeDefined();
      if (!block || block.type !== 'text') {
        throw new Error('Expected text content block');
      }
      expect(block.text).toBe(
        'Pushed image to 64x64 display (fit=contain, kernel=nearest)',
      );
    });

    it('should reflect provided fit and kernel values', () => {
      const formatter = pixooPushImageTool.responseFormatter!;

      const result = formatter({
        path: '/tmp/photo.jpg',
        size: 32,
        fit: 'cover',
        kernel: 'lanczos3',
      });

      const block = result[0];
      if (!block || block.type !== 'text') {
        throw new Error('Expected text content block');
      }
      expect(block.text).toBe(
        'Pushed image to 32x32 display (fit=cover, kernel=lanczos3)',
      );
    });
  });
});
