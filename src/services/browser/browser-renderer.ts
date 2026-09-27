/**
 * @fileoverview `BrowserRenderer`: renders untrusted HTML in a headless Chromium driven
 * over the DevTools Protocol pipe, and captures it as a panel-size `Canvas`.
 *
 * Discovery: `PIXOO_BROWSER_PATH`, when set, is the only candidate: a path that is not an
 * executable file fails `browser_unavailable` rather than falling back. Unset, the newest
 * chrome-headless-shell for this host in Puppeteer's cache (`~/.cache/puppeteer`) is
 * used. System Chrome, Chromium, Edge, and Brave installs are not searched;
 * docs/design.md records why.
 *
 * Lifecycle: one browser, launched on first use with a fresh temp profile, reused by
 * later renders, closed after {@link IDLE_CLOSE_MS} without one and on `close()`; its
 * profile is deleted once it exits, however it exits. A browser that crashed is
 * relaunched by the next render. Each profile is named after the server's pid
 * (`pixoo-browser-<pid>-XXXXXX`), and a launch first deletes the profiles of servers that
 * are no longer running, which a `SIGKILL` leaves behind.
 *
 * Isolation: every render gets its own browser context whose proxy is a dead loopback
 * address, loopback included (`<-loopback>`). `Fetch` is enabled on the browser session,
 * so it sees every request of every target, popups and service workers included: the
 * render's document, served once at a random path on `https://pixoo.invalid/` with the
 * {@link DOCUMENT_CSP} header, is the one request fulfilled; a navigation of the render's
 * own page fails as `Aborted`, so its document stays, and every other request fails as
 * `BlockedByClient`. WebRTC UDP is closed by both the launch flag and the profile's
 * `webrtc.ip_handling_policy` preference.
 * @module services/browser/browser-renderer
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configurationError,
  type McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { Canvas, downsample } from '@cyanheads/pixoo-toolkit';
import sharp from 'sharp';
import { getServerConfig } from '@/config/server-config.js';
import { CdpError, type PipedProcess, spawnPiped } from './cdp-pipe.js';

/** Recovery for `browser_unavailable`, for the `errors[]` entry of the tools that render HTML. */
export const BROWSER_UNAVAILABLE_RECOVERY =
  'Install a browser with `npx @puppeteer/browsers install chrome-headless-shell@stable --path <dir>`, then set PIXOO_BROWSER_PATH to the executable path the install prints.';

/**
 * The render document's `Content-Security-Policy` header. Nothing may load from a network
 * scheme; inline script and style run, `data:` and `blob:` serve scripts, styles, images,
 * fonts, and media, and no worker starts. Scripts added through
 * `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate` are not subject to it.
 */
export const DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src 'none'";

/** How long a render may take, from launch through the last `use` call. */
export const RENDER_DEADLINE_MS = 30_000;
/** How long the browser stays open with no render running. */
export const IDLE_CLOSE_MS = 5 * 60_000;
/** How long disposing a context or closing the browser may take before the browser is killed. */
const CLOSE_GRACE_MS = 5_000;
/** Device scale factor for `sampling: 'supersample'`. */
const SUPERSAMPLE_SCALE = 8;

/** Where render documents are served. `.invalid` is reserved and never resolves (RFC 2606). */
const DOCUMENT_ORIGIN = 'https://pixoo.invalid';
/**
 * The proxy every request is sent through: the discard port on loopback, which refuses
 * the connection without the request leaving the host.
 */
const DEAD_PROXY = 'http://127.0.0.1:9';
/** Loopback bypasses a proxy by default; this removes the exemption. */
const PROXY_BYPASS_LIST = '<-loopback>';
const WEBRTC_IP_HANDLING_POLICY = 'disable_non_proxied_udp';

/** Caps on `pageErrors`, so a page that logs in a loop cannot grow it without bound. */
const MAX_PAGE_ERRORS = 100;
const MAX_PAGE_ERROR_CHARS = 1_000;

