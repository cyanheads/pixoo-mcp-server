/**
 * @fileoverview Tests for the page-side virtual clock. The injected source runs in a
 * `node:vm` context with a stubbed `document`, `getComputedStyle`, and `reportError`, so
 * timers, `requestAnimationFrame`, `Date`, `performance.now`, `window.render`, the
 * animation seek, and the black-background default are exercised without a browser.
 * @module tests/renderer/virtual-clock.test
 */

import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  frameStepExpression,
  pageDocument,
  VIRTUAL_CLOCK_SOURCE,
} from '@/renderer/virtual-clock.js';

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

interface FakeElement {
  computed: { backgroundColor: string; backgroundImage: string };
  inline: Map<string, string>;
  style: {
    getPropertyValue(name: string): string;
    removeProperty(name: string): void;
    setProperty(name: string, value: string): void;
  };
}

interface FakeAnimation {
  currentTime: number | null;
  pause(): void;
  paused: boolean;
  timeline: object;
}

function element(backgroundColor = TRANSPARENT, backgroundImage = 'none'): FakeElement {
  const inline = new Map<string, string>();
  return {
    computed: { backgroundColor, backgroundImage },
    inline,
    style: {
      getPropertyValue: (name) => inline.get(name) ?? '',
      removeProperty: (name) => void inline.delete(name),
      setProperty: (name, value) => void inline.set(name, value),
    },
  };
}

function animation(timeline: object): FakeAnimation {
  return {
    currentTime: null,
    paused: false,
    pause() {
      this.paused = true;
    },
    timeline,
  };
}

interface PageOptions {
  body?: FakeElement | null;
  /** Evaluated in the page before the clock is injected (e.g. to make it a child frame). */
  prelude?: string;
  root?: FakeElement;
}

/** A page context with the clock injected, then `script` run as the page's own code. */
function loadPage(script = '', options: PageOptions = {}) {
  const reported: unknown[] = [];
  const timeline = {};
  const animations: FakeAnimation[] = [];
  const root = options.root ?? element();
  const body = options.body === undefined ? element() : options.body;
  const context = vm.createContext({
    document: { body, documentElement: root, getAnimations: () => [...animations], timeline },
    getComputedStyle: (el: FakeElement) => el.computed,
    performance: {},
    reportError: (err: unknown) => reported.push(err),
    setTimeout,
  });
  vm.runInContext(
    `globalThis.top = globalThis; globalThis.window = globalThis; globalThis.log = []; ${options.prelude ?? ''}`,
    context,
  );
  vm.runInContext(VIRTUAL_CLOCK_SOURCE, context);
  vm.runInContext(script, context);
  return {
    animations,
    body,
    context,
    reported,
    root,
    timeline,
    /** Page-realm values, JSON round-tripped into this realm. */
    read: (expression: string): unknown =>
      JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context) as string),
    run: (code: string): unknown => vm.runInContext(code, context),
    step: (frame: number, frames: number, speed: number) =>
      vm.runInContext(frameStepExpression(frame, frames, speed), context) as Promise<
        string | undefined
      >,
  };
}

type Page = ReturnType<typeof loadPage>;

/** Steps frames `0 … frames − 1` in order, returning each step's result. */
async function stepAll(page: Page, frames: number, speed: number) {
  const results: (string | undefined)[] = [];
  for (let frame = 0; frame < frames; frame++) results.push(await page.step(frame, frames, speed));
  return results;
}

