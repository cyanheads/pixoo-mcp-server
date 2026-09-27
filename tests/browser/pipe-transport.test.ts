/**
 * @fileoverview Gated real-browser suite (`bun run test:browser`): the CDP pipe drives the
 * browser from a Bun parent and from a Node ≥ 24 parent, the browser's process tree holds
 * no internet socket (so no DevTools port or other listener), and a parent killed with
 * SIGKILL leaves no browser process behind. The parent is `helpers/pipe-child.mjs`,
 * launching the browser with the renderer's own flags.
 * @module tests/browser/pipe-transport.test
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRenderer, LAUNCH_FLAGS } from '@/services/browser/browser-renderer.js';
import { BrowserWrapper, isRunning, type Survivor } from './helpers/browser-under-test.js';

const CHILD = fileURLToPath(new URL('./helpers/pipe-child.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The line `pipe-child.mjs` prints once its page answered. */
interface Ready {
  browserPid: number;
  product: string;
  runtime: 'bun' | 'node';
  value: unknown;
  version: string;
}

interface Child {
  next(): Promise<unknown>;
  process: ChildProcessWithoutNullStreams;
  stderr(): string;
}

let wrapper: BrowserWrapper;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  wrapper = await BrowserWrapper.create();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  expect(await waitForNoSurvivors()).toEqual([]);
});

afterAll(async () => {
  expect(await wrapper?.cleanup()).toEqual([]);
});

/** Start `pipe-child.mjs` under `runtime` on a fresh profile inside the wrapper's directory. */
async function startChild(runtime: 'bun' | 'node'): Promise<Child> {
  const profile = await mkdtemp(path.join(wrapper.dir, 'profile-'));
  const args = [...LAUNCH_FLAGS, `--user-data-dir=${profile}`];
  const child = spawn(runtime, [CHILD, wrapper.executablePath, JSON.stringify(args)], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    process: child,
    stderr: () => stderr,
    async next() {
      const { value, done } = await lines.next();
      if (done) throw new Error(`pipe-child under ${runtime} printed nothing more: ${stderr}`);
      return JSON.parse(value);
    },
  };
}

/** Poll until no process of any launch is left, up to 10 s; returns what is left. */
async function waitForNoSurvivors(): Promise<Survivor[]> {
  const until = Date.now() + 10_000;
  for (;;) {
    const left = await wrapper.survivors();
    if (left.length === 0 || Date.now() > until) return left;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The internet sockets `pids` hold, as `lsof` lists them (one line each). */
async function internetSockets(pids: number[]): Promise<string[]> {
  const { stdout } = await promisify(execFile)('lsof', [
    '-nP',
    '-a',
    '-p',
    pids.join(','),
    '-i',
  ]).catch((err: { code?: number; stdout?: string }) => {
    // lsof exits 1 when it finds nothing to list.
    if (err.code === 1 && !err.stdout) return { stdout: '' };
    throw err;
  });
  return stdout.split('\n').slice(1).filter(Boolean);
}

describe.each(['bun', 'node'] as const)('CDP pipe with a %s parent', (runtime) => {
  it('drives a real browser, then closes it', async () => {
    const child = await startChild(runtime);
    const ready = (await child.next()) as Ready;

    expect(ready.runtime).toBe(runtime);
    if (runtime === 'node') {
      expect(Number(ready.version.split('.')[0])).toBeGreaterThanOrEqual(24);
    }
    expect(ready.product).toMatch(/^HeadlessChrome\//);
    expect(ready.value).toBe(42);
    expect((await wrapper.launches()).at(-1)?.pid).toBe(ready.browserPid);

    child.process.stdin.write('close\n');
    expect(await child.next()).toEqual({ exited: { code: 0, signal: null } });
    expect(isRunning(ready.browserPid)).toBe(false);
  });

  it('leaves no browser process when the parent is killed with SIGKILL', async () => {
    const child = await startChild(runtime);
    const ready = (await child.next()) as Ready;
    const helpers = await wrapper.survivors();
    expect(helpers.map((s) => s.pid)).toContain(ready.browserPid);
    expect(helpers.length).toBeGreaterThan(1);

    const exit = once(child.process, 'exit');
    child.process.kill('SIGKILL');
    expect(await exit).toEqual([null, 'SIGKILL']);

    expect(await waitForNoSurvivors()).toEqual([]);
    expect(isRunning(ready.browserPid)).toBe(false);
  });
});

describe('the browser under the renderer', () => {
  it('lists a loopback listener this process holds (control for the socket check)', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      expect(await internetSockets([process.pid])).toEqual(
        expect.arrayContaining([expect.stringContaining(`127.0.0.1:${port} (LISTEN)`)]),
      );
    } finally {
      server.close();
    }
  });

  it('holds no internet socket, listening or otherwise, while it renders', async () => {
    const renderer = new BrowserRenderer({ browserPath: wrapper.executablePath, size: 16 });
    try {
      const seen = await renderer.withPage(
        '<!doctype html><body style="margin:0;background:#0f0">',
        { sampling: 'native', inject: [] },
        async (page) => {
          const pixel = (await page.capture()).getPixel(8, 8);
          const tree = await wrapper.survivors();
          return {
            pixel,
            renderers: tree.filter((s) => s.command.includes('--type=renderer')).length,
            sockets: await internetSockets(tree.map((s) => s.pid)),
          };
        },
        new AbortController().signal,
      );
      expect(seen.pixel).toEqual([0, 255, 0]);
      expect(seen.renderers).toBeGreaterThan(0);
      expect(seen.sockets).toEqual([]);
    } finally {
      await renderer.close();
    }
  });
});
