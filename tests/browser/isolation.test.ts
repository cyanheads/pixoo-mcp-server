/**
 * @fileoverview Gated real-browser isolation suite for `BrowserRenderer` (run with
 * `bun run test:browser`). Pages try every way out — subresources, `@import`, fonts,
 * media, fetch, XHR, beacon, EventSource, WebSocket, an iframe, `window.open`, workers, a
 * service worker, WebRTC STUN and TURN, `dns-prefetch` and `preconnect`, top-level
 * navigation, and `file://` — aimed at 127.0.0.1-only canaries and at hostnames carrying a
 * per-run token. Nothing may reach a canary, the browser's net log may name none of those
 * hostnames, and `pageErrors` names each blocked subresource URL, with two recorded
 * exceptions: a blocked iframe is reported by its origin only, and a cross-origin worker
 * makes no request but throws a `SecurityError` whose message holds its URL. A top-level
 * navigation is aborted and named as `Blocked navigation: <url>`. `window.open` returns a
 * real popup whose navigation the gate fails; `pageErrors` does not name it.
 * @module tests/browser/isolation.test
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserRenderer,
  type RenderOptions,
  type RenderPage,
} from '@/services/browser/browser-renderer.js';
import { spawnPiped } from '@/services/browser/cdp-pipe.js';
import { BrowserWrapper, type Survivor } from './helpers/browser-under-test.js';
import { type Canaries, startCanaries } from './helpers/canaries.js';
import { hostnamesWith, readNetLogs } from './helpers/net-log.js';

const NATIVE: RenderOptions = { sampling: 'native', inject: [] };
const DOCUMENT_ORIGIN = 'https://pixoo.invalid/';
const TOKEN = `probe${randomBytes(6).toString('hex')}`;
const host = (name: string) => `${name}-${TOKEN}.invalid`;

let wrapper: BrowserWrapper;
let canaries: Canaries;
let survivors: Survivor[] | undefined;

/** What each render reported, collected once in `beforeAll`. */
const seen = {
  main: { errors: [] as string[], state: {} as Record<string, unknown> },
  navigation: { errors: [] as string[], href: '' },
  file: { errors: [] as string[], href: '', read: '' },
  netLog: '',
  launches: 0,
};
let origin = '';
let blobWorkerUrl = '';

/** Subresource URLs each page tries; every one must be named in `pageErrors`. */
const subresources = () => {
  const at = (p: string) => `${origin}${p}`;
  return {
    stylesheet: at('/stylesheet'),
    '@import': at('/import'),
    font: at('/font'),
    'CSS image': at('/background'),
    image: at('/image'),
    'image (hostname)': `https://${host('image')}/`,
    audio: at('/audio'),
    video: at('/video'),
    script: at('/script'),
    fetch: at('/fetch'),
    'fetch (hostname)': `https://${host('fetch')}/`,
    XHR: at('/xhr'),
    beacon: at('/beacon'),
    EventSource: at('/event-source'),
    WebSocket: `wss://127.0.0.1:${canaries.tcpPort}/websocket`,
    'WebSocket (hostname)': `wss://${host('websocket')}/`,
    'same-origin worker': `${DOCUMENT_ORIGIN}worker.js`,
    'service worker': `${DOCUMENT_ORIGIN}service-worker.js`,
  };
};