/** Launch flags, besides the profile directory. */
export const LAUNCH_FLAGS: readonly string[] = [
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
  `--proxy-server=${DEAD_PROXY}`,
  `--proxy-bypass-list=${PROXY_BYPASS_LIST}`,
  `--force-webrtc-ip-handling-policy=${WEBRTC_IP_HANDLING_POLICY}`,
];

/** The profile's `Default/Preferences`. */
const PROFILE_PREFERENCES = { webrtc: { ip_handling_policy: WEBRTC_IP_HANDLING_POLICY } };

const browserUnavailable = (message: string) =>
  configurationError(message, { reason: 'browser_unavailable' });

const renderTimeout = (message: string) => timeout(message, { reason: 'render_timeout' });

const renderCrashed = (message: string) =>
  serviceUnavailable(message, { reason: 'render_crashed', retryable: true });

/** The page a render's `use` callback drives. */
export interface RenderPage {
  /** One panel-size frame of the viewport as it is now. */
  capture(): Promise<Canvas>;
  /** Evaluate `expression` in the page, awaiting a promise; rejects with the page's exception. */
  evaluate(expression: string): Promise<unknown>;
  /** Uncaught errors, console errors, and blocked URLs, as they arrive. */
  readonly pageErrors: string[];
}

export interface RenderOptions {
  /** Scripts that run, in order, before the page's own in every document it loads. */
  inject: string[];
  /** `native` captures at device scale factor 1; `supersample` at 8, area-averaged down. */
  sampling: 'native' | 'supersample';
}

export interface BrowserRendererOptions {
  /** Default: `PIXOO_BROWSER_PATH`, else discovery. */
  browserPath?: string;
  /** Default: {@link RENDER_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Default: {@link CLOSE_GRACE_MS}. */
  graceMs?: number;
  /** Default: {@link IDLE_CLOSE_MS}. */
  idleMs?: number;
  /** Viewport side in CSS px. Default: `PIXOO_SIZE`. */
  size?: number;
}

/** Renders HTML in a shared headless browser, one isolated browser context per render. */
export class BrowserRenderer {
  readonly #options: BrowserRendererOptions;
  readonly #deadlineMs: number;
  readonly #graceMs: number;
  readonly #idleMs: number;
  #launching: Promise<LiveBrowser> | undefined;
  #active = 0;
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(options: BrowserRendererOptions = {}) {
    this.#options = options;
    this.#deadlineMs = options.deadlineMs ?? RENDER_DEADLINE_MS;
    this.#graceMs = options.graceMs ?? CLOSE_GRACE_MS;
    this.#idleMs = options.idleMs ?? IDLE_CLOSE_MS;
  }

