/**
 * @fileoverview Tests for the pixoo_compose tool.
 * Covers keyframe interpolation (via integration), element rendering dispatch,
 * static/animated compose flows, asset pre-loading, and the response formatter.
 * @module tests/mcp-server/tools/definitions/pixoo-compose.tool.test
 */
import {
  type MockInstance,
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';

// ---------------------------------------------------------------------------
// Types for mock canvas instances
// ---------------------------------------------------------------------------
interface MockCanvas {
  clear: MockInstance;
  fillRect: MockInstance;
  drawRect: MockInstance;
  fillCircle: MockInstance;
  drawCircle: MockInstance;
  drawLine: MockInstance;
  setPixel: MockInstance;
  blit: MockInstance;
}

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() runs before vi.mock() factories
// ---------------------------------------------------------------------------
const {
  createMockCanvas,
  canvasInstancesRef,
  mockDrawText,
  mockDrawTextCentered,
  mockLoadImage,
  mockDownsampleSprite,
  mockRenderSprite,
  mockResolveColor,
  mockLerpColor,
  mockSavePng,
  mockSaveAnimationPngs,
  mockSetChannel,
  mockPush,
  mockPushAnimation,
} = vi.hoisted(
  (): {
    createMockCanvas: () => MockCanvas;
    canvasInstancesRef: { current: MockCanvas[] };
    mockDrawText: MockInstance;
    mockDrawTextCentered: MockInstance;
    mockLoadImage: MockInstance;
    mockDownsampleSprite: MockInstance;
    mockRenderSprite: MockInstance;
    mockResolveColor: MockInstance;
    mockLerpColor: MockInstance;
    mockSavePng: MockInstance;
    mockSaveAnimationPngs: MockInstance;
    mockSetChannel: MockInstance;
    mockPush: MockInstance;
    mockPushAnimation: MockInstance;
  } => {
    return {
      createMockCanvas: (): MockCanvas => ({
        clear: vi.fn(),
        fillRect: vi.fn(),
        drawRect: vi.fn(),
        fillCircle: vi.fn(),
        drawCircle: vi.fn(),
        drawLine: vi.fn(),
        setPixel: vi.fn(),
        blit: vi.fn(),
      }),
      canvasInstancesRef: { current: [] as MockCanvas[] },
      mockDrawText: vi.fn(),
      mockDrawTextCentered: vi.fn(),
      mockLoadImage: vi.fn(),
      mockDownsampleSprite: vi.fn(),
      mockRenderSprite: vi.fn(),
      mockResolveColor: vi.fn(),
      mockLerpColor: vi.fn(),
      mockSavePng: vi.fn(),
      mockSaveAnimationPngs: vi.fn(),
      mockSetChannel: vi.fn(),
      mockPush: vi.fn(),
      mockPushAnimation: vi.fn(),
    };
  },
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@cyanheads/pixoo-toolkit', () => {
  const CanvasCtor = vi.fn(function Canvas(this: MockCanvas, _size: number) {
    const instance = createMockCanvas();
    canvasInstancesRef.current.push(instance);
    Object.assign(this, instance);
  });

  return {
    Canvas: CanvasCtor,
    Channel: { Custom: 3 },
    FONT_5x7: { name: 'FONT_5x7', glyphs: {} },
    FONT_3x5: { name: 'FONT_3x5', glyphs: {} },
    drawText: mockDrawText,
    drawTextCentered: mockDrawTextCentered,
    loadImage: mockLoadImage,
    downsampleSprite: mockDownsampleSprite,
    renderSprite: mockRenderSprite,
    resolveColor: mockResolveColor,
    lerpColor: mockLerpColor,
    savePng: mockSavePng,
    saveAnimationPngs: mockSaveAnimationPngs,
  };
});

vi.mock('@/container/index.js', () => ({
  container: {
    resolve: vi.fn((token: { description: string }) => {
      if (token.description === 'PixooClient')
        return {
          setChannel: mockSetChannel,
          push: mockPush,
          pushAnimation: mockPushAnimation,
        };
      if (token.description === 'AppConfig')
        return { pixoo: { ip: '192.168.1.100', size: 64 } };
      throw new Error(`Unexpected token: ${token.description}`);
    }),
  },
}));