function mainPage(): string {
  const u = subresources();
  const tcp = `127.0.0.1:${canaries.tcpPort}`;
  const udp = `127.0.0.1:${canaries.udpPort}`;
  return `<!doctype html><html><head>
<link rel="dns-prefetch" href="//${host('dns-prefetch')}">
<link rel="preconnect" href="https://${host('preconnect')}">
<link rel="preconnect" href="${origin}">
<link rel="stylesheet" href="${u.stylesheet}">
<style>
@import url("${u['@import']}");
@font-face { font-family: probe; src: url("${u.font}"); }
body { margin: 0; font-family: probe; background: #f00 url("${u['CSS image']}"); }
</style>
</head><body>text
<img src="${u.image}"><img src="${u['image (hostname)']}">
<audio src="${u.audio}" autoplay></audio><video src="${u.video}" autoplay></video>
<script src="${u.script}"></script>
<iframe src="${origin}/iframe"></iframe>
<script>
const state = (window.state = {});
fetch('${u.fetch}').then(() => (state.fetch = 'loaded'), () => (state.fetch = 'refused'));
fetch('${u['fetch (hostname)']}').catch(() => {});
try { const x = new XMLHttpRequest(); x.open('GET', '${u.XHR}'); x.send(); } catch {}
try { state.beacon = navigator.sendBeacon('${u.beacon}', 'x'); } catch {}
try { new EventSource('${u.EventSource}'); } catch {}
try { new WebSocket('${u.WebSocket}'); } catch {}
try { new WebSocket('${u['WebSocket (hostname)']}'); } catch {}
try { new Worker('/worker.js'); } catch {}
window.blobWorkerUrl = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
try { new Worker(window.blobWorkerUrl); } catch {}
try { navigator.serviceWorker.register('/service-worker.js').then(() => (state.serviceWorker = 'registered'), () => (state.serviceWorker = 'refused')); } catch (e) { state.serviceWorker = String(e); }
state.popup = String(window.open('${origin}/popup'));
state.popupHostname = String(window.open('https://${host('popup')}/'));
const pc = new RTCPeerConnection({ iceServers: [
  { urls: 'stun:${udp}' },
  { urls: 'turn:${udp}?transport=udp', username: 'u', credential: 'c' },
  { urls: 'turn:${tcp}?transport=tcp', username: 'u', credential: 'c' },
  { urls: 'stun:${host('stun')}:3478' },
  { urls: 'turn:${host('turn')}:3478?transport=udp', username: 'u', credential: 'c' },
] });
pc.createDataChannel('probe');
pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => (state.rtc = 'offered'));
window.pc = pc;
</script>
<script>new Worker('${origin}/worker');</script>
</body></html>`;
}

const pause = (page: RenderPage, ms: number) =>
  page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);

/** Poll until `pageErrors` holds an entry containing `text`. */
async function waitForError(page: RenderPage, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!page.pageErrors.some((e) => e.includes(text))) {
    if (Date.now() > deadline) throw new Error(`pageErrors never named ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
  canaries = await startCanaries();
  origin = `https://127.0.0.1:${canaries.tcpPort}`;
  const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
  const signal = new AbortController().signal;
  try {
    await renderer.withPage(
      mainPage(),
      NATIVE,
      async (page) => {
        await pause(page, 3_000);
        seen.main.state = (await page.evaluate(
          '({ ...state, ice: pc.iceGatheringState, candidates: (pc.localDescription?.sdp.match(/a=candidate.*/g) ?? []).length })',
        )) as Record<string, unknown>;
        blobWorkerUrl = (await page.evaluate('window.blobWorkerUrl')) as string;
        seen.main.errors = [...page.pageErrors];
      },
      signal,
    );
    await renderer.withPage(
      `<!doctype html><script>location.href = '${origin}/navigation';</script>`,
      NATIVE,
      async (page) => {
        await waitForError(page, `Blocked navigation: ${origin}/navigation`);
        await page.evaluate(`location.href = 'https://${host('navigation')}/'`);
        await waitForError(page, `Blocked navigation: https://${host('navigation')}/`);
        await pause(page, 500);
        seen.navigation.href = (await page.evaluate('location.href')) as string;
        seen.navigation.errors = [...page.pageErrors];
      },
      signal,
    );
    await renderer.withPage(
      `<!doctype html><img src="file:///etc/hosts"><script>
window.fileRead = fetch('file:///etc/hosts').then((r) => r.text()).then(() => 'read', () => 'refused');
</script>`,
      NATIVE,
      async (page) => {
        seen.file.read = (await page.evaluate('window.fileRead')) as string;
        await page.evaluate(`location.href = 'file:///etc/hosts'`);
        await waitForError(page, 'Not allowed to load local resource: file:///etc/hosts');
        await pause(page, 500);
        seen.file.href = (await page.evaluate('location.href')) as string;
        seen.file.errors = [...page.pageErrors];
      },
      signal,
    );
  } finally {
    // The net log is complete once its browser has exited.
    await renderer.close();
  }
  const launches = await wrapper.launches();
  seen.launches = launches.length;
  seen.netLog = await readNetLogs(launches.map((l) => l.netLog));
});

afterAll(async () => {
  await canaries?.close();
  survivors = await wrapper?.cleanup();
  expect(survivors).toEqual([]);
});

