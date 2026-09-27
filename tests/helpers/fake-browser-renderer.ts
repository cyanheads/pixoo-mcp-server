/**
 * @fileoverview A stand-in for the shared `BrowserRenderer` that launches no browser, for
 * tool tests under `vi.mock('@/services/browser/browser-renderer.js')`. Each render runs
 * the injected sources, then the inline `<script>` bodies of the served html, in a
 * `node:vm` context with a stub `document` — enough for the real virtual clock to step
 * frames and call `window.render`. There is no layout: a capture, `PIXOO_SIZE` square as
 * the real one is, paints a solid fill when
 * the page sets `globalThis.fill = [r, g, b]`, else a gradient that shifts with the
 * capture's index. `console.error` and uncaught timer errors land in `pageErrors`, after a
 * `Blocked request: <url>` entry for each network `src` attribute, worded as the real
 * renderer's Fetch gate words it.
 * @module tests/helpers/fake-browser-renderer
 */

import * as vm from 'node:vm';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';
import { Canvas } from '@cyanheads/pixoo-toolkit';
import { getServerConfig } from '@/config/server-config.js';
import type {
  BrowserRenderer,
  RenderOptions,
  RenderPage,
} from '@/services/browser/browser-renderer.js';

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/**
 * A stand-in for the `pixoo` runtime bundle, which a unit run need not have built, for
 * `vi.mock('@/renderer/page-scripts.js')` to return from `pageRuntime`. Like the real
 * runtime, it reads the size the tool injects ahead of it.
 */
export const PAGE_RUNTIME_STUB = 'globalThis.pixoo = { size: globalThis.__PIXOO_SIZE__ };';

/** One `withPage` call, as the tool made it. */
export interface FakeRenderCall {
  /** Captures taken. */
  captures: number;
  /** Expressions passed to `evaluate`, in order. */
  evaluated: string[];
  html: string;
  opts: RenderOptions;
  signal: AbortSignal;
}

export interface FakeRendererOptions {
  /** Thrown by `withPage` before any page loads, as a real renderer's launch failure is. */
  fail?: Error;
}

/** The `browser_unavailable` failure a renderer with no browser throws. */
export function browserUnavailableError(): Error {
  return configurationError('No browser found to render HTML with.', {
    reason: 'browser_unavailable',
  });
}

/** A gradient whose colors shift with `index`, so every capture differs from the last. */
function shiftingFrame(index: number, size: number): Canvas {
  const canvas = new Canvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      canvas.setPixel(x, y, [(x * 4 + index * 16) & 255, (y * 4) & 255, (index * 40) & 255]);
    }
  }
  return canvas;
}

function styledElement() {
  const inline = new Map<string, string>();
  return {
    computed: { backgroundColor: TRANSPARENT, backgroundImage: 'none' },
    style: {
      getPropertyValue: (name: string) => inline.get(name) ?? '',
      removeProperty: (name: string) => void inline.delete(name),
      setProperty: (name: string, value: string) => void inline.set(name, value),
    },
  };
}

/** The inline script bodies of `html`, in document order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? '');
}

/** The network URLs `html` names in `src` attributes, in document order. */
function networkSources(html: string): string[] {
  return [...html.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(
    (match) => match[1] ?? '',
  );
}

function loadPage(
  html: string,
  opts: RenderOptions,
  call: FakeRenderCall,
  size: number,
): RenderPage {
  const pageErrors = networkSources(html).map((url) => `Blocked request: ${url}`);
  const report = (err: unknown) => pageErrors.push(`Uncaught ${String(err)}`);
  const context = vm.createContext({
    console: { error: (...args: unknown[]) => pageErrors.push(args.map(String).join(' ')) },
    document: {
      body: styledElement(),
      documentElement: styledElement(),
      getAnimations: () => [],
      timeline: {},
    },
    getComputedStyle: (el: ReturnType<typeof styledElement>) => el.computed,
    performance: {},
    reportError: report,
    setTimeout,
  });
  vm.runInContext('globalThis.top = globalThis; globalThis.window = globalThis;', context);
  for (const source of [...opts.inject, ...inlineScripts(html)]) {
    try {
      vm.runInContext(source, context);
    } catch (err) {
      report(err);
    }
  }
  return {
    pageErrors,
    async evaluate(expression) {
      try {
        return await vm.runInContext(expression, context);
      } catch (err) {
        throw new Error(`Uncaught ${String(err)}`);
      }
    },
    async capture() {
      const fill = vm.runInContext('globalThis.fill', context) as unknown;
      const index = call.captures++;
      return Array.isArray(fill)
        ? new Canvas(size).clear(fill as [number, number, number])
        : shiftingFrame(index, size);
    },
  };
}

let current: { calls: FakeRenderCall[]; options: FakeRendererOptions } = {
  calls: [],
  options: {},
};

/** Replace the fake's behavior and forget earlier calls; returns the new call log. */
export function installFakeBrowserRenderer(options: FakeRendererOptions = {}): FakeRenderCall[] {
  current = { calls: [], options };
  return current.calls;
}

/** The mocked `getBrowserRenderer`: a renderer that records each call and runs no browser. */
export function getFakeBrowserRenderer(): BrowserRenderer {
  const { calls, options } = current;
  const renderer = {
    async withPage<T>(
      html: string,
      opts: RenderOptions,
      use: (page: RenderPage) => Promise<T>,
      signal: AbortSignal,
    ): Promise<T> {
      const call: FakeRenderCall = { captures: 0, evaluated: [], html, opts, signal };
      calls.push(call);
      if (options.fail) throw options.fail;
      const page = loadPage(html, opts, call, getServerConfig().pixooSize);
      return use({
        pageErrors: page.pageErrors,
        capture: () => page.capture(),
        evaluate: (expression) => {
          call.evaluated.push(expression);
          return page.evaluate(expression);
        },
      });
    },
  };
  return renderer as unknown as BrowserRenderer;
}