describe('frame step', () => {
  it('calls render with t = i / frames once performance.now() reaches i × speed', async () => {
    const page = loadPage('window.render = (t, frame) => log.push([t, frame, performance.now()]);');
    expect(await stepAll(page, 8, 150)).toEqual(Array(8).fill(undefined));
    expect(page.read('log')).toEqual(Array.from({ length: 8 }, (_, i) => [i / 8, i, i * 150]));
  });

  it('reads performance.now() as 0 before the first frame', () => {
    const page = loadPage('log.push(performance.now());');
    expect(page.read('log')).toEqual([0]);
  });

  it('awaits an async render before the step resolves', async () => {
    const page = loadPage(
      'window.render = async (t, frame) => { await Promise.resolve(); log.push(frame); };',
    );
    await page.step(0, 2, 100);
    expect(page.read('log')).toEqual([0]);
  });

  it('skips render when window.render is not a function', async () => {
    const page = loadPage('window.render = 42;');
    expect(await page.step(0, 1, 100)).toBeUndefined();
  });

  it('never moves the clock backward when a frame is stepped out of order', async () => {
    const page = loadPage('window.render = () => log.push(performance.now());');
    await page.step(2, 4, 100);
    await page.step(1, 4, 100);
    expect(page.read('log')).toEqual([200, 200]);
  });

  it('returns the frame number and message when render throws, and succeeds before it', async () => {
    const page = loadPage(
      "window.render = (t, frame) => { if (frame === 3) throw new Error('boom'); };",
    );
    expect(await stepAll(page, 4, 150)).toEqual([
      undefined,
      undefined,
      undefined,
      'window.render threw at frame 3: Error: boom',
    ]);
  });

  it('reports a rejected async render and a thrown non-Error value', async () => {
    const rejected = loadPage("window.render = async () => { throw new TypeError('bad t'); };");
    expect(await rejected.step(5, 8, 100)).toBe('window.render threw at frame 5: TypeError: bad t');

    const thrown = loadPage("window.render = () => { throw 'plain string'; };");
    expect(await thrown.step(0, 1, 100)).toBe('window.render threw at frame 0: plain string');

    const unprintable = loadPage('window.render = () => { throw Object.create(null); };');
    expect(await unprintable.step(1, 2, 100)).toBe(
      'window.render threw at frame 1: a value String() cannot convert',
    );
  });

  it('builds the step expression and the served document', () => {
    expect(frameStepExpression(3, 20, 150)).toBe('globalThis.__pixooFrame(3, 20, 150)');
    expect(pageDocument('<p>hi</p>')).toBe(
      '<!doctype html><style>*{scrollbar-width:none}body{margin:0}</style><p>hi</p>',
    );
  });

  it('defines __pixooFrame as non-writable', () => {
    const page = loadPage();
    expect(page.run("Object.getOwnPropertyDescriptor(globalThis, '__pixooFrame').writable")).toBe(
      false,
    );
    page.run('try { globalThis.__pixooFrame = 1; } catch {}');
    expect(page.run('typeof globalThis.__pixooFrame')).toBe('function');
  });

  it('installs nothing in a child frame', () => {
    const page = loadPage('', { prelude: 'globalThis.top = {};' });
    expect(page.run('typeof globalThis.__pixooFrame')).toBe('undefined');
    expect(page.run('globalThis.setTimeout')).toBe(setTimeout);
  });
});