describe('BrowserRenderer isolation on a real browser', () => {
  it('ran every page in one browser, and the page ran its probes', () => {
    expect(seen.launches).toBe(1);
    expect(seen.main.state).toMatchObject({
      fetch: 'refused',
      serviceWorker: 'refused',
      rtc: 'offered',
      // ICE gathering ran to completion and found no candidate: no UDP left the page.
      ice: 'complete',
      candidates: 0,
    });
  });

  it('lets nothing reach the 127.0.0.1 canaries', () => {
    expect(canaries.hits).toEqual([]);
  });

  it('leaves no hostname the pages tried in the net log', () => {
    expect(seen.netLog.length).toBeGreaterThan(0);
    expect(hostnamesWith(seen.netLog, TOKEN)).toEqual([]);
  });

  it('names each blocked subresource URL in pageErrors', () => {
    const missing = Object.entries(subresources()).filter(
      ([, url]) => !seen.main.errors.some((e) => e.includes(url)),
    );
    expect(missing, JSON.stringify(seen.main.errors, null, 1)).toEqual([]);
  });

  it('names the blocked blob: worker URL in pageErrors', () => {
    expect(blobWorkerUrl).toMatch(/^blob:https:\/\/pixoo\.invalid\//);
    expect(seen.main.errors.some((e) => e.includes(blobWorkerUrl))).toBe(true);
  });

  it('reports a blocked iframe by its origin only', () => {
    expect(seen.main.errors.some((e) => e.startsWith(`Framing '${origin}/' violates`))).toBe(true);
    expect(seen.main.errors.some((e) => e.includes(`${origin}/iframe`))).toBe(false);
  });

  it("names a cross-origin worker's URL in the SecurityError it throws", () => {
    expect(seen.main.errors).toContain(
      `Uncaught SecurityError: Failed to construct 'Worker': Script at '${origin}/worker' cannot be accessed from origin 'https://pixoo.invalid'.`,
    );
  });

  it('opens popups whose navigations the gate fails without a pageErrors entry', () => {
    expect(seen.main.state).toMatchObject({
      popup: '[object Window]',
      popupHostname: '[object Window]',
    });
    expect(
      seen.main.errors.filter((e) => e.includes('/popup') || e.includes(host('popup'))),
    ).toEqual([]);
  });

  it('aborts top-level navigations and keeps the document', () => {
    expect(seen.navigation.href.startsWith(DOCUMENT_ORIGIN)).toBe(true);
    expect(seen.navigation.errors).toEqual(
      expect.arrayContaining([
        `Blocked navigation: ${origin}/navigation`,
        `Blocked navigation: https://${host('navigation')}/`,
      ]),
    );
  });

  it('refuses file:// to fetch, subresources, and navigation', () => {
    expect(seen.file.read).toBe('refused');
    expect(seen.file.href.startsWith(DOCUMENT_ORIGIN)).toBe(true);
    expect(seen.file.errors).toEqual(
      expect.arrayContaining([
        'Not allowed to load local resource: file:///etc/hosts',
        "Fetch API cannot load file:///etc/hosts. Refused to connect because it violates the document's Content Security Policy.",
      ]),
    );
  });

  it('finds a hostname in the net log when a browser does try one (control)', async () => {
    const hostname = host('control');
    const profile = await mkdtemp(path.join(wrapper.dir, 'control-'));
    const browser = await spawnPiped(wrapper.executablePath, [
      '--headless',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      `--user-data-dir=${profile}`,
      // The request goes to a dead loopback proxy, so it never leaves the host.
      '--proxy-server=http://127.0.0.1:9',
    ]);
    try {
      const { cdp } = browser;
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      const navigation = await cdp.send<{ errorText?: string }>(
        'Page.navigate',
        { url: `http://${hostname}/` },
        { sessionId },
      );
      expect(navigation.errorText).toBeTruthy();
      await cdp.send('Browser.close').catch(() => {});
      await browser.exited;
    } finally {
      browser.kill();
    }
    const launch = (await wrapper.launches()).find((l) => l.pid === browser.pid);
    expect(launch).toBeDefined();
    expect(hostnamesWith(await readNetLogs([launch?.netLog ?? '']), TOKEN)).toEqual([hostname]);
  });
});
