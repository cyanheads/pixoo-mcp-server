/**
 * @fileoverview Tests for the pixoo_control tool.
 * @module tests/mcp-server/tools/definitions/pixoo-control.tool.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { container } from '../../../../src/container/core/container.js';
import { PixooClientToken } from '../../../../src/container/core/tokens.js';
import { pixooControlTool } from '../../../../src/mcp-server/tools/definitions/pixoo-control.tool.js';
import { requestContextService } from '../../../../src/utils/index.js';

// ---------------------------------------------------------------------------
// Mock PixooClient
// ---------------------------------------------------------------------------
function createMockClient(configOverrides: Record<string, unknown> = {}) {
  const defaultConfig = {
    Brightness: 75,
    RotationFlag: 0,
    ClockTime: 60,
    GalleryTime: 60,
    SingleGalleyTime: 5,
    PowerOnChannelId: 0,
    GalleryShowTimeFlag: 1,
    CurClockId: 182,
    Time24Flag: 1,
    TemperatureMode: 0,
    GyrateAngle: 0,
    MirrorFlag: 0,
    LightSwitch: 1,
    SelectIndex: 0,
    error_code: 0,
    ...configOverrides,
  };

  return {
    getConfig: vi.fn().mockResolvedValue(defaultConfig),
    setBrightness: vi.fn().mockResolvedValue({ error_code: 0 }),
    setScreen: vi.fn().mockResolvedValue({ error_code: 0 }),
    setChannel: vi.fn().mockResolvedValue({ error_code: 0 }),
    setClock: vi.fn().mockResolvedValue({ error_code: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Mock sdkContext
// ---------------------------------------------------------------------------
const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

describe('pixooControlTool', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    container.registerValue(PixooClientToken, mockClient as never);
    vi.clearAllMocks();
    // Re-bind after clearing mocks since registerValue happened before clearAllMocks
    mockClient = createMockClient();
    container.registerValue(PixooClientToken, mockClient as never);
  });

  // -------------------------------------------------------------------------
  // Read-only (no params)
  // -------------------------------------------------------------------------
  describe('read-only (no params)', () => {
    it('should return current config without calling any set methods', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({});
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setBrightness).not.toHaveBeenCalled();
      expect(mockClient.setScreen).not.toHaveBeenCalled();
      expect(mockClient.setChannel).not.toHaveBeenCalled();
      expect(mockClient.setClock).not.toHaveBeenCalled();
      expect(mockClient.getConfig).toHaveBeenCalledOnce();
      expect(result.applied).toEqual([]);
    });

    it('should return correct shape from OutputSchema', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({});
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result).toEqual({
        brightness: 75,
        channel: 'faces',
        channelIndex: 0,
        screenOn: true,
        clockId: 182,
        applied: [],
      });

      // Validate against the output schema
      const parsed = pixooControlTool.outputSchema.parse(result);
      expect(parsed).toEqual(result);
    });
  });

  // -------------------------------------------------------------------------
  // Channel mapping
  // -------------------------------------------------------------------------
  describe('channel name/index mapping', () => {
    it.each([
      { index: 0, name: 'faces' },
      { index: 1, name: 'cloud' },
      { index: 2, name: 'visualizer' },
      { index: 3, name: 'custom' },
    ] as const)(
      'should map SelectIndex $index to channel name "$name"',
      async ({ index, name }) => {
        mockClient.getConfig.mockResolvedValue({
          Brightness: 50,
          RotationFlag: 0,
          ClockTime: 60,
          GalleryTime: 60,
          SingleGalleyTime: 5,
          PowerOnChannelId: 0,
          GalleryShowTimeFlag: 1,
          CurClockId: 100,
          Time24Flag: 1,
          TemperatureMode: 0,
          GyrateAngle: 0,
          MirrorFlag: 0,
          LightSwitch: 1,
          SelectIndex: index,
          error_code: 0,
        });

        const context = requestContextService.createRequestContext();
        const input = pixooControlTool.inputSchema.parse({});
        const result = await pixooControlTool.logic(
          input,
          context,
          mockSdkContext,
        );

        expect(result.channel).toBe(name);
        expect(result.channelIndex).toBe(index);
      },
    );

    it('should handle unknown channel index gracefully', async () => {
      mockClient.getConfig.mockResolvedValue({
        Brightness: 50,
        RotationFlag: 0,
        ClockTime: 60,
        GalleryTime: 60,
        SingleGalleyTime: 5,
        PowerOnChannelId: 0,
        GalleryShowTimeFlag: 1,
        CurClockId: 100,
        Time24Flag: 1,
        TemperatureMode: 0,
        GyrateAngle: 0,
        MirrorFlag: 0,
        LightSwitch: 1,
        SelectIndex: 99,
        error_code: 0,
      });

      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({});
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.channel).toBe('unknown(99)');
      expect(result.channelIndex).toBe(99);
    });

    it.each([
      { name: 'faces', expectedIndex: 0 },
      { name: 'cloud', expectedIndex: 1 },
      { name: 'visualizer', expectedIndex: 2 },
      { name: 'custom', expectedIndex: 3 },
    ] as const)(
      'should pass index $expectedIndex to setChannel when channel="$name"',
      async ({ name, expectedIndex }) => {
        const context = requestContextService.createRequestContext();
        const input = pixooControlTool.inputSchema.parse({ channel: name });
        await pixooControlTool.logic(input, context, mockSdkContext);

        expect(mockClient.setChannel).toHaveBeenCalledWith(expectedIndex);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Screen on/off mapping
  // -------------------------------------------------------------------------
  describe('screen on/off', () => {
    it('should map LightSwitch=1 to screenOn=true', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({});
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.screenOn).toBe(true);
    });

    it('should map LightSwitch=0 to screenOn=false', async () => {
      mockClient.getConfig.mockResolvedValue({
        Brightness: 75,
        RotationFlag: 0,
        ClockTime: 60,
        GalleryTime: 60,
        SingleGalleyTime: 5,
        PowerOnChannelId: 0,
        GalleryShowTimeFlag: 1,
        CurClockId: 182,
        Time24Flag: 1,
        TemperatureMode: 0,
        GyrateAngle: 0,
        MirrorFlag: 0,
        LightSwitch: 0,
        SelectIndex: 0,
        error_code: 0,
      });

      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({});
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.screenOn).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Individual settings
  // -------------------------------------------------------------------------
  describe('setting brightness', () => {
    it('should call client.setBrightness with the provided value', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({ brightness: 42 });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setBrightness).toHaveBeenCalledWith(42);
      expect(result.applied).toContain('brightness=42');
    });

    it('should accept boundary values 0 and 100', () => {
      expect(() =>
        pixooControlTool.inputSchema.parse({ brightness: 0 }),
      ).not.toThrow();
      expect(() =>
        pixooControlTool.inputSchema.parse({ brightness: 100 }),
      ).not.toThrow();
    });

    it('should reject out-of-range brightness via schema', () => {
      expect(() =>
        pixooControlTool.inputSchema.parse({ brightness: -1 }),
      ).toThrow();
      expect(() =>
        pixooControlTool.inputSchema.parse({ brightness: 101 }),
      ).toThrow();
    });
  });

  describe('setting screen', () => {
    it('should call client.setScreen(true) for screen="on"', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({ screen: 'on' });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setScreen).toHaveBeenCalledWith(true);
      expect(result.applied).toContain('screen=on');
    });

    it('should call client.setScreen(false) for screen="off"', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({ screen: 'off' });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setScreen).toHaveBeenCalledWith(false);
      expect(result.applied).toContain('screen=off');
    });
  });

  describe('setting channel', () => {
    it('should call client.setChannel with the correct index', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({ channel: 'custom' });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setChannel).toHaveBeenCalledWith(3);
      expect(result.applied).toContain('channel=custom');
    });
  });

  describe('setting clock_face_id', () => {
    it('should call client.setClock with the provided ID', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({ clock_face_id: 42 });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setClock).toHaveBeenCalledWith(42);
      expect(result.applied).toContain('clock_face_id=42');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple settings in one call
  // -------------------------------------------------------------------------
  describe('multiple settings at once', () => {
    it('should apply all provided settings and track them in applied', async () => {
      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({
        brightness: 80,
        screen: 'on',
        channel: 'visualizer',
        clock_face_id: 99,
      });
      const result = await pixooControlTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(mockClient.setBrightness).toHaveBeenCalledWith(80);
      expect(mockClient.setScreen).toHaveBeenCalledWith(true);
      expect(mockClient.setChannel).toHaveBeenCalledWith(2);
      expect(mockClient.setClock).toHaveBeenCalledWith(99);
      expect(result.applied).toEqual([
        'brightness=80',
        'screen=on',
        'channel=visualizer',
        'clock_face_id=99',
      ]);
    });

    it('should call getConfig after all set operations', async () => {
      const callOrder: string[] = [];
      mockClient.setBrightness.mockImplementation(async () => {
        callOrder.push('setBrightness');
        return { error_code: 0 };
      });
      mockClient.setChannel.mockImplementation(async () => {
        callOrder.push('setChannel');
        return { error_code: 0 };
      });
      mockClient.getConfig.mockImplementation(async () => {
        callOrder.push('getConfig');
        return {
          Brightness: 50,
          RotationFlag: 0,
          ClockTime: 60,
          GalleryTime: 60,
          SingleGalleyTime: 5,
          PowerOnChannelId: 0,
          GalleryShowTimeFlag: 1,
          CurClockId: 100,
          Time24Flag: 1,
          TemperatureMode: 0,
          GyrateAngle: 0,
          MirrorFlag: 0,
          LightSwitch: 1,
          SelectIndex: 2,
          error_code: 0,
        };
      });

      const context = requestContextService.createRequestContext();
      const input = pixooControlTool.inputSchema.parse({
        brightness: 50,
        channel: 'visualizer',
      });
      await pixooControlTool.logic(input, context, mockSdkContext);

      expect(callOrder).toEqual(['setBrightness', 'setChannel', 'getConfig']);
    });
  });

  // -------------------------------------------------------------------------
  // Response formatter
  // -------------------------------------------------------------------------
  describe('responseFormatter', () => {
    it('should format output with applied changes', () => {
      const formatter = pixooControlTool.responseFormatter;
      expect(formatter).toBeDefined();

      const result = formatter!({
        brightness: 80,
        channel: 'custom',
        channelIndex: 3,
        screenOn: true,
        clockId: 182,
        applied: ['brightness=80', 'channel=custom'],
      });

      expect(result).toHaveLength(1);
      const block = result[0];
      expect(block).toBeDefined();
      if (!block || block.type !== 'text') {
        throw new Error('Expected text content block');
      }
      expect(block.text).toContain('Brightness: 80%');
      expect(block.text).toContain('Channel: custom (3)');
      expect(block.text).toContain('Screen: on');
      expect(block.text).toContain('Clock ID: 182');
      expect(block.text).toContain('Applied: brightness=80, channel=custom');
    });

    it('should omit applied line when no changes were made', () => {
      const formatter = pixooControlTool.responseFormatter;
      expect(formatter).toBeDefined();

      const result = formatter!({
        brightness: 50,
        channel: 'faces',
        channelIndex: 0,
        screenOn: false,
        clockId: 100,
        applied: [],
      });

      expect(result).toHaveLength(1);
      const block = result[0];
      expect(block).toBeDefined();
      if (!block || block.type !== 'text') {
        throw new Error('Expected text content block');
      }
      expect(block.text).toContain('Screen: off');
      expect(block.text).not.toContain('Applied:');
    });
  });

  // -------------------------------------------------------------------------
  // Tool metadata
  // -------------------------------------------------------------------------
  describe('metadata', () => {
    it('should have correct name and annotations', () => {
      expect(pixooControlTool.name).toBe('pixoo_control');
      expect(pixooControlTool.annotations?.idempotentHint).toBe(true);
      expect(pixooControlTool.annotations?.openWorldHint).toBe(false);
    });
  });
});
