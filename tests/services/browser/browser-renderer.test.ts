/**
 * @fileoverview Tests for `BrowserRenderer.withPage` against the fake CDP endpoint: launch
 * flags and profile preferences, the per-render context and its proxy, the Fetch gate on
 * the browser session (the document's CSP, `BlockedByClient` for everything else,
 * per-render paths), capture at scale factor 1 and 8, `pageErrors`, the deadline and
 * cancellation, crashes, and the launch/reuse/idle/close lifecycle. Every browser here is
 * the fake executable; no real browser is launched.
 * @module tests/services/browser/browser-renderer.test
 */

import { spawnSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import type { Canvas } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserRenderer,
  type BrowserRendererOptions,
  IDLE_CLOSE_MS,
  RENDER_DEADLINE_MS,
  type RenderOptions,
  type RenderPage,
} from '@/services/browser/browser-renderer.js';
import { isolateTmpdir } from '../../helpers/device-failure.js';
import {
  type CdpCommand,
  type CommandHandler,
  type FakeBrowser,
  FakeCdpEndpoint,
} from './fake-cdp-endpoint.js';

const NATIVE: RenderOptions = { sampling: 'native', inject: [] };
const SUPERSAMPLE: RenderOptions = { sampling: 'supersample', inject: [] };
const HTML = '<!doctype html><p>hello</p>';
const never = () => new Promise<never>(() => {});

let endpoint: FakeCdpEndpoint;
let renderer: BrowserRenderer;
let counter = 0;

/** The target a page session belongs to; the fake names sessions after their target. */
const targetOf = (command: CdpCommand) => (command.sessionId ?? '').replace('session-for-', '');

/** A panel frame whose every pixel differs from its neighbours. */
function panel(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      rgba.set(
        [(x * 37 + y) % 256, (y * 53 + x * 3) % 256, (x * y * 7) % 256, 255],
        (y * size + x) * 4,
      );
    }
  }
  return rgba;
}

/** `rgba` with every pixel grown to a `scale`×`scale` block. */
function upscale(rgba: Uint8Array, size: number, scale: number): Uint8Array {
  const side = size * scale;
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const from = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      out.set(rgba.subarray(from, from + 4), (y * side + x) * 4);
    }
  }
  return out;
}

