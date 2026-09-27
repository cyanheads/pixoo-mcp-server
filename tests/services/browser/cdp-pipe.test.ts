/**
 * @fileoverview Tests for the CDP pipe client: NUL-delimited framing, command/response
 * matching, sessions, events, detach, abort, and close — over in-memory streams — then
 * `spawnPiped` against a spawned fake browser that speaks CDP on its fds 3 and 4. No
 * browser is launched; the fake's only listener binds 127.0.0.1.
 * @module tests/services/browser/cdp-pipe.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CdpError, type PipedProcess, spawnPiped } from '@/services/browser/cdp-pipe.js';
import { FakeCdpEndpoint, fakePipePair } from './fake-cdp-endpoint.js';

/** A handler that never answers. */
const hang = () => new Promise(() => {});

/** Settles `promise` into an inspectable state without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

describe('CdpPipe', () => {
  it('sends a NUL-terminated command on the browser session and resolves its result', async () => {
    const { cdp, browser } = fakePipePair();
    const version = await cdp.send<{ product: string }>('Browser.getVersion');
    expect(version.product).toBe('HeadlessChrome/0.0.0.0');
    expect(browser.commands).toEqual([{ id: 1, method: 'Browser.getVersion', params: {} }]);
  });

  it('numbers commands in order and matches responses that arrive out of order', async () => {
    let releaseFirst!: () => void;
    const { cdp, browser } = fakePipePair({
      'Page.navigate': () =>
        new Promise((resolve) => (releaseFirst = () => resolve({ frameId: 'F' }))),
      'Page.enable': () => ({}),
    });
    const first = cdp.send('Page.navigate', { url: 'https://pixoo.invalid/' });
    await expect(cdp.send('Page.enable')).resolves.toEqual({});
    releaseFirst();
    await expect(first).resolves.toEqual({ frameId: 'F' });
    expect(browser.commands.map((c) => [c.id, c.method])).toEqual([
      [1, 'Page.navigate'],
      [2, 'Page.enable'],
    ]);
  });

  it('carries sessionId on a session command', async () => {
    const { cdp, browser } = fakePipePair({ 'Runtime.evaluate': () => ({ result: { value: 2 } }) });
    const reply = await cdp.send('Runtime.evaluate', { expression: '1 + 1' }, { sessionId: 'S1' });
    expect(reply).toEqual({ result: { value: 2 } });
    expect(browser.commands[0]).toEqual({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
      sessionId: 'S1',
    });
  });

  it('reads frames split across chunks, several per chunk, and UTF-8 split mid-character', async () => {
    const { cdp, browser } = fakePipePair({ 'A.one': hang, 'A.two': hang });
    const events: unknown[] = [];
    cdp.on('Log.entryAdded', (params, sessionId) => events.push([params, sessionId]));
    const one = cdp.send('A.one');
    const two = cdp.send('A.two');
    await browser.waitForCommand('A.two');

    const stream = Buffer.from(
      `${JSON.stringify({ id: 1, result: { text: 'é🙂' } })}\0` +
        `${JSON.stringify({ method: 'Log.entryAdded', params: { n: 1 }, sessionId: 'S' })}\0` +
        `${JSON.stringify({ id: 2, result: { text: '日本' } })}\0`,
    );
    const emoji = stream.indexOf(Buffer.from('🙂'));
    const cuts = [emoji + 2, stream.indexOf(0) + 5, stream.length - 3];
    let from = 0;
    for (const cut of [...cuts, stream.length]) {
      browser.sendRaw(stream.subarray(from, cut));
      from = cut;
      await tick();
    }

    await expect(one).resolves.toEqual({ text: 'é🙂' });
    await expect(two).resolves.toEqual({ text: '日本' });
    expect(events).toEqual([[{ n: 1 }, 'S']]);
  });

  it('rejects a CDP error response as CdpError kind protocol, keeping the code', async () => {
    const { cdp } = fakePipePair({
      'Page.navigate': () => {
        throw Object.assign(new Error('Cannot navigate to invalid URL'), { code: -32000 });
      },
    });
    const missing = await cdp.send('Nope.method').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(CdpError);
    expect(missing).toMatchObject({ kind: 'protocol', method: 'Nope.method', code: -32601 });
    expect((missing as CdpError).message).toBe("Nope.method: 'Nope.method' wasn't found");

    await expect(cdp.send('Page.navigate', { url: 'x' })).rejects.toMatchObject({
      kind: 'protocol',
      code: -32000,
      message: 'Page.navigate: Cannot navigate to invalid URL',
    });
  });

  it('delivers events to their listeners with the sessionId until unsubscribed', async () => {
    const { cdp, browser } = fakePipePair();
    const loads: unknown[] = [];
    const others: unknown[] = [];
    const off = cdp.on('Page.loadEventFired', (params, sessionId) =>
      loads.push([params, sessionId]),
    );
    cdp.on('Page.frameNavigated', (params) => others.push(params));

    browser.emit('Page.loadEventFired', { timestamp: 1 }, 'S1');
    browser.emit('Page.loadEventFired', { timestamp: 2 });
    await cdp.send('Browser.getVersion');
    off();
    browser.emit('Page.loadEventFired', { timestamp: 3 }, 'S1');
    await cdp.send('Browser.getVersion');

    expect(loads).toEqual([
      [{ timestamp: 1 }, 'S1'],
      [{ timestamp: 2 }, undefined],
    ]);
    expect(others).toEqual([]);
  });

  it("rejects a detached session's pending commands as kind detached, and only those", async () => {
    const { cdp, browser } = fakePipePair({ 'Runtime.evaluate': hang });
    const detaches: unknown[] = [];
    cdp.on('Target.detachedFromTarget', (params) => detaches.push(params));
    const onS1 = cdp.send('Runtime.evaluate', {}, { sessionId: 'S1' });
    const onS2 = track(cdp.send('Runtime.evaluate', {}, { sessionId: 'S2' }));
    const onBrowser = track(cdp.send('Runtime.evaluate'));
    await browser.waitForCommand('Runtime.evaluate', (c) => c.id === 3);

    browser.emit('Target.detachedFromTarget', { sessionId: 'S1', targetId: 'T1' });
    await expect(onS1).rejects.toMatchObject({ kind: 'detached', method: 'Runtime.evaluate' });
    await tick();
    expect(onS2.settled).toBe(false);
    expect(onBrowser.settled).toBe(false);
    expect(detaches).toEqual([{ sessionId: 'S1', targetId: 'T1' }]);
  });

  it('rejects with the signal reason on abort and drops the late response', async () => {
    let answer!: () => void;
    const { cdp, browser } = fakePipePair({
      'Runtime.evaluate': () => new Promise((resolve) => (answer = () => resolve({ late: true }))),
    });
    const controller = new AbortController();
    const pending = cdp.send('Runtime.evaluate', {}, { signal: controller.signal });
    await browser.waitForCommand('Runtime.evaluate');
    const reason = new Error('deadline');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    answer();
    await expect(cdp.send('Browser.getVersion')).resolves.toMatchObject({ protocolVersion: '1.3' });
    expect(cdp.isClosed).toBe(false);
  });

  it('rejects at once, without writing, when the signal is already aborted', async () => {
    const { cdp, browser } = fakePipePair();
    const reason = new Error('already');
    await expect(
      cdp.send('Browser.getVersion', {}, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await cdp.send('Browser.getVersion');
    expect(browser.commands.map((c) => c.method)).toEqual(['Browser.getVersion']);
  });

  it('rejects pending commands as kind closed when the browser closes the pipe', async () => {
    const { cdp, browser } = fakePipePair({ 'Page.navigate': hang });
    const pending = cdp.send('Page.navigate', { url: 'about:blank' });
    await browser.waitForCommand('Page.navigate');
    browser.disconnect();

    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      method: 'Page.navigate',
      message: 'Page.navigate: the browser closed the DevTools pipe',
    });
    await cdp.closed;
    expect(cdp.isClosed).toBe(true);
    await expect(cdp.send('Browser.getVersion')).rejects.toMatchObject({ kind: 'closed' });
  });

  it('close() rejects pending commands with its reason and refuses new ones', async () => {
    const { cdp, browser } = fakePipePair({ 'Page.navigate': hang });
    const pending = cdp.send('Page.navigate');
    await browser.waitForCommand('Page.navigate');
    cdp.close('the render was cancelled');
    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      message: 'Page.navigate: the render was cancelled',
    });
    await cdp.closed;
    await expect(cdp.send('Browser.getVersion')).rejects.toMatchObject({ kind: 'closed' });
  });

  it('closes the pipe on a frame that is not JSON', async () => {
    const { cdp, browser } = fakePipePair({ 'Page.navigate': hang });
    const pending = cdp.send('Page.navigate');
    await browser.waitForCommand('Page.navigate');
    browser.sendRaw('not json\0');
    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      message: 'Page.navigate: the browser sent a message that is not JSON: not json',
    });
    expect(cdp.isClosed).toBe(true);
  });
});

describe('spawnPiped', () => {
  let endpoint: FakeCdpEndpoint;
  let profile: string;
  const spawned: PipedProcess[] = [];

  beforeEach(async () => {
    endpoint = await FakeCdpEndpoint.start();
    profile = await mkdtemp(path.join(os.tmpdir(), 'pixoo-cdp-profile-'));
  });

  afterEach(async () => {
    for (const proc of spawned.splice(0)) {
      proc.kill();
      await proc.exited;
    }
    await endpoint.close();
    await rm(profile, { recursive: true, force: true });
  });

  async function spawnFake(args: string[] = []) {
    const arrived = endpoint.nextBrowser();
    const proc = await spawnPiped(endpoint.executablePath, args);
    spawned.push(proc);
    return { proc, browser: await arrived };
  }

  it('launches the executable with its arguments and speaks CDP over fds 3 and 4', async () => {
    await mkdir(path.join(profile, 'Default'));
    await writeFile(path.join(profile, 'Default', 'Preferences'), '{"webrtc":{}}');
    const args = ['--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'];
    const { proc, browser } = await spawnFake(args);

    expect(browser.launch).toEqual({ pid: proc.pid, argv: args, preferences: '{"webrtc":{}}' });
    await expect(proc.cdp.send('Browser.getVersion')).resolves.toMatchObject({
      product: 'HeadlessChrome/0.0.0.0',
    });
    expect(browser.commands).toEqual([{ id: 1, method: 'Browser.getVersion', params: {} }]);
  });

  it('closing the pipe makes the browser exit, as Chromium does', async () => {
    const { proc, browser } = await spawnFake();
    proc.cdp.close();
    await expect(proc.exited).resolves.toEqual({ code: 0, signal: null });
    await browser.disconnected;
  });

  it('a killed browser fails its pending commands as kind closed and reports the signal', async () => {
    endpoint.handle('Page.navigate', hang);
    const { proc, browser } = await spawnFake();
    const pending = proc.cdp.send('Page.navigate');
    await browser.waitForCommand('Page.navigate');
    browser.kill();

    await expect(pending).rejects.toMatchObject({ kind: 'closed', method: 'Page.navigate' });
    await expect(proc.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(proc.cdp.isClosed).toBe(true);
    await expect(proc.cdp.send('Browser.getVersion')).rejects.toMatchObject({ kind: 'closed' });
  });

  it('a process that exits without speaking CDP keeps the tail of its stderr', async () => {
    const proc = await spawnPiped('/bin/sh', [
      '-c',
      'i=0; while [ $i -lt 400 ]; do echo "noise line $i ....................." >&2; i=$((i+1)); done; echo "last words" >&2; exit 3',
    ]);
    spawned.push(proc);
    await expect(proc.exited).resolves.toEqual({ code: 3, signal: null });
    await proc.cdp.closed;
    const tail = proc.stderrTail();
    expect(tail.endsWith('last words\n')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(8192);
    expect(tail).not.toContain('noise line 0 ');
    await expect(proc.cdp.send('Browser.getVersion')).rejects.toMatchObject({ kind: 'closed' });
  });

  it('rejects when the executable cannot be spawned', async () => {
    const missing = path.join(profile, 'no-such-browser');
    await expect(spawnPiped(missing, [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