  /**
   * Load `html` in a fresh browser context and pass the page to `use`; the context is
   * disposed when `use` settles. The deadline covers the launch, the load, and `use`.
   * @throws {McpError} ConfigurationError `browser_unavailable` when no browser can be
   *   found or it fails to start.
   * @throws {McpError} Timeout `render_timeout` past the deadline or when `signal`
   *   aborts; the context is disposed, and a browser that cannot dispose it is killed.
   * @throws {McpError} ServiceUnavailable `render_crashed` (retryable) when the browser
   *   or the page crashes; the next render relaunches the browser.
   */
  async withPage<T>(
    html: string,
    opts: RenderOptions,
    use: (page: RenderPage) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const size = this.#options.size ?? getServerConfig().pixooSize;
    this.#active++;
    clearTimeout(this.#idleTimer);
    const scale = opts.sampling === 'supersample' ? SUPERSAMPLE_SCALE : 1;
    const render = new Render();
    const deadline = setTimeout(
      () => render.fail(renderTimeout(`The render did not finish within ${this.#deadlineMs} ms.`)),
      this.#deadlineMs,
    );
    const onAbort = () =>
      render.fail(renderTimeout('The render was cancelled before it finished.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    let browser: LiveBrowser | undefined;
    let contextId: string | undefined;
    let creating: Promise<string> | undefined;
    try {
      browser = await untilAborted(this.#browser(), render.signal);
      browser.renders.add(render);
      const { cdp } = browser.process;
      const send = <R>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
        cdp.send<R>(method, params, { sessionId, signal: render.signal });

      // Sent without the render's signal, so a context created after an abort is still disposed.
      creating = cdp
        .send<{ browserContextId: string }>('Target.createBrowserContext', {
          disposeOnDetach: true,
          proxyServer: DEAD_PROXY,
          proxyBypassList: PROXY_BYPASS_LIST,
        })
        .then((created) => created.browserContextId);
      contextId = await untilAborted(creating, render.signal);
      const { targetId } = await send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        browserContextId: contextId,
      });
      render.targetId = targetId;
      const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      render.sessionId = sessionId;
      const onPage = <R>(method: string, params?: Record<string, unknown>) =>
        send<R>(method, params, sessionId);

      await Promise.all(
        ['Page.enable', 'Runtime.enable', 'Log.enable', 'Inspector.enable'].map((m) => onPage(m)),
      );
      await onPage('Page.setLifecycleEventsEnabled', { enabled: true });
      await onPage('Emulation.setDeviceMetricsOverride', {
        width: size,
        height: size,
        deviceScaleFactor: scale,
        mobile: false,
      });
      for (const source of opts.inject) {
        await onPage('Page.addScriptToEvaluateOnNewDocument', { source });
      }

      const url = `${DOCUMENT_ORIGIN}/${randomUUID()}`;
      render.documentUrl = url;
      browser.documents.set(url, { frameId: targetId, html });
      const navigation = await onPage<{ loaderId: string; errorText?: string }>('Page.navigate', {
        url,
      });
      if (navigation.errorText) {
        throw new Error(`The render's document failed to load: ${navigation.errorText}`);
      }
      await untilAborted(render.loaded(navigation.loaderId), render.signal);

      const page: RenderPage = {
        pageErrors: render.pageErrors,
        async evaluate(expression) {
          const { result, exceptionDetails } = await onPage<EvaluateResult>('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (exceptionDetails) throw new Error(describeException(exceptionDetails));
          return result.value;
        },
        async capture() {
          const { data } = await onPage<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
          });
          return decodeCapture(Buffer.from(data, 'base64'), size, scale);
        },
      };
      return await untilAborted(use(page), render.signal);
    } catch (err) {
      throw classifyFailure(err, browser, render);
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
      render.fail(new Error('The render has finished; its page is closed.'));
      if (browser) {
        const live = browser;
        live.renders.delete(render);
        if (render.documentUrl) live.documents.delete(render.documentUrl);
        if (contextId !== undefined) {
          if (!live.process.cdp.isClosed) await this.#dispose(live, contextId);
        } else {
          void creating?.then((id) => this.#dispose(live, id)).catch(() => {});
        }
      }
      if (--this.#active === 0 && this.#launching) {
        this.#idleTimer = setTimeout(() => void this.close().catch(() => {}), this.#idleMs);
        this.#idleTimer.unref();
      }
    }
  }

  /**
   * Close the browser, if one is running, and delete its profile. A render in progress
   * fails `render_crashed`. The next render launches a new browser.
   */
  async close(): Promise<void> {
    clearTimeout(this.#idleTimer);
    const launching = this.#launching;
    this.#launching = undefined;
    const browser = await launching?.catch(() => undefined);
    if (!browser) return;
    const grace = AbortSignal.timeout(this.#graceMs);
    await browser.process.cdp.send('Browser.close', {}, { signal: grace }).catch(() => {});
    await untilAborted(browser.process.exited, grace).catch(() => browser.process.kill());
    await browser.removed;
  }

  /** The running browser, launching one if there is none. */
  #browser(): Promise<LiveBrowser> {
    if (!this.#launching) {
      const launching: Promise<LiveBrowser> = this.#launch().then(
        (browser) => {
          void browser.process.cdp.closed.then(() => this.#forget(launching));
          return browser;
        },
        (err: unknown) => {
          this.#forget(launching);
          throw err;
        },
      );
      this.#launching = launching;
    }
    return this.#launching;
  }

  #forget(launching: Promise<LiveBrowser>): void {
    if (this.#launching === launching) this.#launching = undefined;
  }

  async #launch(): Promise<LiveBrowser> {
    const executable = await discoverBrowser({
      browserPath: this.#options.browserPath ?? getServerConfig().pixooBrowserPath,
    });
    const tmp = os.tmpdir();
    await removeStaleProfiles(tmp);
    const profileDir = await mkdtemp(path.join(tmp, `pixoo-browser-${process.pid}-`));
    await mkdir(path.join(profileDir, 'Default'));
    await writeFile(
      path.join(profileDir, 'Default', 'Preferences'),
      JSON.stringify(PROFILE_PREFERENCES),
    );
    const spawned = await spawnPiped(executable, [
      ...LAUNCH_FLAGS,
      `--user-data-dir=${profileDir}`,
    ]).catch(async (err: unknown) => {
      await rm(profileDir, { recursive: true, force: true });
      throw browserUnavailable(`Could not launch ${executable}: ${errorMessage(err)}`);
    });
    const browser = new LiveBrowser(spawned, profileDir);
    try {
      await spawned.cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*' }] },
        { signal: AbortSignal.timeout(this.#deadlineMs) },
      );
    } catch (err) {
      spawned.kill();
      await browser.removed.catch(() => {});
      const stderr = spawned.stderrTail().trim().split('\n').at(-1);
      throw browserUnavailable(
        `The browser at ${executable} failed to start: ${errorMessage(err)}${stderr ? ` (${stderr})` : ''}`,
      );
    }
    return browser;
  }

  /** Dispose a render's context; a browser that cannot within the grace period is killed. */
  async #dispose(browser: LiveBrowser, browserContextId: string): Promise<void> {
    const grace = AbortSignal.timeout(this.#graceMs);
    await browser.process.cdp
      .send('Target.disposeBrowserContext', { browserContextId }, { signal: grace })
      .catch(async () => {
        if (!grace.aborted) return;
        browser.process.kill();
        await browser.removed.catch(() => {});
      });
  }
}

/** A launch's profile in the temp dir, named after the server that owns it. */
const PROFILE_NAME = /^pixoo-browser-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Delete the profiles in `dir` whose server is no longer running. A server killed by
 * `SIGKILL` never deletes its browser's profile, so the next launch on the host does. A
 * live server's profile, this one's included, is left alone, as is a name that carries no
 * owner pid.
 */
async function removeStaleProfiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch((): string[] => []);
  await Promise.all(
    names.map(async (name) => {
      const owner = Number(PROFILE_NAME.exec(name)?.[1]);
      if (!owner || owner === process.pid || isRunning(owner)) return;
      await rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch(
        () => {},
      );
    }),
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One launched browser and the renders in progress on it. */
class LiveBrowser {
  readonly renders = new Set<Render>();
  /** Documents waiting to be served, by URL, with the frame allowed to load each. */
  readonly documents = new Map<string, { frameId: string; html: string }>();
  /** Settles once the process has exited and its profile is deleted. */
  readonly removed: Promise<void>;

  constructor(
    readonly process: PipedProcess,
    profileDir: string,
  ) {
    this.removed = process.exited.then(() =>
      rm(profileDir, { recursive: true, force: true, maxRetries: 3 }),
    );
    // `close()` awaits `removed`; a profile left behind elsewhere must not end the server.
    this.removed.catch(() => {});
    this.#listen();
  }

  #render(sessionId: string | undefined): Render | undefined {
    if (sessionId === undefined) return undefined;
    for (const render of this.renders) if (render.sessionId === sessionId) return render;
    return undefined;
  }

  #listen(): void {
    const { cdp } = this.process;
    cdp.on<RequestPaused>('Fetch.requestPaused', (event, sessionId) => {
      if (sessionId === undefined) this.#gate(event);
    });
    cdp.on<{ exceptionDetails: ExceptionDetails }>(
      'Runtime.exceptionThrown',
      ({ exceptionDetails }, sessionId) =>
        this.#render(sessionId)?.pageError(describeException(exceptionDetails)),
    );
    cdp.on<{ type: string; args: RemoteObject[] }>(
      'Runtime.consoleAPICalled',
      ({ type, args }, sessionId) => {
        if (type !== 'error' && type !== 'assert') return;
        this.#render(sessionId)?.pageError(`console.${type}: ${args.map(describeValue).join(' ')}`);
      },
    );
    cdp.on<{ entry: LogEntry }>('Log.entryAdded', ({ entry }, sessionId) => {
      const render = this.#render(sessionId);
      if (!render || entry.level !== 'error') return;
      if (entry.url && render.blocked.has(entry.url)) return;
      const text = entry.text.trimEnd();
      // A CSP report's `url` is the document's own, which names nothing the page tried.
      const named = !entry.url || entry.url === render.documentUrl || text.includes(entry.url);
      render.pageError(named ? text : `${text} ${entry.url}`);
    });
    cdp.on<{ frameId: string; loaderId: string; name: string }>(
      'Page.lifecycleEvent',
      ({ frameId, loaderId, name }, sessionId) => {
        const render = this.#render(sessionId);
        if (render && name === 'load' && frameId === render.targetId) render.sawLoad(loaderId);
      },
    );
    cdp.on<{ frame: { id: string; loaderId: string } }>(
      'Page.frameNavigated',
      ({ frame }, sessionId) => {
        const render = this.#render(sessionId);
        if (render && frame.id === render.targetId) render.sawCommit(frame.loaderId);
      },
    );
    cdp.on<{ frameId: string }>('Page.frameStoppedLoading', ({ frameId }, sessionId) => {
      const render = this.#render(sessionId);
      if (render && frameId === render.targetId) render.sawStop();
    });
    cdp.on('Inspector.targetCrashed', (_params, sessionId) =>
      this.#render(sessionId)?.fail(renderCrashed('The page crashed during the render.')),
    );
    cdp.on<{ sessionId: string }>('Target.detachedFromTarget', ({ sessionId }) =>
      this.#render(sessionId)?.fail(renderCrashed('The page closed during the render.')),
    );
    void cdp.closed.then(() => {
      for (const render of this.renders) {
        render.fail(renderCrashed('The browser exited during the render.'));
      }
    });
  }

  /** Serve a render's document to its own frame, once; fail everything else. */
  #gate({ requestId, request, frameId, resourceType }: RequestPaused): void {
    const { cdp } = this.process;
    // The command fails only when the request is already gone with its context or browser.
    const settled = () => {};
    const document = this.documents.get(request.url);
    if (document?.frameId === frameId && resourceType === 'Document') {
      this.documents.delete(request.url);
      cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Content-Security-Policy', value: DOCUMENT_CSP },
          ],
          body: Buffer.from(document.html, 'utf8').toString('base64'),
        })
        .catch(settled);
      return;
    }
    // A navigation of a render's own page is aborted rather than blocked: Chrome commits its
    // error page over the document for a blocked navigation, and one started during load
    // then never reports the document's load.
    let navigation = false;
    for (const render of this.renders) {
      if (render.targetId !== frameId) continue;
      navigation = resourceType === 'Document';
      if (!navigation) render.blocked.add(request.url);
      render.pageError(`${navigation ? 'Blocked navigation' : 'Blocked request'}: ${request.url}`);
    }
    cdp
      .send('Fetch.failRequest', {
        requestId,
        errorReason: navigation ? 'Aborted' : 'BlockedByClient',
      })
      .catch(settled);
  }
}

