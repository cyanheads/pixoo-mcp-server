/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`): consecutive renders share
 * one browser; the browser exits, its helper processes with it, and its temp profile is
 * deleted after the idle period (shortened here from 5 minutes) and on `close()`, which
 * the server's `teardown` calls — including while a render is still running.
 * @module tests/browser/lifecycle.test
 */

import { existsSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRenderer, type RenderOptions } from '@/services/browser/browser-renderer.js';
import { BrowserWrapper, isRunning, type Launch } from './helpers/browser-under-test.js';

const NATIVE: RenderOptions = { sampling: 'native', inject: [] };
const IDLE_MS = 1_500;
const signal = new AbortController().signal;

let wrapper: BrowserWrapper;

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
});

afterAll(async () => {
  expect(await wrapper?.cleanup()).toEqual([]);
});

function renderColor(renderer: BrowserRenderer, color: string) {
  return renderer.withPage(
    `<!doctype html><body style="margin:0;background:${color}">`,
    NATIVE,
    async (page) => (await page.capture()).getPixel(8, 8),
    signal,
  );
}

async function launchesSince(count: number): Promise<Launch[]> {
  return (await wrapper.launches()).slice(count);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` every 100 ms until it holds, up to 10 s; returns whether it held. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<boolean> {
  const until = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > until) return false;
    await sleep(100);
  }
  return true;
}

const noSurvivors = async () => (await wrapper.survivors()).length === 0;

describe('BrowserRenderer lifecycle on a real browser', () => {
  it('launches one browser for consecutive renders, each of which restarts the idle period', async () => {
    const before = (await wrapper.launches()).length;
    const renderer = new BrowserRenderer({
      browserPath: wrapper.executablePath,
      size: 16,
      idleMs: IDLE_MS,
    });
    try {
      expect(await renderColor(renderer, '#ff0000')).toEqual([255, 0, 0]);
      await sleep(IDLE_MS * 0.6);
      expect(await renderColor(renderer, '#0000ff')).toEqual([0, 0, 255]);
      await sleep(IDLE_MS * 0.6);

      const launches = await launchesSince(before);
      expect(launches).toHaveLength(1);
      expect(isRunning(launches[0]?.pid ?? 0)).toBe(true);
    } finally {
      await renderer.close();
    }
  });

  it('exits after the idle period, deleting its profile, and the next render relaunches', async () => {
    const before = (await wrapper.launches()).length;
    const renderer = new BrowserRenderer({
      browserPath: wrapper.executablePath,
      size: 16,
      idleMs: IDLE_MS,
    });
    try {
      expect(await renderColor(renderer, '#ff0000')).toEqual([255, 0, 0]);
      const [first] = await launchesSince(before);
      if (!first) throw new Error('The render launched no browser.');
      expect(first.profile).not.toBe('');
      expect(existsSync(first.profile)).toBe(true);
      expect(isRunning(first.pid)).toBe(true);

      expect(await eventually(() => !isRunning(first.pid))).toBe(true);
      expect(await eventually(() => !existsSync(first.profile))).toBe(true);
      expect(await eventually(noSurvivors)).toBe(true);

      expect(await renderColor(renderer, '#00ff00')).toEqual([0, 255, 0]);
      const launches = await launchesSince(before);
      expect(launches).toHaveLength(2);
      expect(launches[1]?.profile).not.toBe(first.profile);
    } finally {
      await renderer.close();
    }
  });

  it('exits on close(), with its profile already deleted when close() resolves', async () => {
    const before = (await wrapper.launches()).length;
    const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
    expect(await renderColor(renderer, '#ff0000')).toEqual([255, 0, 0]);
    const [browser] = await launchesSince(before);
    if (!browser) throw new Error('The render launched no browser.');

    await renderer.close();

    expect(isRunning(browser.pid)).toBe(false);
    expect(existsSync(browser.profile)).toBe(false);
    expect(await eventually(noSurvivors)).toBe(true);
  });

  it('exits on close() while a render is running, which fails render_crashed', async () => {
    const before = (await wrapper.launches()).length;
    const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
    let entered: () => void = () => {};
    const inUse = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = renderer
      .withPage(
        '<!doctype html><p>busy</p>',
        NATIVE,
        (page) => {
          entered();
          return page.evaluate('new Promise(() => {})');
        },
        signal,
      )
      .then(
        () => undefined,
        (err: McpError) => err,
      );
    await inUse;
    const [browser] = await launchesSince(before);
    if (!browser) throw new Error('The render launched no browser.');

    await renderer.close();

    const err = await running;
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data).toMatchObject({ reason: 'render_crashed', retryable: true });
    expect(isRunning(browser.pid)).toBe(false);
    expect(existsSync(browser.profile)).toBe(false);
    expect(await eventually(noSurvivors)).toBe(true);
  });
});