describe('timers', () => {
  it('fires setInterval at each due time across frames, and stops on clearInterval', async () => {
    const page = loadPage(`
      const id = setInterval(() => {
        log.push(performance.now());
        if (performance.now() === 600) clearInterval(id);
      }, 100);
      window.render = (t, frame) => log.push('frame ' + frame);
    `);
    await stepAll(page, 6, 150);
    expect(page.read('log')).toEqual([
      'frame 0',
      100,
      'frame 1',
      200,
      300,
      'frame 2',
      400,
      'frame 3',
      500,
      600,
      'frame 4',
      'frame 5',
    ]);
  });

  it('fires setTimeout once at its due time with its arguments and window as this', async () => {
    const page = loadPage(`
      setTimeout(function (a, b) { log.push([performance.now(), a, b, this === window]); }, 250, 'x', 2);
      setTimeout(() => log.push(['zero', performance.now()]), 0);
    `);
    await stepAll(page, 4, 150);
    expect(page.read('log')).toEqual([
      ['zero', 0],
      [250, 'x', 2, true],
    ]);
  });

  it('orders timers by due time, then creation order', async () => {
    const page = loadPage(`
      setTimeout(() => log.push('c'), 50);
      setTimeout(() => log.push('a'), 20);
      setTimeout(() => log.push('b'), 20);
      setTimeout(() => log.push('d'), 50);
    `);
    await page.step(1, 2, 100);
    expect(page.read('log')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clears a timeout before it fires, and treats clearTimeout and clearInterval alike', async () => {
    const page = loadPage(`
      const a = setTimeout(() => log.push('a'), 10);
      const b = setInterval(() => log.push('b'), 10);
      clearInterval(a);
      clearTimeout(b);
      clearTimeout(undefined);
    `);
    await stepAll(page, 3, 100);
    expect(page.read('log')).toEqual([]);
  });

  it('compiles a string handler', async () => {
    const page = loadPage("setTimeout('log.push(performance.now())', 30);");
    await page.step(1, 2, 100);
    expect(page.read('log')).toEqual([30]);
  });

  it('treats a negative, NaN, or oversized delay as 0', async () => {
    const page = loadPage(`
      setTimeout(() => log.push('negative'), -5);
      setTimeout(() => log.push('nan'), 'soon');
      setTimeout(() => log.push('huge'), 2 ** 31);
    `);
    await page.step(0, 1, 100);
    expect(page.read('log')).toEqual(['negative', 'nan', 'huge']);
  });

  it('floors a zero-delay timer created inside a timer callback at 4 ms', async () => {
    const page = loadPage(`
      function tick() { log.push(performance.now()); setTimeout(tick, 0); }
      setTimeout(tick, 0);
    `);
    await stepAll(page, 2, 20);
    expect(page.read('log')).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('floors every interval repeat at 4 ms but not a top-level first delay', async () => {
    const page = loadPage(`
      setInterval(() => log.push(['interval', performance.now()]), 0);
      setTimeout(() => log.push(['timeout', performance.now()]), 1);
    `);
    await page.step(1, 2, 10);
    expect(page.read('log')).toEqual([
      ['interval', 0],
      ['timeout', 1],
      ['interval', 4],
      ['interval', 8],
    ]);
  });

  it('keeps a nested delay above the floor as given', async () => {
    const page = loadPage(`
      setTimeout(() => setTimeout(() => log.push(performance.now()), 7), 0);
    `);
    await page.step(1, 2, 10);
    expect(page.read('log')).toEqual([7]);
  });

  it('reports a throwing callback through reportError and keeps running the rest', async () => {
    const page = loadPage(`
      setTimeout(() => { throw new Error('timer broke'); }, 10);
      setTimeout(() => log.push('after'), 20);
      requestAnimationFrame(() => { throw new Error('frame broke'); });
      requestAnimationFrame(() => log.push('next frame callback'));
    `);
    expect(await page.step(1, 2, 100)).toBeUndefined();
    expect(page.read('log')).toEqual(['after', 'next frame callback']);
    expect(page.reported.map(String)).toEqual(['Error: timer broke', 'Error: frame broke']);
  });

  it('settles promise work from timers before render reads it', async () => {
    const page = loadPage(`
      let value = 0;
      setInterval(() => Promise.resolve().then(() => Promise.resolve()).then(() => { value++; }), 100);
      window.render = () => log.push(value);
    `);
    await stepAll(page, 3, 100);
    expect(page.read('log')).toEqual([0, 1, 2]);
  });
});

describe('requestAnimationFrame', () => {
  it('runs one round per frame with the frame time as the timestamp', async () => {
    const page = loadPage(`
      function loop(ts) { log.push(ts); requestAnimationFrame(loop); }
      requestAnimationFrame(loop);
    `);
    await stepAll(page, 4, 150);
    expect(page.read('log')).toEqual([0, 150, 300, 450]);
  });

  it('runs rAF after the frame timers and before render', async () => {
    const page = loadPage(`
      setTimeout(() => log.push('timer'), 0);
      requestAnimationFrame(() => log.push('raf'));
      window.render = () => log.push('render');
    `);
    await page.step(0, 1, 100);
    expect(page.read('log')).toEqual(['timer', 'raf', 'render']);
  });

  it('cancels a callback before its round and within its round', async () => {
    const page = loadPage(`
      const gone = requestAnimationFrame(() => log.push('cancelled early'));
      cancelAnimationFrame(gone);
      let second;
      requestAnimationFrame(() => { log.push('first'); cancelAnimationFrame(second); });
      second = requestAnimationFrame(() => log.push('cancelled in round'));
      requestAnimationFrame(() => log.push('third'));
    `);
    await page.step(0, 1, 100);
    expect(page.read('log')).toEqual(['first', 'third']);
  });

  it('rejects a non-function callback', () => {
    const page = loadPage();
    expect(page.run('try { requestAnimationFrame(1); } catch (e) { e.name }')).toBe('TypeError');
  });
});

describe('Date', () => {
  it('starts at the wall clock and advances only with the frames', async () => {
    const before = Date.now();
    const page = loadPage(`
      log.push(Date.now());
      window.render = () => log.push(Date.now(), new Date().getTime());
    `);
    const after = Date.now();
    await stepAll(page, 3, 150);
    const [start, ...frames] = page.read('log') as [number, ...number[]];
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(frames).toEqual([start, start, start + 150, start + 150, start + 300, start + 300]);
  });

  it('keeps Date constructible, callable, and instanceof-compatible', () => {
    const page = loadPage();
    expect(page.run('new Date(0).getTime()')).toBe(0);
    expect(page.run('new Date(2020, 0, 2).getDate()')).toBe(2);
    expect(page.run('new Date() instanceof Date')).toBe(true);
    expect(page.run('new Date().constructor === Date')).toBe(true);
    expect(page.run('typeof Date()')).toBe('string');
    expect(page.run('Date() === new Date(Date.now()).toString()')).toBe(true);
    expect(page.run("Date.parse('1970-01-01T00:00:01Z')")).toBe(1000);
    expect(page.run('Date.UTC(1970, 0, 1, 0, 0, 2)')).toBe(2000);
    expect(page.run('class Stamp extends Date {} new Stamp(5) instanceof Stamp')).toBe(true);
  });
});

describe('animation seek', () => {
  it('pauses each document-timeline animation at its virtual time since first seen', async () => {
    const page = loadPage();
    const atLoad = animation(page.timeline);
    const other = animation({});
    page.animations.push(atLoad, other);
    const seen: [number | null, number | null][] = [];
    for (let frame = 0; frame < 4; frame++) {
      if (frame === 2) page.animations.push(animation(page.timeline));
      await page.step(frame, 4, 150);
      seen.push([atLoad.currentTime, page.animations[2]?.currentTime ?? null]);
    }
    expect(seen).toEqual([
      [0, null],
      [150, null],
      [300, 0],
      [450, 150],
    ]);
    expect(atLoad.paused).toBe(true);
    expect(other).toMatchObject({ currentTime: null, paused: false });
  });
});

describe('background default', () => {
  it('paints the root black when neither root nor body paints a background', async () => {
    const page = loadPage(
      'window.render = () => log.push(document.documentElement.style.getPropertyValue("background-color"));',
    );
    await page.step(0, 2, 100);
    expect(page.root.inline.get('background-color')).toBe('#000');
    await page.step(1, 2, 100);
    // Render sees the page's own styles: the default is removed before each step.
    expect(page.read('log')).toEqual(['', '']);
    expect(page.root.inline.get('background-color')).toBe('#000');
  });

  it('leaves the root alone when the body or root paints', async () => {
    const bodyColor = loadPage('', { body: element('rgb(255, 0, 0)') });
    await bodyColor.step(0, 1, 100);
    expect(bodyColor.root.inline.size).toBe(0);

    const rootImage = loadPage('', { root: element(TRANSPARENT, 'linear-gradient(red, blue)') });
    await rootImage.step(0, 1, 100);
    expect(rootImage.root.inline.size).toBe(0);
  });

  it('removes its own black once the page paints a background', async () => {
    const body = element();
    const page = loadPage('', { body });
    await page.step(0, 2, 100);
    expect(page.root.inline.get('background-color')).toBe('#000');
    body.computed.backgroundColor = 'rgb(0, 0, 255)';
    await page.step(1, 2, 100);
    expect(page.root.inline.has('background-color')).toBe(false);
  });

  it('treats a missing body as unpainted', async () => {
    const page = loadPage('', { body: null });
    await page.step(0, 1, 100);
    expect(page.root.inline.get('background-color')).toBe('#000');
  });
});

describe('determinism', () => {
  it('produces identical sequences on two runs of the same page', async () => {
    const script = `
      let x = 0;
      setInterval(() => { x += 3; log.push(['interval', performance.now(), x]); }, 70);
      function spin(ts) { log.push(['raf', ts, x]); requestAnimationFrame(spin); }
      requestAnimationFrame(spin);
      setTimeout(function chain() { log.push(['chain', performance.now()]); setTimeout(chain, 0); }, 5);
      window.render = (t, frame) => log.push(['render', t, frame, performance.now(), Math.sin(t * 2 * Math.PI)]);
    `;
    const runOnce = async () => {
      const page = loadPage(script);
      page.animations.push(animation(page.timeline));
      const results = await stepAll(page, 6, 30);
      return { log: page.read('log'), results, seek: page.animations[0]?.currentTime };
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
    expect((first.log as unknown[]).length).toBeGreaterThan(40);
  });
});