/** One render's state: its target, the errors its page reports, and why it stopped. */
class Render {
  readonly pageErrors: string[] = [];
  /** URLs the Fetch gate blocked for this page's main frame. */
  readonly blocked = new Set<string>();
  targetId: string | undefined;
  sessionId: string | undefined;
  documentUrl: string | undefined;
  readonly #stop = new AbortController();
  readonly #loads = new Set<string>();
  #waiting: { loaderId: string; resolve(): void } | undefined;
  /** The main frame's most recently committed loader. */
  #committed: string | undefined;

  /** Aborts, with the error the render fails with, once it times out, is cancelled, or crashes. */
  get signal(): AbortSignal {
    return this.#stop.signal;
  }

  /** Stop the render with `error`; the first call wins. */
  fail(error: Error): void {
    this.#stop.abort(error);
  }

  pageError(text: string): void {
    if (this.pageErrors.length > MAX_PAGE_ERRORS) return;
    this.pageErrors.push(
      this.pageErrors.length === MAX_PAGE_ERRORS
        ? 'Further page errors omitted.'
        : text.slice(0, MAX_PAGE_ERROR_CHARS),
    );
  }

  sawLoad(loaderId: string): void {
    this.#loads.add(loaderId);
    if (this.#waiting?.loaderId === loaderId) this.#waiting.resolve();
  }

  sawCommit(loaderId: string): void {
    this.#committed = loaderId;
  }

  /** The main frame stopped loading: its committed document is as loaded as it will get. */
  sawStop(): void {
    if (this.#committed !== undefined) this.sawLoad(this.#committed);
  }

  /**
   * Resolves once the main frame's `load` fired for the navigation `loaderId`, or the frame
   * stopped loading after that navigation committed: when the page starts a navigation
   * during load and the gate aborts it, Chrome reports no `load` for the document.
   */
  loaded(loaderId: string): Promise<void> {
    if (this.#loads.has(loaderId)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiting = { loaderId, resolve };
    });
  }
}

interface RequestPaused {
  frameId: string;
  request: { url: string };
  requestId: string;
  resourceType: string;
}

interface RemoteObject {
  description?: string;
  type: string;
  unserializableValue?: string;
  value?: unknown;
}

interface ExceptionDetails {
  exception?: RemoteObject;
  text: string;
}

interface EvaluateResult {
  exceptionDetails?: ExceptionDetails;
  result: RemoteObject;
}

interface LogEntry {
  level: string;
  text: string;
  url?: string;
}

/** `Uncaught Error: message` — the first line of the exception, without its stack. */
function describeException({ text, exception }: ExceptionDetails): string {
  const what = exception?.description?.split('\n', 1)[0] ?? (exception && describeValue(exception));
  return what ? `${text} ${what}` : text;
}

function describeValue(value: RemoteObject): string {
  if ('value' in value)
    return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
  return value.unserializableValue ?? value.description ?? value.type;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why the render failed, as the error it rejects with. A closed pipe or a detached session
 * is a crash; otherwise the render's own stop reason wins, and anything else — the
 * `use` callback's own error included — passes through.
 */
function classifyFailure(err: unknown, browser: LiveBrowser | undefined, render: Render): unknown {
  if (browser?.process.cdp.isClosed || (err instanceof CdpError && err.kind !== 'protocol')) {
    return renderCrashed(
      browser?.process.cdp.isClosed
        ? 'The browser exited during the render.'
        : 'The page closed during the render.',
    );
  }
  return render.signal.aborted ? (render.signal.reason as McpError) : err;
}

/** A screenshot, decoded and area-averaged down to `size` when captured at `scale`. */
async function decodeCapture(png: Buffer, size: number, scale: number): Promise<Canvas> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const side = size * scale;
  if (info.width !== side || info.height !== side) {
    throw new Error(
      `The capture came back ${info.width}×${info.height} px; expected ${side}×${side}.`,
    );
  }
  const frame = Canvas.fromRgba(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    side,
    side,
  );
  return scale === 1 ? frame : downsample(frame, size, size);
}

/** `promise`, or `signal`'s reason once it aborts, whichever settles first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let _renderer: BrowserRenderer | undefined;

/** Create the shared renderer. Call once from `setup()`. */
export function initBrowserRenderer(): void {
  _renderer = new BrowserRenderer();
}

/** The shared renderer; `initBrowserRenderer()` must have run. */
export function getBrowserRenderer(): BrowserRenderer {
  if (!_renderer) {
    throw new Error('BrowserRenderer not initialized — call initBrowserRenderer() in setup()');
  }
  return _renderer;
}

export interface BrowserDiscoveryOptions {
  /** Default: this process's. */
  arch?: string;
  /** `PIXOO_BROWSER_PATH`; when set, the only candidate. */
  browserPath?: string | undefined;
  /** Puppeteer's browser cache. Default: `~/.cache/puppeteer`. */
  cacheDir?: string;
  /** Default: this process's. */
  platform?: NodeJS.Platform;
}

/**
 * The executable to launch. Fails `browser_unavailable` (ConfigurationError) when
 * `browserPath` is set but not an executable file, or when it is unset and the cache
 * holds no chrome-headless-shell for this host.
 */
export async function discoverBrowser(options: BrowserDiscoveryOptions = {}): Promise<string> {
  const { browserPath } = options;
  if (browserPath !== undefined) {
    const problem = await launchProblem(browserPath);
    if (problem)
      throw browserUnavailable(`PIXOO_BROWSER_PATH is set to ${browserPath}, which ${problem}`);
    return browserPath;
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const folder = puppeteerPlatform(platform, arch);
  if (!folder) {
    throw browserUnavailable(
      `No browser found: PIXOO_BROWSER_PATH is unset, and chrome-headless-shell has no build for ${platform}/${arch}.`,
    );
  }
  const root = path.join(
    options.cacheDir ?? path.join(os.homedir(), '.cache', 'puppeteer'),
    'chrome-headless-shell',
  );
  const found = await newestHeadlessShell(root, folder);
  if (found) return found;
  throw browserUnavailable(
    `No browser found: PIXOO_BROWSER_PATH is unset, and ${root} holds no chrome-headless-shell build for ${folder}.`,
  );
}

/**
 * The platform name `@puppeteer/browsers` gives this host, which prefixes each build's
 * folder in its cache (`mac_arm-154.0.8037.57`). Windows on ARM maps to `win64`, as it
 * does on Windows 11, whose x64 emulation runs that build.
 */
function puppeteerPlatform(platform: NodeJS.Platform, arch: string): string | undefined {
  switch (platform) {
    case 'darwin':
      return arch === 'arm64' ? 'mac_arm' : 'mac';
    case 'linux':
      return arch === 'arm64' ? 'linux_arm' : 'linux';
    case 'win32':
      return arch === 'x64' || arch === 'arm64' ? 'win64' : 'win32';
    default:
      return undefined;
  }
}

/**
 * The executable of the newest `<folder>-<buildId>` build under `root`. A build's
 * executable sits in its one `chrome-headless-shell-*` subfolder, whose suffix varies by
 * platform and build; a build without one (an interrupted install) is skipped.
 */
async function newestHeadlessShell(root: string, folder: string): Promise<string | undefined> {
  const prefix = `${folder}-`;
  const exe = folder.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const builds = (await readdir(root).catch(() => []))
    .filter((name) => name.startsWith(prefix) && /^\d+(\.\d+)*$/.test(name.slice(prefix.length)))
    .sort((a, b) => compareBuildIds(b.slice(prefix.length), a.slice(prefix.length)));
  for (const build of builds) {
    const dir = path.join(root, build);
    for (const sub of await readdir(dir).catch(() => [])) {
      if (!sub.startsWith('chrome-headless-shell-')) continue;
      const file = path.join(dir, sub, exe);
      if (!(await launchProblem(file))) return file;
    }
  }
  return undefined;
}

/** Compare dotted numeric build ids segment by segment. */
function compareBuildIds(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Why `file` cannot be launched, as the end of a sentence; undefined when it can. */
async function launchProblem(file: string): Promise<string | undefined> {
  const info = await stat(file).catch((err: NodeJS.ErrnoException) => err);
  if (info instanceof Error) {
    return info.code === 'ENOENT' || info.code === 'ENOTDIR'
      ? 'does not exist.'
      : `cannot be read (${info.code}).`;
  }
  if (!info.isFile()) return 'is not a file. Set it to the browser executable itself.';
  const runnable = await access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
  return runnable ? undefined : 'is not executable.';
}
