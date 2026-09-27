/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`): what one render stores
 * — localStorage, IndexedDB, a cookie — is gone in the next render on the same browser,
 * and renders running at the same time each see only their own document.
 * @module tests/browser/storage-and-concurrency.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserRenderer,
  type RenderOptions,
  type RenderPage,
} from '@/services/browser/browser-renderer.js';
import { BrowserWrapper } from './helpers/browser-under-test.js';

const NATIVE: RenderOptions = { sampling: 'native', inject: [] };
const DOCUMENT_ORIGIN = 'https://pixoo.invalid/';

const WRITE_STORAGE = `(async () => {
  localStorage.setItem('probe', 'stored');
  document.cookie = 'probe=stored; max-age=3600; path=/';
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('probe-db', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('items');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put('stored', 'probe');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
})()`;

const READ_STORAGE = `(async () => ({
  localStorage: localStorage.getItem('probe'),
  cookie: document.cookie,
  indexedDB: (await indexedDB.databases()).map((d) => d.name),
}))()`;

let wrapper: BrowserWrapper;
let renderer: BrowserRenderer;
const signal = new AbortController().signal;

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
  renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
});

afterAll(async () => {
  await renderer?.close();
  expect(await wrapper?.cleanup()).toEqual([]);
});

describe('BrowserRenderer storage and concurrency on a real browser', () => {
  it('drops localStorage, IndexedDB, and cookies between renders on one browser', async () => {
    const written = await renderer.withPage(
      '<!doctype html><p>write</p>',
      NATIVE,
      async (page) => {
        await page.evaluate(WRITE_STORAGE);
        return page.evaluate(READ_STORAGE);
      },
      signal,
    );
    expect(written).toEqual({
      localStorage: 'stored',
      cookie: 'probe=stored',
      indexedDB: ['probe-db'],
    });

    const next = await renderer.withPage(
      '<!doctype html><p>read</p>',
      NATIVE,
      (page) => page.evaluate(READ_STORAGE),
      signal,
    );
    expect(next).toEqual({ localStorage: null, cookie: '', indexedDB: [] });
    expect(await wrapper.launches()).toHaveLength(1);
  });

  it('shows each of several concurrent renders only its own document', async () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    const allLive = barrier(colors.length);
    const allWrote = barrier(colors.length);
    const seen = await Promise.all(
      colors.map((color, i) =>
        renderer.withPage(
          `<!doctype html><title>render-${i}</title><body style="margin:0;background:${color}">`,
          NATIVE,
          async (page: RenderPage) => {
            await allLive();
            await page.evaluate(`localStorage.setItem('owner', 'render-${i}')`);
            await allWrote();
            const frame = await page.capture();
            return {
              ...((await page.evaluate(
                "({ title: document.title, href: location.href, owner: localStorage.getItem('owner') })",
              )) as { title: string; href: string; owner: string }),
              pixel: frame.getPixel(8, 8),
            };
          },
          signal,
        ),
      ),
    );
    seen.forEach((render, i) => {
      expect(render).toMatchObject({ title: `render-${i}`, owner: `render-${i}` });
      expect(render.href.startsWith(DOCUMENT_ORIGIN)).toBe(true);
      expect(render.pixel).toEqual(rgb(colors[i] ?? ''));
    });
    expect(new Set(seen.map((r) => r.href)).size).toBe(colors.length);
    expect(await wrapper.launches()).toHaveLength(1);
  });
});

/** Resolves every caller once `count` have called it. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    if (++arrived === count) release();
    return all;
  };
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