vi.mock('@/utils/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('@/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: (_scopes: string[], fn: (...args: unknown[]) => unknown) => fn,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import { pixooComposeTool } from '../../../../src/mcp-server/tools/definitions/pixoo-compose.tool.js';
import { requestContextService } from '../../../../src/utils/index.js';
import {
  McpError,
  JsonRpcErrorCode,
} from '../../../../src/types-global/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

/** Shorthand to get canvas instances created during a test. */
function canvasInstances() {
  return canvasInstancesRef.current;
}

function createContext() {
  return requestContextService.createRequestContext();
}

function parseInput(raw: Record<string, unknown>) {
  return pixooComposeTool.inputSchema.parse(raw);
}

async function runCompose(raw: Record<string, unknown>) {
  const input = parseInput(raw);
  return pixooComposeTool.logic(input, createContext(), mockSdkContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('pixooComposeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasInstancesRef.current = [];

    // Sensible defaults for toolkit mocks
    mockResolveColor.mockImplementation((c: string) => {
      if (c === 'red' || c === '#ff0000') return [255, 0, 0];
      if (c === 'blue' || c === '#0000ff') return [0, 0, 255];
      if (c === 'green' || c === '#00ff00') return [0, 255, 0];
      if (c === 'white' || c === '#ffffff') return [255, 255, 255];
      return [0, 0, 0];
    });

    mockLerpColor.mockImplementation((a: number[], b: number[], t: number) =>
      a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t)),
    );

    mockLoadImage.mockResolvedValue(createMockCanvas());

    mockDownsampleSprite.mockResolvedValue({
      grid: [[{ type: 'body' }]],
      bodyColor: [100, 100, 100] as [number, number, number],
      darkColor: [50, 50, 50] as [number, number, number],
      cols: 1,
      rows: 1,
    });

    mockSavePng.mockResolvedValue(undefined);
    mockSaveAnimationPngs.mockResolvedValue([
      '/tmp/out_0.png',
      '/tmp/out_1.png',
    ]);
  });

  // =========================================================================
  // Metadata
  // =========================================================================
  describe('metadata', () => {
    it('has correct name and annotations', () => {
      expect(pixooComposeTool.name).toBe('pixoo_compose');
      expect(pixooComposeTool.annotations?.destructiveHint).toBe(true);
    });
  });

  // =========================================================================
  // Static frame (frames=1) — basic compose flow
  // =========================================================================
  describe('static frame', () => {
    it('creates one canvas, clears with background, and calls client.push', async () => {
      const result = await runCompose({
        background: 'red',
        elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'white' }],
      });

      expect(result.frames).toBe(1);
      expect(result.pushed).toBe(true);
      expect(canvasInstances()).toHaveLength(1);
      expect(canvasInstances()[0]!.clear).toHaveBeenCalledWith('red');
      expect(mockSetChannel).toHaveBeenCalledWith(3); // Channel.Custom
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPushAnimation).not.toHaveBeenCalled();
    });

    it('push=false skips device push', async () => {
      const result = await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }],
        push: false,
      });

      expect(result.pushed).toBe(false);
      expect(mockSetChannel).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('saves preview PNG when output path given (static)', async () => {
      const result = await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }],
        output: '/tmp/preview.png',
      });

      expect(mockSavePng).toHaveBeenCalledTimes(1);
      expect(mockSavePng).toHaveBeenCalledWith(
        expect.anything(),
        '/tmp/preview.png',
      );
      expect(result.outputFiles).toEqual(['/tmp/preview.png']);
    });
  });

  // =========================================================================
  // Animated (frames > 1)
  // =========================================================================
  describe('animated frames', () => {
    it('creates multiple canvases and calls client.pushAnimation', async () => {
      const result = await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }],
        frames: 5,
        speed: 100,
      });

      expect(result.frames).toBe(5);
      expect(canvasInstances()).toHaveLength(5);
      expect(mockPushAnimation).toHaveBeenCalledTimes(1);
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockPushAnimation).toHaveBeenCalledWith(expect.any(Array), 100);
    });

    it('saves animation PNGs when output path given', async () => {
      const result = await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }],
        frames: 3,
        output: '/tmp/anim.png',
      });

      expect(mockSaveAnimationPngs).toHaveBeenCalledTimes(1);
      expect(result.outputFiles).toEqual(['/tmp/out_0.png', '/tmp/out_1.png']);
    });

    it('auto-switches to Custom channel before pushing animation', async () => {
      await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }],
        frames: 2,
      });

      expect(mockSetChannel).toHaveBeenCalledWith(3);
      const setChannelOrder = mockSetChannel.mock.invocationCallOrder[0]!;
      const pushAnimOrder = mockPushAnimation.mock.invocationCallOrder[0]!;
      expect(setChannelOrder).toBeLessThan(pushAnimOrder);
    });
  });

  // =========================================================================
  // Element rendering dispatch
  // =========================================================================
  describe('element rendering', () => {
    describe('text element', () => {
      it('calls drawText for non-centered text with standard font', async () => {
        await runCompose({
          elements: [
            {
              type: 'text',
              text: 'hello',
              x: 5,
              y: 10,
              color: 'white',
              font: 'standard',
            },
          ],
        });

        expect(mockDrawText).toHaveBeenCalledTimes(1);
        expect(mockDrawText).toHaveBeenCalledWith(
          expect.anything(),
          'hello',
          5,
          10,
          'white',
          expect.objectContaining({
            font: expect.objectContaining({ name: 'FONT_5x7' }),
            scale: 1,
          }),
        );
        expect(mockDrawTextCentered).not.toHaveBeenCalled();
      });

      it('calls drawTextCentered when centered=true', async () => {
        await runCompose({
          elements: [{ type: 'text', text: 'hi', y: 20, centered: true }],
        });

        expect(mockDrawTextCentered).toHaveBeenCalledTimes(1);
        expect(mockDrawTextCentered).toHaveBeenCalledWith(
          expect.anything(),
          'hi',
          20,
          'white',
          expect.objectContaining({
            font: expect.objectContaining({ name: 'FONT_5x7' }),
          }),
        );
        expect(mockDrawText).not.toHaveBeenCalled();
      });

      it('maps compact font to FONT_3x5', async () => {
        await runCompose({
          elements: [
            { type: 'text', text: 'tiny', x: 0, y: 0, font: 'compact' },
          ],
        });

        expect(mockDrawText).toHaveBeenCalledWith(
          expect.anything(),
          'tiny',
          0,
          0,
          'white',
          expect.objectContaining({
            font: expect.objectContaining({ name: 'FONT_3x5' }),
          }),
        );
      });
    });

    describe('rect element', () => {
      it('calls fillRect when fill=true (default)', async () => {
        await runCompose({
          elements: [{ type: 'rect', x: 2, y: 3, w: 10, h: 8, color: 'red' }],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.fillRect).toHaveBeenCalledWith(2, 3, 10, 8, 'red');
        expect(canvas.drawRect).not.toHaveBeenCalled();
      });

      it('calls drawRect when fill=false', async () => {
        await runCompose({
          elements: [
            {
              type: 'rect',
              x: 0,
              y: 0,
              w: 5,
              h: 5,
              fill: false,
              color: 'blue',
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.drawRect).toHaveBeenCalledWith(0, 0, 5, 5, 'blue');
        expect(canvas.fillRect).not.toHaveBeenCalled();
      });
    });

    describe('circle element', () => {
      it('calls fillCircle when fill=true (default)', async () => {
        await runCompose({
          elements: [
            { type: 'circle', cx: 32, cy: 32, radius: 10, color: 'green' },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.fillCircle).toHaveBeenCalledWith(32, 32, 10, 'green');
        expect(canvas.drawCircle).not.toHaveBeenCalled();
      });

      it('calls drawCircle when fill=false', async () => {
        await runCompose({
          elements: [
            {
              type: 'circle',
              cx: 16,
              cy: 16,
              radius: 5,
              fill: false,
              color: 'red',
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.drawCircle).toHaveBeenCalledWith(16, 16, 5, 'red');
        expect(canvas.fillCircle).not.toHaveBeenCalled();
      });
    });

    describe('line element', () => {
      it('calls drawLine with correct coords', async () => {
        await runCompose({
          elements: [
            { type: 'line', x0: 0, y0: 0, x1: 63, y1: 63, color: 'white' },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.drawLine).toHaveBeenCalledWith(0, 0, 63, 63, 'white');
      });
    });

    describe('bitmap element', () => {
      it('maps palette indices and calls setPixel for each pixel', async () => {
        await runCompose({
          elements: [
            {
              type: 'bitmap',
              x: 0,
              y: 0,
              palette: ['#ff0000', '#00ff00'],
              data: ['01', '10'],
              scale: 1,
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.setPixel).toHaveBeenCalledTimes(4);
        expect(canvas.setPixel).toHaveBeenCalledWith(0, 0, '#ff0000');
        expect(canvas.setPixel).toHaveBeenCalledWith(1, 0, '#00ff00');
        expect(canvas.setPixel).toHaveBeenCalledWith(0, 1, '#00ff00');
        expect(canvas.setPixel).toHaveBeenCalledWith(1, 1, '#ff0000');
      });

      it('scales bitmap pixels with scale multiplier', async () => {
        await runCompose({
          elements: [
            {
              type: 'bitmap',
              x: 0,
              y: 0,
              palette: ['red'],
              data: ['0'],
              scale: 3,
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        // 1 logical pixel at scale=3 -> 3*3 = 9 setPixel calls
        expect(canvas.setPixel).toHaveBeenCalledTimes(9);
      });

      it('maps alpha characters (a-z) to palette indices 10+', async () => {
        // 'a' maps to index 10
        const palette = Array.from({ length: 11 }, (_, i) =>
          i < 10 ? '' : '#abcdef',
        );
        await runCompose({
          elements: [
            {
              type: 'bitmap',
              x: 0,
              y: 0,
              palette,
              data: ['a'],
              scale: 1,
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.setPixel).toHaveBeenCalledWith(0, 0, '#abcdef');
      });

      it('skips transparent (empty string) palette entries', async () => {
        await runCompose({
          elements: [
            {
              type: 'bitmap',
              x: 0,
              y: 0,
              palette: ['', '#ff0000'],
              data: ['01'],
              scale: 1,
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        // Only index 1 gets drawn, index 0 is transparent
        expect(canvas.setPixel).toHaveBeenCalledTimes(1);
        expect(canvas.setPixel).toHaveBeenCalledWith(1, 0, '#ff0000');
      });
    });

    describe('pixels element', () => {
      it('calls setPixel for each entry in data array', async () => {
        await runCompose({
          elements: [
            {
              type: 'pixels',
              data: [
                { x: 10, y: 20, color: 'red' },
                { x: 30, y: 40, color: '#00ff00' },
              ],
            },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.setPixel).toHaveBeenCalledTimes(2);
        expect(canvas.setPixel).toHaveBeenCalledWith(10, 20, 'red');
        expect(canvas.setPixel).toHaveBeenCalledWith(30, 40, '#00ff00');
      });
    });

    describe('image element', () => {
      it('pre-loads image once via loadImage and blits per frame', async () => {
        const mockImageCanvas = createMockCanvas();
        mockLoadImage.mockResolvedValue(mockImageCanvas);

        await runCompose({
          elements: [{ type: 'image', path: '/tmp/test.png', x: 5, y: 10 }],
          frames: 3,
        });

        // loadImage called once (pre-load), not per frame
        expect(mockLoadImage).toHaveBeenCalledTimes(1);
        expect(mockLoadImage).toHaveBeenCalledWith('/tmp/test.png', {
          size: 64,
          width: 64,
          height: 64,
          fit: 'contain',
          kernel: 'nearest',
        });

        // blit called once per frame
        for (const canvas of canvasInstances()) {
          expect(canvas.blit).toHaveBeenCalledWith(mockImageCanvas, 5, 10);
        }
      });

      it('passes custom fit and kernel options to loadImage', async () => {
        await runCompose({
          elements: [
            {
              type: 'image',
              path: '/tmp/pic.png',
              width: 32,
              height: 32,
              fit: 'cover',
              kernel: 'lanczos3',
            },
          ],
        });

        expect(mockLoadImage).toHaveBeenCalledWith('/tmp/pic.png', {
          size: 64,
          width: 32,
          height: 32,
          fit: 'cover',
          kernel: 'lanczos3',
        });
      });
    });

    describe('sprite element', () => {
      it('pre-loads sprite via downsampleSprite and renders per frame', async () => {
        await runCompose({
          elements: [
            {
              type: 'sprite',
              path: '/tmp/sprite.png',
              cols: 4,
              rows: 2,
              y: 5,
            },
          ],
          frames: 2,
        });

        expect(mockDownsampleSprite).toHaveBeenCalledTimes(1);
        expect(mockDownsampleSprite).toHaveBeenCalledWith(
          '/tmp/sprite.png',
          4,
          2,
        );
        expect(mockRenderSprite).toHaveBeenCalledTimes(2);
      });

      it('passes body/dark color overrides to renderSprite', async () => {
        await runCompose({
          elements: [
            {
              type: 'sprite',
              path: '/tmp/sprite.png',
              cols: 1,
              rows: 1,
              y: 0,
              bodyColor: 'red',
              darkColor: 'blue',
            },
          ],
        });

        expect(mockRenderSprite).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            bodyColor: [255, 0, 0],
            darkColor: [0, 0, 255],
          }),
        );
      });
    });

    describe('visibility', () => {
      it('skips rendering when visible=false', async () => {
        await runCompose({
          elements: [
            { type: 'rect', x: 0, y: 0, w: 10, h: 10, visible: false },
            { type: 'rect', x: 5, y: 5, w: 10, h: 10, visible: true },
          ],
        });

        const canvas = canvasInstances()[0]!;
        expect(canvas.fillRect).toHaveBeenCalledTimes(1);
        expect(canvas.fillRect).toHaveBeenCalledWith(5, 5, 10, 10, 'white');
      });
    });

    describe('render order', () => {
      it('renders elements back-to-front (order of array)', async () => {
        await runCompose({
          elements: [
            { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
            { type: 'line', x0: 0, y0: 0, x1: 10, y1: 10 },
          ],
        });

        const canvas = canvasInstances()[0]!;
        const rectOrder = canvas.fillRect.mock.invocationCallOrder[0]!;
        const lineOrder = canvas.drawLine.mock.invocationCallOrder[0]!;
        expect(rectOrder).toBeLessThan(lineOrder);
      });
    });
  });

  // =========================================================================
  // Keyframe interpolation (tested via animated compose)
  // =========================================================================
  describe('keyframe interpolation', () => {
    it('interpolates numeric properties linearly between keyframes', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              x: [
                [0, 0],
                [4, 40],
              ],
            },
          },
        ],
        frames: 5,
      });

      // Frame 0: x=0, Frame 1: x=10, Frame 2: x=20, Frame 3: x=30, Frame 4: x=40
      const xValues = canvasInstances().map(
        (c) => c.fillRect.mock.calls[0]?.[0],
      );
      expect(xValues).toEqual([0, 10, 20, 30, 40]);
    });

    it('interpolates colors via lerpColor between keyframes', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              color: [
                [0, '#ff0000'],
                [2, '#0000ff'],
              ],
            },
          },
        ],
        frames: 3,
      });

      expect(mockResolveColor).toHaveBeenCalledWith('#ff0000');
      expect(mockResolveColor).toHaveBeenCalledWith('#0000ff');
      expect(mockLerpColor).toHaveBeenCalled();

      // The middle frame should have gotten an interpolated hex color
      const canvas1 = canvasInstances()[1]!;
      const middleColor = canvas1.fillRect.mock.calls[0]?.[4];
      expect(middleColor).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('snaps booleans at keyframe boundaries', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              visible: [
                [0, true],
                [2, false],
                [4, true],
              ],
            },
          },
        ],
        frames: 5,
      });

      // Frame 0: visible=true -> drawn
      // Frame 1: between [0,true] and [2,false], snap -> true (before hi keyframe)
      // Frame 2: visible=false -> skipped
      // Frame 3: between [2,false] and [4,true], snap -> false (before hi keyframe)
      // Frame 4: visible=true -> drawn
      const drawnFrames = canvasInstances().map(
        (c) => c.fillRect.mock.calls.length > 0,
      );
      expect(drawnFrames).toEqual([true, true, false, false, true]);
    });

    it('holds first value before first keyframe', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              x: [
                [2, 20],
                [4, 40],
              ],
            },
          },
        ],
        frames: 5,
      });

      // Frames 0,1,2 are at or before keyframe at frame 2 -> hold value 20
      const xValues = canvasInstances().map(
        (c) => c.fillRect.mock.calls[0]?.[0],
      );
      expect(xValues[0]).toBe(20);
      expect(xValues[1]).toBe(20);
      expect(xValues[2]).toBe(20);
    });

    it('holds last value after last keyframe', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              x: [
                [0, 0],
                [1, 10],
              ],
            },
          },
        ],
        frames: 4,
      });

      const xValues = canvasInstances().map(
        (c) => c.fillRect.mock.calls[0]?.[0],
      );
      expect(xValues[2]).toBe(10);
      expect(xValues[3]).toBe(10);
    });

    it('returns constant value for single keyframe', async () => {
      await runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              x: [[0, 42]],
            },
          },
        ],
        frames: 3,
      });

      const xValues = canvasInstances().map(
        (c) => c.fillRect.mock.calls[0]?.[0],
      );
      expect(xValues).toEqual([42, 42, 42]);
    });

    it('throws McpError for empty keyframe array', async () => {
      const promise = runCompose({
        elements: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            animate: {
              x: [],
            },
          },
        ],
        frames: 2,
      });

      await expect(promise).rejects.toThrow(McpError);
      await expect(promise).rejects.toHaveProperty(
        'code',
        JsonRpcErrorCode.ValidationError,
      );
    });

    it('resolves animated visibility to hide/show across frames', async () => {
      mockLoadImage.mockResolvedValue(createMockCanvas());

      await runCompose({
        elements: [
          {
            type: 'image',
            path: '/tmp/test.png',
            animate: {
              visible: [
                [0, false],
                [1, true],
              ],
            },
          },
        ],
        frames: 2,
      });

      // Frame 0: visible=false -> no blit
      expect(canvasInstances()[0]!.blit).not.toHaveBeenCalled();
      // Frame 1: visible=true -> blit called
      expect(canvasInstances()[1]!.blit).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Input schema validation
  // =========================================================================
  describe('input schema', () => {
    it('applies defaults for background, frames, speed, push', () => {
      const parsed = parseInput({
        elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }],
      });

      expect(parsed.background).toBe('black');
      expect(parsed.frames).toBe(1);
      expect(parsed.speed).toBe(150);
      expect(parsed.push).toBe(true);
    });

    it('rejects frames > 40', () => {
      expect(() =>
        parseInput({
          elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }],
          frames: 41,
        }),
      ).toThrow();
    });

    it('rejects empty elements array', () => {
      expect(() =>
        parseInput({
          elements: [],
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // Response formatter
  // =========================================================================
  describe('responseFormatter', () => {
    const formatter = pixooComposeTool.responseFormatter!;

    it('is defined', () => {
      expect(pixooComposeTool.responseFormatter).toBeDefined();
    });

    it('formats static pushed frame message', () => {
      const blocks = formatter({ frames: 1, pushed: true });
      expect(blocks).toHaveLength(1);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toBe('Pushed static frame to device');
    });

    it('formats static rendered frame message (not pushed)', () => {
      const blocks = formatter({ frames: 1, pushed: false });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toBe('Rendered static frame');
    });

    it('formats animated pushed message with frame count', () => {
      const blocks = formatter({ frames: 10, pushed: true });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toBe('Pushed 10-frame animation to device');
    });

    it('formats animated rendered message (not pushed)', () => {
      const blocks = formatter({ frames: 5, pushed: false });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toBe('Rendered 5-frame animation');
    });

    it('includes output file paths when present', () => {
      const blocks = formatter({
        frames: 1,
        pushed: true,
        outputFiles: ['/tmp/a.png', '/tmp/b.png'],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Saved: /tmp/a.png, /tmp/b.png');
    });

    it('omits saved line when no outputFiles', () => {
      const blocks = formatter({ frames: 1, pushed: true });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).not.toContain('Saved');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('handles elements without animate property across multiple frames', async () => {
      const result = await runCompose({
        elements: [
          { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
          { type: 'line', x0: 0, y0: 0, x1: 5, y1: 5 },
        ],
        frames: 3,
      });

      expect(result.frames).toBe(3);
    });

    it('handles multiple element types in one compose', async () => {
      mockLoadImage.mockResolvedValue(createMockCanvas());

      await runCompose({
        elements: [
          { type: 'rect', x: 0, y: 0, w: 64, h: 64, color: 'blue' },
          { type: 'circle', cx: 32, cy: 32, radius: 20, fill: false },
          { type: 'line', x0: 0, y0: 0, x1: 63, y1: 63 },
          { type: 'text', text: 'Hi', x: 5, y: 5 },
          { type: 'image', path: '/tmp/bg.png' },
          {
            type: 'pixels',
            data: [{ x: 0, y: 0, color: 'red' }],
          },
        ],
      });

      const canvas = canvasInstances()[0]!;
      expect(canvas.fillRect).toHaveBeenCalledTimes(1);
      expect(canvas.drawCircle).toHaveBeenCalledTimes(1);
      expect(canvas.drawLine).toHaveBeenCalledTimes(1);
      expect(mockDrawText).toHaveBeenCalledTimes(1);
      expect(canvas.blit).toHaveBeenCalledTimes(1);
      expect(canvas.setPixel).toHaveBeenCalledTimes(1);
    });

    it('resolves canvas size from AppConfig', async () => {
      await runCompose({
        elements: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }],
      });

      const { Canvas } = await import('@cyanheads/pixoo-toolkit');
      expect(Canvas).toHaveBeenCalledWith(64);
    });
  });
});