async function png(rgba: Uint8Array, side: number): Promise<string> {
  const buffer = await sharp(Buffer.from(rgba), { raw: { width: side, height: side, channels: 4 } })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

/** Serve the document to its frame, then fire `load` for the navigation's loader. */
const navigateAndLoad: CommandHandler = async (command, browser) => {
  const targetId = targetOf(command);
  const requestId = `document-${++counter}`;
  browser.emit('Fetch.requestPaused', {
    requestId,
    request: { url: command.params.url, method: 'GET', headers: {} },
    frameId: targetId,
    resourceType: 'Document',
  });
  await browser.waitForCommand('Fetch.fulfillRequest', (c) => c.params.requestId === requestId);
  const loaderId = `loader-${++counter}`;
  setImmediate(() =>
    browser.emit(
      'Page.lifecycleEvent',
      { frameId: targetId, loaderId, name: 'load', timestamp: 1 },
      command.sessionId,
    ),
  );
  return { frameId: targetId, loaderId };
};

/** Answer with the panel pattern, grown by the scale factor the page's metrics set. */
const screenshot: CommandHandler = async (command, browser) => {
  const metrics = browser.commands.findLast(
    (c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.sessionId === command.sessionId,
  )?.params as { width: number; deviceScaleFactor: number };
  const { width: size, deviceScaleFactor: scale } = metrics;
  return { data: await png(upscale(panel(size), size, scale), size * scale) };
};

function makeRenderer(options: BrowserRendererOptions = {}): BrowserRenderer {
  renderer = new BrowserRenderer({
    browserPath: endpoint.executablePath,
    size: 16,
    deadlineMs: 5_000,
    graceMs: 1_000,
    idleMs: 60_000,
    ...options,
  });
  return renderer;
}

function render<T>(
  use: (page: RenderPage) => Promise<T>,
  opts: RenderOptions = NATIVE,
  signal: AbortSignal = new AbortController().signal,
  html = HTML,
): Promise<T> {
  return renderer.withPage(html, opts, use, signal);
}

const browser = (i = 0): FakeBrowser => endpoint.browsers[i] as FakeBrowser;
const commandsOf = (method: string, i = 0) =>
  browser(i).commands.filter((c) => c.method === method);
const profileOf = (i = 0) =>
  (browser(i).launch?.argv.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice(
    '--user-data-dir='.length,
  );
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  return (await promise.then(
    () => expect.unreachable('expected a rejection'),
    (err: unknown) => err,
  )) as McpError;
}

beforeEach(async () => {
  endpoint = await FakeCdpEndpoint.start();
  const ok = () => ({});
  for (const method of [
    'Fetch.enable',
    'Fetch.fulfillRequest',
    'Fetch.failRequest',
    'Page.enable',
    'Runtime.enable',
    'Log.enable',
    'Inspector.enable',
    'Page.setLifecycleEventsEnabled',
    'Emulation.setDeviceMetricsOverride',
    'Target.disposeBrowserContext',
  ]) {
    endpoint.handle(method, ok);
  }
  endpoint
    .handle('Target.createBrowserContext', () => ({ browserContextId: `context-${++counter}` }))
    .handle('Target.createTarget', () => ({ targetId: `target-${++counter}` }))
    .handle('Target.attachToTarget', (c) => ({ sessionId: `session-for-${c.params.targetId}` }))
    .handle('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: `${++counter}` }))
    .handle('Page.navigate', navigateAndLoad)
    .handle('Page.captureScreenshot', screenshot)
    .handle('Runtime.evaluate', () => ({ result: { type: 'number', value: 42 } }));
  makeRenderer();
});

afterEach(async () => {
  await renderer.close();
  await endpoint.close();
});

describe('launch', () => {
  it('launches with the pipe, a temp profile, a dead proxy, and WebRTC UDP closed', async () => {
    await render(async () => {});
    const argv = browser().launch?.argv ?? [];
    const profile = profileOf();
    expect(argv).toEqual([
      '--headless',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-sync',
      '--disable-breakpad',
      '--no-pings',
      '--mute-audio',
      '--hide-scrollbars',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--user-data-dir=${profile}`,
    ]);
    expect(profile.startsWith(path.join(os.tmpdir(), 'pixoo-browser-'))).toBe(true);
    expect(argv.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });

  it("writes webrtc.ip_handling_policy into the profile's Default/Preferences", async () => {
    await render(async () => {});
    expect(JSON.parse(browser().launch?.preferences ?? 'null')).toEqual({
      webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
    });
  });

  it("names the profile after the server's pid and removes profiles whose server is gone", async () => {
    const tmp = await isolateTmpdir();
    try {
      // Exited and reaped by the time spawnSync returns: a server that was SIGKILLed.
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      const stale = path.join(tmp.dir, `pixoo-browser-${deadPid}-Ab12Cd`);
      const kept = [
        path.join(tmp.dir, `pixoo-browser-${process.ppid}-Ef34Gh`), // another live server
        path.join(tmp.dir, `pixoo-browser-${process.pid}-Ij56Kl`), // this server's own
        path.join(tmp.dir, 'pixoo-browser-Mn78Op'), // no owner pid to check
        path.join(tmp.dir, 'pixoo-browser-suite-Qr90St'),
      ];
      for (const dir of [stale, ...kept]) {
        await mkdir(path.join(dir, 'Default'), { recursive: true });
      }

      await render(async () => {});

      expect(await exists(stale)).toBe(false);
      for (const dir of kept) expect(await exists(dir)).toBe(true);
      expect(path.dirname(profileOf())).toBe(tmp.dir);
      expect(path.basename(profileOf())).toMatch(
        new RegExp(`^pixoo-browser-${process.pid}-[A-Za-z0-9]{6}$`),
      );
    } finally {
      await renderer.close();
      tmp.restore();
    }
  });

  it('enables Fetch on the browser session for every URL before anything else', async () => {
    await render(async () => {});
    const [first] = browser().commands;
    expect(first?.method).toBe('Fetch.enable');
    expect(first?.sessionId).toBeUndefined();
    expect(first?.params).toEqual({ patterns: [{ urlPattern: '*' }] });
  });

  it('fails browser_unavailable naming a PIXOO_BROWSER_PATH that does not exist, launching nothing', async () => {
    const missing = path.join(os.tmpdir(), 'pixoo-no-such-browser', 'chrome-headless-shell');
    makeRenderer({ browserPath: missing });
    const err = await rejection(render(async () => {}));
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(err.data?.reason).toBe('browser_unavailable');
    expect(err.message).toContain(missing);
    expect(endpoint.browsers).toHaveLength(0);
  });

  it('fails browser_unavailable when the browser exits during startup, then relaunches', async () => {
    endpoint.handle('Fetch.enable', (_c, b) => {
      b.kill();
      return never();
    });
    const err = await rejection(render(async () => {}));
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(err.data?.reason).toBe('browser_unavailable');
    expect(err.message).toContain('failed to start');
    expect(await exists(profileOf(0))).toBe(false);

    endpoint.handle('Fetch.enable', () => ({}));
    await expect(render(async () => 'ok')).resolves.toBe('ok');
    expect(endpoint.browsers).toHaveLength(2);
  });
});

describe('isolation', () => {
  it('creates a context per render with a dead proxy that loopback does not bypass', async () => {
    await render(async () => {});
    await render(async () => {});
    const contexts = commandsOf('Target.createBrowserContext');
    expect(contexts).toHaveLength(2);
    for (const c of contexts) {
      expect(c.sessionId).toBeUndefined();
      expect(c.params).toEqual({
        disposeOnDetach: true,
        proxyServer: 'http://127.0.0.1:9',
        proxyBypassList: '<-loopback>',
      });
    }
  });

  it('opens each page in its own context and disposes that context afterwards', async () => {
    await render(async () => {});
    await render(async () => {});
    const created = commandsOf('Target.createTarget').map((c) => c.params.browserContextId);
    const disposed = commandsOf('Target.disposeBrowserContext').map(
      (c) => c.params.browserContextId,
    );
    expect(new Set(created).size).toBe(2);
    expect(disposed).toEqual(created);
    for (const c of commandsOf('Target.attachToTarget')) expect(c.params.flatten).toBe(true);
  });

  it('serves the document with the CSP header, at a fresh random path per render', async () => {
    await render(async () => {}, NATIVE, undefined, '<p>first</p>');
    await render(async () => {}, NATIVE, undefined, '<p>second</p>');
    const urls = commandsOf('Page.navigate').map((c) => c.params.url as string);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/pixoo\.invalid\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(urls[0]).not.toBe(urls[1]);

    const served = commandsOf('Fetch.fulfillRequest');
    expect(served).toHaveLength(2);
    expect(
      served.map((c) => Buffer.from(c.params.body as string, 'base64').toString('utf8')),
    ).toEqual(['<p>first</p>', '<p>second</p>']);
    for (const c of served) {
      expect(c.sessionId).toBeUndefined();
      expect(c.params.responseCode).toBe(200);
      expect(c.params.responseHeaders).toEqual([
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        {
          name: 'Content-Security-Policy',
          value:
            "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src 'none'",
        },
      ]);
    }
  });

  it('fails every other request as BlockedByClient, and names the page’s own in pageErrors', async () => {
    const pauses: [string, string, string][] = [];
    const errors = await render(async (page) => {
      const targetId = targetOf(commandsOf('Page.navigate')[0] as CdpCommand);
      const url = commandsOf('Page.navigate')[0]?.params.url as string;
      const b = browser();
      const pause = (
        requestId: string,
        requestUrl: string,
        frameId: string,
        resourceType: string,
      ) => {
        pauses.push([requestId, requestUrl, frameId]);
        b.emit('Fetch.requestPaused', {
          requestId,
          request: { url: requestUrl, method: 'GET', headers: {} },
          frameId,
          resourceType,
        });
      };
      pause('img', 'https://example.com/a.png', targetId, 'Image');
      pause('popup', 'https://example.com/popup', 'some-popup-frame', 'Document');
      pause('child', url, 'child-frame', 'Document'); // the document, into a child frame
      pause('lan', 'http://192.168.1.10/', targetId, 'Fetch');
      await Promise.all(
        ['img', 'popup', 'child', 'lan'].map((id) =>
          b.waitForCommand('Fetch.failRequest', (c) => c.params.requestId === id),
        ),
      );
      return [...page.pageErrors];
    });
    for (const [requestId] of pauses) {
      const failed = commandsOf('Fetch.failRequest').find((c) => c.params.requestId === requestId);
      expect(failed?.sessionId).toBeUndefined();
      expect(failed?.params.errorReason).toBe('BlockedByClient');
    }
    expect(commandsOf('Fetch.fulfillRequest')).toHaveLength(1);
    expect(errors).toEqual([
      'Blocked request: https://example.com/a.png',
      'Blocked request: http://192.168.1.10/',
    ]);
  });

  it("aborts a navigation of the page's own frame, keeping its document, and names it in pageErrors", async () => {
    let documentUrl = '';
    const errors = await render(async (page) => {
      const nav = commandsOf('Page.navigate')[0] as CdpCommand;
      documentUrl = nav.params.url as string;
      const b = browser();
      const away: [string, string][] = [
        ['away', 'https://example.com/elsewhere'],
        ['reload', documentUrl], // the document, already served
      ];
      for (const [requestId, url] of away) {
        b.emit('Fetch.requestPaused', {
          requestId,
          request: { url, method: 'GET', headers: {} },
          frameId: targetOf(nav),
          resourceType: 'Document',
        });
      }
      await Promise.all(
        away.map(([id]) => b.waitForCommand('Fetch.failRequest', (c) => c.params.requestId === id)),
      );
      return [...page.pageErrors];
    });
    for (const requestId of ['away', 'reload']) {
      const failed = commandsOf('Fetch.failRequest').find((c) => c.params.requestId === requestId);
      expect(failed?.sessionId).toBeUndefined();
      expect(failed?.params.errorReason).toBe('Aborted');
    }
    expect(commandsOf('Fetch.fulfillRequest')).toHaveLength(1);
    expect(errors).toEqual([
      'Blocked navigation: https://example.com/elsewhere',
      `Blocked navigation: ${documentUrl}`,
    ]);
  });

  it("serves a document only to its own page's frame", async () => {
    endpoint.handle('Page.navigate', async (command, b) => {
      b.emit('Fetch.requestPaused', {
        requestId: 'stranger',
        request: { url: command.params.url, method: 'GET', headers: {} },
        frameId: 'another-render-frame',
        resourceType: 'Document',
      });
      await b.waitForCommand('Fetch.failRequest', (c) => c.params.requestId === 'stranger');
      return navigateAndLoad(command, b);
    });
    await render(async () => {});
    const failed = commandsOf('Fetch.failRequest').find((c) => c.params.requestId === 'stranger');
    expect(failed?.params.errorReason).toBe('BlockedByClient');
    expect(commandsOf('Fetch.fulfillRequest')).toHaveLength(1);
  });

  it('keeps two concurrent renders apart: own context, own document, own pageErrors', async () => {
    let release!: () => void;
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded = 0;
    // `say:<text>` logs <text> as a console error on the evaluating page's own session.
    endpoint.handle('Runtime.evaluate', (c, b) => {
      const text = String(c.params.expression).replace('say:', '');
      b.emit(
        'Runtime.consoleAPICalled',
        { type: 'error', args: [{ type: 'string', value: text }] },
        c.sessionId,
      );
      return { result: { type: 'string', value: text } };
    });
    const use = (label: string) => async (page: RenderPage) => {
      if (++loaded === 2) release();
      await bothLoaded;
      await page.evaluate(`say:from ${label}`);
      return [...page.pageErrors];
    };
    const [a, b] = await Promise.all([
      render(use('a'), NATIVE, undefined, '<p>a</p>'),
      render(use('b'), NATIVE, undefined, '<p>b</p>'),
    ]);
    expect(endpoint.browsers).toHaveLength(1);
    expect(a).toEqual(['console.error: from a']);
    expect(b).toEqual(['console.error: from b']);
    const targets = commandsOf('Target.createTarget');
    expect(new Set(targets.map((c) => c.params.browserContextId)).size).toBe(2);
    // Each document went to the frame of the page that navigated to it.
    const served = commandsOf('Fetch.fulfillRequest');
    expect(served).toHaveLength(2);
    const bodies = served.map((c) =>
      Buffer.from(c.params.body as string, 'base64').toString('utf8'),
    );
    expect(bodies.sort()).toEqual(['<p>a</p>', '<p>b</p>']);
    const urls = commandsOf('Page.navigate').map((c) => c.params.url);
    expect(new Set(urls).size).toBe(2);
  });
});

describe('page', () => {
  it('runs the injected scripts, in order, before the document loads', async () => {
    await render(async () => {}, { sampling: 'native', inject: ['first()', 'second()'] });
    const commands = browser().commands;
    const injected = commands.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
    expect(injected.map((c) => c.params)).toEqual([{ source: 'first()' }, { source: 'second()' }]);
    const navigate = commands.findIndex((c) => c.method === 'Page.navigate');
    for (const c of injected) {
      expect(c.sessionId).toBe(commandsOf('Page.navigate')[0]?.sessionId);
      expect(commands.indexOf(c)).toBeLessThan(navigate);
    }
  });

  it('waits for load of its own navigation, not an earlier one', async () => {
    makeRenderer({ deadlineMs: 2_000 });
    endpoint.handle('Page.navigate', async (command, b) => {
      const targetId = targetOf(command);
      b.emit('Fetch.requestPaused', {
        requestId: 'doc',
        request: { url: command.params.url, method: 'GET', headers: {} },
        frameId: targetId,
        resourceType: 'Document',
      });
      // about:blank's load and stop, and a child frame's, arrive; this navigation's never do.
      b.emit(
        'Page.lifecycleEvent',
        { frameId: targetId, loaderId: 'blank', name: 'load' },
        command.sessionId,
      );
      b.emit(
        'Page.frameNavigated',
        { frame: { id: targetId, loaderId: 'blank', url: 'about:blank' } },
        command.sessionId,
      );
      b.emit('Page.frameStoppedLoading', { frameId: targetId }, command.sessionId);
      b.emit(
        'Page.lifecycleEvent',
        { frameId: 'child', loaderId: 'nav', name: 'load' },
        command.sessionId,
      );
      b.emit(
        'Page.frameNavigated',
        { frame: { id: 'child', parentId: targetId, loaderId: 'nav', url: 'about:blank' } },
        command.sessionId,
      );
      b.emit('Page.frameStoppedLoading', { frameId: 'child' }, command.sessionId);
      return { frameId: targetId, loaderId: 'nav' };
    });
    const use = vi.fn(async () => {});
    const err = await rejection(render(use));
    expect(err.data?.reason).toBe('render_timeout');
    expect(use).not.toHaveBeenCalled();
  });

  it('proceeds when load arrives before the navigate response', async () => {
    endpoint.handle('Page.navigate', async (command, b) => {
      const targetId = targetOf(command);
      b.emit('Fetch.requestPaused', {
        requestId: 'doc',
        request: { url: command.params.url, method: 'GET', headers: {} },
        frameId: targetId,
        resourceType: 'Document',
      });
      await b.waitForCommand('Fetch.fulfillRequest');
      b.emit(
        'Page.lifecycleEvent',
        { frameId: targetId, loaderId: 'early', name: 'load' },
        command.sessionId,
      );
      return { frameId: targetId, loaderId: 'early' };
    });
    await expect(render(async () => 'loaded')).resolves.toBe('loaded');
  });

  it('proceeds when the frame stops loading after its navigation committed, with no load event', async () => {
    // A page that navigates during load: the gate aborts that navigation, and Chrome then
    // reports the frame stopping instead of the document's load.
    endpoint.handle('Page.navigate', async (command, b) => {
      const targetId = targetOf(command);
      b.emit('Fetch.requestPaused', {
        requestId: 'doc',
        request: { url: command.params.url, method: 'GET', headers: {} },
        frameId: targetId,
        resourceType: 'Document',
      });
      await b.waitForCommand('Fetch.fulfillRequest');
      setImmediate(() => {
        b.emit(
          'Page.frameNavigated',
          { frame: { id: targetId, loaderId: 'nav', url: command.params.url } },
          command.sessionId,
        );
        b.emit('Page.frameStoppedLoading', { frameId: targetId }, command.sessionId);
      });
      return { frameId: targetId, loaderId: 'nav' };
    });
    await expect(render(async () => 'loaded')).resolves.toBe('loaded');
  });

  it('evaluates in the page, awaiting promises, and rejects with the page exception', async () => {
    endpoint.handle('Runtime.evaluate', (c) =>
      c.params.expression === 'bad()'
        ? {
            result: { type: 'object', subtype: 'error' },
            exceptionDetails: {
              text: 'Uncaught',
              exception: {
                type: 'object',
                description: 'Error: nope\n    at bad (<anonymous>:1:7)',
              },
            },
          }
        : { result: { type: 'object', value: { x: 1 } } },
    );
    const outcome = await render(async (page) => ({
      value: await page.evaluate('good()'),
      error: await page.evaluate('bad()').then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
    }));
    expect(outcome).toEqual({ value: { x: 1 }, error: 'Uncaught Error: nope' });
    const evaluate = commandsOf('Runtime.evaluate')[0];
    expect(evaluate?.params).toEqual({
      expression: 'good()',
      awaitPromise: true,
      returnByValue: true,
    });
    expect(evaluate?.sessionId).toBe(commandsOf('Page.navigate')[0]?.sessionId);
  });

  it("passes the use callback's own error through unchanged", async () => {
    const own = new Error('the tool gave up');
    await expect(render(async () => Promise.reject(own))).rejects.toBe(own);
  });

  it('collects uncaught errors, console errors, and log errors, once each, for its own session only', async () => {
    const errors = await render(async (page) => {
      const b = browser();
      const nav = commandsOf('Page.navigate')[0] as CdpCommand;
      const session = nav.sessionId;
      b.emit('Fetch.requestPaused', {
        requestId: 'gif',
        request: { url: 'https://example.com/t.gif', method: 'GET', headers: {} },
        frameId: targetOf(nav),
        resourceType: 'Image',
      });
      b.emit(
        'Runtime.exceptionThrown',
        {
          exceptionDetails: {
            text: 'Uncaught',
            exception: { type: 'object', description: 'TypeError: x is null\n    at y (z:1:2)' },
          },
        },
        session,
      );
      b.emit(
        'Runtime.exceptionThrown',
        {
          exceptionDetails: {
            text: 'Uncaught',
            exception: { type: 'string', value: 'thrown string' },
          },
        },
        session,
      );
      b.emit(
        'Runtime.consoleAPICalled',
        {
          type: 'error',
          args: [
            { type: 'string', value: 'bad' },
            { type: 'number', value: 3 },
            { type: 'object', description: 'Object' },
            { type: 'number', unserializableValue: 'NaN', description: 'NaN' },
          ],
        },
        session,
      );
      b.emit(
        'Runtime.consoleAPICalled',
        { type: 'assert', args: [{ type: 'string', value: 'Assertion failed' }] },
        session,
      );
      b.emit(
        'Runtime.consoleAPICalled',
        { type: 'log', args: [{ type: 'string', value: 'fine' }] },
        session,
      );
      b.emit(
        'Runtime.consoleAPICalled',
        { type: 'warning', args: [{ type: 'string', value: 'meh' }] },
        session,
      );
      // Chrome's CSP reports: `url` is the document's own, and a frame's text ends in a newline.
      b.emit(
        'Log.entryAdded',
        {
          entry: {
            source: 'security',
            level: 'error',
            text: 'Loading the image \'https://example.com/a.png\' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked.',
            url: nav.params.url,
          },
        },
        session,
      );
      b.emit(
        'Log.entryAdded',
        {
          entry: {
            source: 'security',
            level: 'error',
            text: "Framing 'https://example.com/' violates the following Content Security Policy directive: \"default-src 'none'\". The request has been blocked.\n",
            url: nav.params.url,
          },
        },
        session,
      );
      b.emit(
        'Log.entryAdded',
        {
          entry: {
            source: 'network',
            level: 'error',
            text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT',
            url: 'https://example.com/t.gif',
          },
        },
        session,
      );
      b.emit(
        'Log.entryAdded',
        {
          entry: {
            source: 'network',
            level: 'error',
            text: 'Failed to load resource: net::ERR_FAILED',
            url: 'data:,x',
          },
        },
        session,
      );
      b.emit(
        'Log.entryAdded',
        { entry: { source: 'other', level: 'warning', text: 'deprecated' } },
        session,
      );
      b.emit(
        'Runtime.consoleAPICalled',
        { type: 'error', args: [{ type: 'string', value: 'elsewhere' }] },
        'session-for-someone-else',
      );
      b.emit('Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ type: 'string', value: 'browser' }],
      });
      await page.evaluate('1');
      return [...page.pageErrors];
    });
    expect(errors).toEqual([
      'Blocked request: https://example.com/t.gif',
      'Uncaught TypeError: x is null',
      'Uncaught thrown string',
      'console.error: bad 3 Object NaN',
      'console.assert: Assertion failed',
      'Loading the image \'https://example.com/a.png\' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked.',
      "Framing 'https://example.com/' violates the following Content Security Policy directive: \"default-src 'none'\". The request has been blocked.",
      'Failed to load resource: net::ERR_FAILED data:,x',
    ]);
  });

  it('caps pageErrors at 100 entries of 1000 characters, then says so once', async () => {
    const errors = await render(async (page) => {
      const session = commandsOf('Page.navigate')[0]?.sessionId;
      browser().emit(
        'Runtime.consoleAPICalled',
        { type: 'error', args: [{ type: 'string', value: 'x'.repeat(5_000) }] },
        session,
      );
      for (let i = 1; i < 150; i++) {
        browser().emit(
          'Runtime.consoleAPICalled',
          { type: 'error', args: [{ type: 'string', value: `e${i}` }] },
          session,
        );
      }
      await page.evaluate('1');
      return [...page.pageErrors];
    });
    expect(errors).toHaveLength(101);
    expect(errors[0]).toBe(`console.error: ${'x'.repeat(5_000)}`.slice(0, 1_000));
    expect(errors[0]).toHaveLength(1_000);
    expect(errors[99]).toBe('console.error: e99');
    expect(errors[100]).toBe('Further page errors omitted.');
  });

  it('closes the page once the render settles', async () => {
    let kept: RenderPage | undefined;
    await render(async (page) => {
      kept = page;
    });
    await expect(kept?.capture()).rejects.toThrow('The render has finished');
  });
});

describe('capture', () => {
  it('captures a native frame at scale factor 1 over a PIXOO_SIZE viewport', async () => {
    const frame = await render((page) => page.capture());
    const metrics = commandsOf('Emulation.setDeviceMetricsOverride')[0];
    expect(metrics?.params).toEqual({ width: 16, height: 16, deviceScaleFactor: 1, mobile: false });
    expect(commandsOf('Page.captureScreenshot')[0]?.params).toEqual({ format: 'png' });
    expect([frame.width, frame.height]).toEqual([16, 16]);
    expect(frame.buffer).toEqual(panel(16));
  });

  it.each([
    [16, 128],
    [32, 256],
    [64, 512],
  ])(
    'supersamples a %i-px viewport at scale factor 8 (%i px) down to exactly the panel frame',
    async (size, side) => {
      makeRenderer({ size });
      const sides: number[] = [];
      endpoint.handle('Page.captureScreenshot', async (command, b) => {
        const result = (await screenshot(command, b)) as { data: string };
        const { width, height } = await sharp(Buffer.from(result.data, 'base64')).metadata();
        sides.push(width, height);
        return result;
      });
      const frame: Canvas = await render((page) => page.capture(), SUPERSAMPLE);
      expect(commandsOf('Emulation.setDeviceMetricsOverride')[0]?.params).toEqual({
        width: size,
        height: size,
        deviceScaleFactor: 8,
        mobile: false,
      });
      expect(sides).toEqual([side, side]);
      expect([frame.width, frame.height]).toEqual([size, size]);
      expect(frame.buffer).toEqual(panel(size));
    },
  );

  it('fails a capture whose size does not match the viewport', async () => {
    endpoint.handle('Page.captureScreenshot', async () => ({ data: await png(panel(8), 8) }));
    await expect(render((page) => page.capture())).rejects.toThrow(
      'The capture came back 8×8 px; expected 16×16.',
    );
  });
});

describe('limits', () => {
  it('defaults to a 30 s deadline and a 5 minute idle close', () => {
    expect(RENDER_DEADLINE_MS).toBe(30_000);
    expect(IDLE_CLOSE_MS).toBe(300_000);
  });

  it('fails render_timeout when the page never loads, then renders on the same browser', async () => {
    makeRenderer({ deadlineMs: 2_000 });
    endpoint.handle('Page.navigate', (c) => ({ frameId: targetOf(c), loaderId: 'stuck' }));
    const err = await rejection(render(async () => {}));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBe('render_timeout');
    expect(err.message).toBe('The render did not finish within 2000 ms.');
    expect(commandsOf('Target.disposeBrowserContext')).toHaveLength(1);

    endpoint.handle('Page.navigate', navigateAndLoad);
    await expect(render(async () => 'next')).resolves.toBe('next');
    expect(endpoint.browsers).toHaveLength(1);
  });

  it('fails render_timeout when an evaluated call never returns, and disposes its context', async () => {
    makeRenderer({ deadlineMs: 2_000 });
    endpoint.handle('Runtime.evaluate', never);
    const err = await rejection(render((page) => page.evaluate('while (true) {}')));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBe('render_timeout');
    const created = commandsOf('Target.createTarget')[0]?.params.browserContextId;
    expect(
      commandsOf('Target.disposeBrowserContext').map((c) => c.params.browserContextId),
    ).toEqual([created]);
  });

  it('fails render_timeout when the signal aborts mid-render', async () => {
    endpoint.handle('Runtime.evaluate', never);
    const controller = new AbortController();
    const pending = render(
      async (page) => {
        setTimeout(() => controller.abort(), 20);
        return page.evaluate('hang()');
      },
      NATIVE,
      controller.signal,
    );
    const err = await rejection(pending);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBe('render_timeout');
    expect(err.message).toBe('The render was cancelled before it finished.');
    expect(commandsOf('Target.disposeBrowserContext')).toHaveLength(1);
  });

  it('disposes a context the browser creates after the render was cancelled', async () => {
    const controller = new AbortController();
    endpoint.handle('Target.createBrowserContext', async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { browserContextId: 'late-context' };
    });
    const err = await rejection(render(async () => {}, NATIVE, controller.signal));
    expect(err.data?.reason).toBe('render_timeout');
    expect(commandsOf('Target.createTarget')).toHaveLength(0);
    const disposed = await browser().waitForCommand('Target.disposeBrowserContext');
    expect(disposed.params.browserContextId).toBe('late-context');
  });

  it('kills a browser that cannot dispose a hung page, and relaunches for the next render', async () => {
    makeRenderer({ deadlineMs: 2_000, graceMs: 200 });
    endpoint.handle('Runtime.evaluate', never).handle('Target.disposeBrowserContext', never);
    const err = await rejection(render((page) => page.evaluate('while (true) {}')));
    expect(err.data?.reason).toBe('render_timeout');
    const first = browser(0);
    await first.disconnected;
    expect(alive(first.launch?.pid ?? 0)).toBe(false);
    expect(await exists(profileOf(0))).toBe(false);

    endpoint.handle('Runtime.evaluate', () => ({ result: { type: 'number', value: 1 } }));
    endpoint.handle('Target.disposeBrowserContext', () => ({}));
    await expect(render((page) => page.evaluate('1'))).resolves.toBe(1);
    expect(endpoint.browsers).toHaveLength(2);
  });
});

describe('crashes', () => {
  it('fails render_crashed (retryable) when the browser dies mid-render, then relaunches', async () => {
    endpoint.handle('Page.captureScreenshot', (_c, b) => {
      b.kill();
      return never();
    });
    const err = await rejection(render((page) => page.capture()));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('render_crashed');
    expect(err.data?.retryable).toBe(true);
    expect(err.message).toBe('The browser exited during the render.');
    await vi.waitFor(async () => expect(await exists(profileOf(0))).toBe(false));

    endpoint.handle('Page.captureScreenshot', screenshot);
    const frame = await render((page) => page.capture());
    expect(frame.buffer).toEqual(panel(16));
    expect(endpoint.browsers).toHaveLength(2);
  });

  it('fails render_crashed when the page crashes, keeping the browser', async () => {
    endpoint.handle('Runtime.evaluate', (c, b) => {
      b.emit('Inspector.targetCrashed', {}, c.sessionId);
      return never();
    });
    const err = await rejection(render((page) => page.evaluate('crash()')));
    expect(err.data?.reason).toBe('render_crashed');
    expect(err.data?.retryable).toBe(true);
    expect(err.message).toBe('The page crashed during the render.');
    expect(browser().isConnected).toBe(true);
  });

  it('fails render_crashed when the page session detaches', async () => {
    endpoint.handle('Runtime.evaluate', (c, b) => {
      b.emit('Target.detachedFromTarget', { sessionId: c.sessionId, targetId: targetOf(c) });
      return never();
    });
    const err = await rejection(render((page) => page.evaluate('close()')));
    expect(err.data?.reason).toBe('render_crashed');
    expect(err.message).toBe('The page closed during the render.');
  });
});

describe('lifecycle', () => {
  it('launches once for consecutive renders', async () => {
    await render(async () => {});
    await render(async () => {});
    expect(endpoint.browsers).toHaveLength(1);
    expect(browser().isConnected).toBe(true);
  });

  it('closes the browser after the idle period and deletes its profile; the next render relaunches', async () => {
    makeRenderer({ idleMs: 100 });
    await render(async () => {});
    const first = browser(0);
    const profile = profileOf(0);
    expect(await exists(profile)).toBe(true);
    await first.disconnected;
    expect(commandsOf('Browser.close')).toHaveLength(1);
    await vi.waitFor(async () => expect(await exists(profile)).toBe(false));
    expect(alive(first.launch?.pid ?? 0)).toBe(false);

    await render(async () => {});
    expect(endpoint.browsers).toHaveLength(2);
  });

  it('keeps the browser while renders keep arriving within the idle period', async () => {
    // Each sleep is a third of the idle period, so a loaded machine delaying a render
    // by up to a second still lands it inside the window.
    makeRenderer({ idleMs: 1_500 });
    await render(async () => {});
    await new Promise((r) => setTimeout(r, 500));
    await render(async () => {});
    await new Promise((r) => setTimeout(r, 500));
    expect(browser().isConnected).toBe(true);
    expect(endpoint.browsers).toHaveLength(1);
  });

  it('close() stops the browser and deletes its profile', async () => {
    await render(async () => {});
    const { pid } = browser().launch ?? { pid: 0 };
    const profile = profileOf();
    await renderer.close();
    expect(commandsOf('Browser.close')).toHaveLength(1);
    expect(browser().isConnected).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(await exists(profile)).toBe(false);
  });

  it('close() kills a browser that does not exit on Browser.close', async () => {
    makeRenderer({ graceMs: 200 });
    endpoint.handle('Browser.close', never);
    await render(async () => {});
    const { pid } = browser().launch ?? { pid: 0 };
    await renderer.close();
    expect(alive(pid)).toBe(false);
    expect(await exists(profileOf())).toBe(false);
  });

  it('close() with no browser running does nothing', async () => {
    await expect(renderer.close()).resolves.toBeUndefined();
    expect(endpoint.browsers).toHaveLength(0);
  });
});
