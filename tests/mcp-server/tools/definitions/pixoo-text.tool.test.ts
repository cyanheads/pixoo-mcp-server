/**
 * @fileoverview Tests for the pixoo_text tool.
 * @module tests/mcp-server/tools/definitions/pixoo-text.tool.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively touches them
// ---------------------------------------------------------------------------

const mockSendText = vi.fn();
const mockClearText = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/container/core/container.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    container: {
      resolve: (...args: unknown[]) => mockResolve(...args),
    },
  };
});

vi.mock('@/config/index.js', () => ({
  config: {
    mcpServerName: 'test-server',
    mcpServerVersion: '1.0.0',
    environment: 'test',
    pixoo: { ip: '192.168.1.100', size: 64 },
  },
}));

vi.mock('@cyanheads/pixoo-toolkit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveColor: vi.fn(() => [255, 255, 255]),
  };
});

vi.mock('@/utils/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    requestContextService: {
      createRequestContext: vi.fn(() => ({
        requestId: 'test-req-id',
        timestamp: new Date().toISOString(),
        operation: 'test',
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------
import { pixooTextTool } from '../../../../src/mcp-server/tools/definitions/pixoo-text.tool.js';
import {
  AppConfig,
  PixooClientToken,
} from '../../../../src/container/core/tokens.js';
import { resolveColor } from '@cyanheads/pixoo-toolkit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

const mockClient = {
  sendText: mockSendText,
  clearText: mockClearText,
};

const mockConfig = {
  pixoo: { ip: '192.168.1.100', size: 64 },
};

function setupResolve() {
  mockResolve.mockImplementation((token: unknown) => {
    if (token === PixooClientToken) return mockClient;
    if (token === AppConfig) return mockConfig;
    throw new Error(`Unexpected token resolved: ${String(token)}`);
  });
}

function createContext() {
  return {
    requestId: 'test-req-id',
    timestamp: new Date().toISOString(),
    operation: 'pixoo_text',
  };
}

function parseInput(raw: Record<string, unknown>) {
  return pixooTextTool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('pixooTextTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupResolve();
    (resolveColor as ReturnType<typeof vi.fn>).mockReturnValue([255, 255, 255]);
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------
  it('should have correct metadata', () => {
    expect(pixooTextTool.name).toBe('pixoo_text');
    expect(pixooTextTool.title).toBe('Pixoo Text');
    expect(pixooTextTool.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------
  it('should apply correct default values via schema', () => {
    const input = parseInput({ text: 'hello' });
    expect(input).toMatchObject({
      text: 'hello',
      id: 0,
      x: 0,
      y: 0,
      direction: 'left',
      font: 0,
      speed: 50,
      color: 'white',
      align: 'left',
      clear: false,
    });
    expect(input.width).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // sendText — basic call
  // -------------------------------------------------------------------------
  it('should call sendText with correctly mapped parameters', async () => {
    const input = parseInput({ text: 'hello' });
    const result = await pixooTextTool.logic(
      input,
      createContext(),
      mockSdkContext,
    );

    expect(mockSendText).toHaveBeenCalledOnce();
    expect(mockSendText).toHaveBeenCalledWith({
      id: 0,
      x: 0,
      y: 0,
      text: 'hello',
      dir: 0,
      font: 0,
      width: 64,
      speed: 50,
      color: [255, 255, 255],
      align: 1,
    });
    expect(result).toEqual({ id: 0, action: 'set', text: 'hello' });
  });

  // -------------------------------------------------------------------------
  // Direction mapping
  // -------------------------------------------------------------------------
  it("should map direction 'left' to 0", async () => {
    const input = parseInput({ text: 'a', direction: 'left' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ dir: 0 }),
    );
  });

  it("should map direction 'right' to 1", async () => {
    const input = parseInput({ text: 'a', direction: 'right' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ dir: 1 }),
    );
  });

  // -------------------------------------------------------------------------
  // Align mapping
  // -------------------------------------------------------------------------
  it("should map align 'left' to 1", async () => {
    const input = parseInput({ text: 'a', align: 'left' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ align: 1 }),
    );
  });

  it("should map align 'center' to 2", async () => {
    const input = parseInput({ text: 'a', align: 'center' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ align: 2 }),
    );
  });

  it("should map align 'right' to 3", async () => {
    const input = parseInput({ text: 'a', align: 'right' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ align: 3 }),
    );
  });

  // -------------------------------------------------------------------------
  // Color resolution
  // -------------------------------------------------------------------------
  it('should resolve color via resolveColor and pass the result', async () => {
    (resolveColor as ReturnType<typeof vi.fn>).mockReturnValue([255, 0, 128]);

    const input = parseInput({ text: 'a', color: '#FF0080' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(resolveColor).toHaveBeenCalledWith('#FF0080');
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ color: [255, 0, 128] }),
    );
  });

  // -------------------------------------------------------------------------
  // Width defaults to display size
  // -------------------------------------------------------------------------
  it('should default width to config.pixoo.size when not provided', async () => {
    const input = parseInput({ text: 'a' });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ width: 64 }),
    );
  });

  it('should use explicit width when provided', async () => {
    const input = parseInput({ text: 'a', width: 32 });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ width: 32 }),
    );
  });

  // -------------------------------------------------------------------------
  // Custom parameters pass through
  // -------------------------------------------------------------------------
  it('should pass through all custom parameters correctly', async () => {
    const input = parseInput({
      text: 'custom',
      id: 5,
      x: 10,
      y: 20,
      direction: 'right',
      font: 18,
      width: 48,
      speed: 100,
      color: 'red',
      align: 'center',
    });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(mockSendText).toHaveBeenCalledWith({
      id: 5,
      x: 10,
      y: 20,
      text: 'custom',
      dir: 1,
      font: 18,
      width: 48,
      speed: 100,
      color: [255, 255, 255],
      align: 2,
    });
    expect(resolveColor).toHaveBeenCalledWith('red');
  });

  // -------------------------------------------------------------------------
  // Clear text
  // -------------------------------------------------------------------------
  it('should call clearText instead of sendText when clear=true', async () => {
    const input = parseInput({ text: 'ignored', id: 3, clear: true });
    const result = await pixooTextTool.logic(
      input,
      createContext(),
      mockSdkContext,
    );

    expect(mockClearText).toHaveBeenCalledOnce();
    expect(mockClearText).toHaveBeenCalledWith(3);
    expect(mockSendText).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 3, action: 'cleared' });
    expect(result.text).toBeUndefined();
  });

  it('should not call resolveColor when clearing', async () => {
    const input = parseInput({ text: 'ignored', clear: true });
    await pixooTextTool.logic(input, createContext(), mockSdkContext);

    expect(resolveColor).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Response formatter
  // -------------------------------------------------------------------------
  describe('responseFormatter', () => {
    it('should format a set action with text', () => {
      const formatter = pixooTextTool.responseFormatter;
      expect(formatter).toBeDefined();

      const result = formatter!({ id: 0, action: 'set', text: 'hello world' });

      expect(result).toHaveLength(1);
      const block = result[0];
      expect(block).toBeDefined();
      if (!block || block.type !== 'text')
        throw new Error('Expected text content block');
      expect(block.text).toBe('Set text overlay 0: "hello world"');
    });

    it('should format a cleared action', () => {
      const formatter = pixooTextTool.responseFormatter;
      expect(formatter).toBeDefined();

      const result = formatter!({ id: 7, action: 'cleared' });

      expect(result).toHaveLength(1);
      const block = result[0];
      expect(block).toBeDefined();
      if (!block || block.type !== 'text')
        throw new Error('Expected text content block');
      expect(block.text).toBe('Cleared text overlay 7');
    });
  });

  // -------------------------------------------------------------------------
  // Schema validation
  // -------------------------------------------------------------------------
  describe('input schema validation', () => {
    it('should reject empty text', () => {
      expect(() => parseInput({ text: '' })).toThrow();
    });

    it('should reject id out of range', () => {
      expect(() => parseInput({ text: 'a', id: 20 })).toThrow();
      expect(() => parseInput({ text: 'a', id: -1 })).toThrow();
    });

    it('should reject font out of range', () => {
      expect(() => parseInput({ text: 'a', font: 115 })).toThrow();
      expect(() => parseInput({ text: 'a', font: -1 })).toThrow();
    });

    it('should reject width less than 1', () => {
      expect(() => parseInput({ text: 'a', width: 0 })).toThrow();
    });

    it('should reject invalid direction', () => {
      expect(() => parseInput({ text: 'a', direction: 'up' })).toThrow();
    });

    it('should reject invalid align', () => {
      expect(() => parseInput({ text: 'a', align: 'middle' })).toThrow();
    });
  });
});
