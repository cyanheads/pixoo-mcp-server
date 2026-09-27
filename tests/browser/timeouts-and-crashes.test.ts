/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`): a page that never yields
 * — a busy loop at load, in an evaluated call, or in a microtask chain — fails
 * `render_timeout` at the deadline, and the next call renders on the same browser: the
 * browser disposes the hung page's context without the grace kill. Killing the browser mid-
 * render fails that render `render_crashed`, and the next call relaunches; killing only
 * the page's renderer process fails it the same way, and the next call reuses the browser.
 * @module tests/browser/timeouts-and-crashes.test
 */

import { existsSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserRenderer,
  type RenderOptions,
  type RenderPage,
} from '@/services/browser/browser-renderer.js';
import { BrowserWrapper, isRunning, type Launch } from './helpers/browser-under-test.js';

const NATIVE: RenderOptions = { sampling: 'native', inject: [] };
const RED_PAGE = '<!doctype html><body style="margin:0;background:#ff0000">';
/** Shortened from the 30 s default so each hung render costs 2 s. */
const DEADLINE_MS = 2_000;
const signal = new AbortController().signal;

let wrapper: BrowserWrapper;

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
});

afterAll(async () => {
  expect(await wrapper?.cleanup()).toEqual([]);
});

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (err) {
    return err as McpError;
  }
  throw new Error('Expected the render to fail, but it resolved.');
}

/** The centre pixel of a render of {@link RED_PAGE}. */
function renderRed(renderer: BrowserRenderer) {
  return renderer.withPage(
    RED_PAGE,
    NATIVE,
    async (page) => (await page.capture()).getPixel(8, 8),
    signal,
  );
}

async function lastLaunch(): Promise<Launch> {
  const launch = (await wrapper.launches()).at(-1);
  if (!launch) throw new Error('No browser has launched.');
  return launch;
}

/** Pids of this wrapper's renderer processes. */
async function rendererPids(): Promise<number[]> {
  return (await wrapper.survivors())
    .filter((s) => s.command.includes('--type=renderer'))
    .map((s) => s.pid);
}

/** Poll `check` every 100 ms until it holds, up to 5 s; returns whether it held. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<boolean> {
  const until = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

describe('a page that never yields', () => {
  let renderer: BrowserRenderer;

  beforeAll(() => {
    renderer = new BrowserRenderer({
      browserPath: wrapper.executablePath,
      size: 16,
      deadlineMs: DEADLINE_MS,
    });
  });

  afterAll(async () => {
    await renderer?.close();
  });

  it.each<[string, string, (page: RenderPage) => Promise<unknown>]>([
    [
      'a busy loop at load',
      '<!doctype html><script>for (;;) {}</script>',
      (page) => page.capture(),
    ],
    [
      'a busy loop in an evaluated call',
      '<!doctype html><p>idle</p>',
      (page) => page.evaluate('for (;;) {}'),
    ],
    [
      'a microtask chain',
      '<!doctype html><p>idle</p>',
      (page) => page.evaluate('(() => { const spin = () => queueMicrotask(spin); spin(); })()'),
    ],
  ])('%s fails render_timeout at the deadline, and the next call renders', async (_, html, use) => {
    const started = performance.now();
    const err = await rejection(renderer.withPage(html, NATIVE, use, signal));
    const elapsed = performance.now() - started;

    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBe('render_timeout');
    expect(err.message).toBe(`The render did not finish within ${DEADLINE_MS} ms.`);
    // Disposing the hung page's context returned at once: the 5 s grace kill never fired.
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1_000);
    const launches = await wrapper.launches();
    expect(launches).toHaveLength(1);
    expect(isRunning(launches[0]?.pid ?? 0)).toBe(true);
    // The spinning renderer process went with its context.
    expect(await eventually(async () => (await rendererPids()).length === 0)).toBe(true);

    await expect(renderRed(renderer)).resolves.toEqual([255, 0, 0]);
    expect(await wrapper.launches()).toHaveLength(1);
  });
});

describe('a crash mid-render', () => {
  it('fails render_crashed when the browser is killed, and the next call relaunches', async () => {
    const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
    try {
      let killed: Launch | undefined;
      const err = await rejection(
        renderer.withPage(
          RED_PAGE,
          NATIVE,
          async (page) => {
            killed = await lastLaunch();
            const pending = page.evaluate('new Promise(() => {})');
            process.kill(killed.pid, 'SIGKILL');
            return pending;
          },
          signal,
        ),
      );

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'render_crashed', retryable: true });
      expect(err.message).toBe('The browser exited during the render.');
      // The render fails as the pipe closes, which can be a moment before the pid is reaped.
      const dead = killed as Launch;
      expect(await eventually(() => !isRunning(dead.pid))).toBe(true);
      expect(await eventually(() => !existsSync(dead.profile))).toBe(true);

      await expect(renderRed(renderer)).resolves.toEqual([255, 0, 0]);
      const relaunched = await lastLaunch();
      expect(relaunched.pid).not.toBe(dead.pid);
      expect(isRunning(relaunched.pid)).toBe(true);
    } finally {
      await renderer.close();
    }
  });

  it("fails render_crashed when the page's renderer process is killed, and the next call reuses the browser", async () => {
    const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
    try {
      let victims: number[] = [];
      const err = await rejection(
        renderer.withPage(
          RED_PAGE,
          NATIVE,
          async (page) => {
            victims = await rendererPids();
            const pending = page.evaluate('new Promise(() => {})');
            for (const pid of victims) process.kill(pid, 'SIGKILL');
            return pending;
          },
          signal,
        ),
      );

      expect(victims.length).toBeGreaterThan(0);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'render_crashed', retryable: true });
      expect(err.message).toBe('The page crashed during the render.');
      const browser = await lastLaunch();
      expect(isRunning(browser.pid)).toBe(true);

      await expect(renderRed(renderer)).resolves.toEqual([255, 0, 0]);
      expect(await lastLaunch()).toEqual(browser);
    } finally {
      await renderer.close();
    }
  });
});
