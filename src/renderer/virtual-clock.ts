/**
 * @fileoverview The page-side clock that makes an HTML render deterministic.
 * {@link VIRTUAL_CLOCK_SOURCE} runs before the page's own scripts and replaces
 * `setTimeout`/`setInterval`, `requestAnimationFrame`, `Date`, and `performance.now` with a
 * virtual clock that moves only when the host steps a frame; {@link frameStepExpression}
 * is that step. The source is a string literal rather than a serialized function, so
 * coverage instrumentation never leaks into the page.
 * @module renderer/virtual-clock
 */

/**
 * Page runtime, injected ahead of the page's scripts in the top-level document (child
 * frames keep the real clock). Pass it as `withPage(html, { inject: [VIRTUAL_CLOCK_SOURCE],
 * sampling }, use, signal)`.
 *
 * - `performance.now()` reads 0 at load; `Date` starts at the wall-clock time the
 *   document was created and then advances only on the virtual clock.
 * - Timers fire in order of due time, then creation order. A timer created inside a timer
 *   callback, and every interval repeat, waits at least 4 ms, so a zero-delay loop cannot
 *   hang the step.
 * - A timer or `requestAnimationFrame` callback that throws goes to `reportError`, so it
 *   lands in the renderer's `pageErrors` without failing the step.
 * - It defines a non-writable `__pixooFrame(frame, frames, speed)`: see
 *   {@link frameStepExpression}.
 */
export const VIRTUAL_CLOCK_SOURCE = `(() => {
  'use strict';
  const g = globalThis;
  if (g.top !== g) return;

  const RealDate = g.Date;
  const realSetTimeout = g.setTimeout.bind(g);
  const report = g.reportError.bind(g);
  const wallStart = RealDate.now();
  const NESTED_MIN_MS = 4;
  const MAX_DELAY_MS = 2147483647;
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';

  let now = 0;
  let order = 0;
  let nesting = 0;
  let nextTimerId = 1;
  const timers = new Map();
  let nextFrameId = 1;
  let frameCallbacks = new Map();
  let round = new Map();
  const origins = new WeakMap();
  let blackRoot = null;

  const invoke = (fn, args) => {
    try {
      fn.apply(g, args);
    } catch (err) {
      report(err);
    }
  };

  const toDelay = (value) => {
    const ms = Number(value);
    return ms > 0 && ms <= MAX_DELAY_MS ? ms : 0;
  };

  const schedule = (handler, delay, args, repeats) => {
    const fn = typeof handler === 'function' ? handler : new g.Function(String(handler));
    const ms = toDelay(delay);
    const id = nextTimerId++;
    timers.set(id, {
      id,
      fn,
      args,
      due: now + (nesting > 0 ? Math.max(ms, NESTED_MIN_MS) : ms),
      order: order++,
      every: repeats ? Math.max(ms, NESTED_MIN_MS) : 0,
    });
    return id;
  };

  const clearTimer = (id) => {
    timers.delete(Number(id));
  };

  const runTimers = (until) => {
    for (;;) {
      let next;
      for (const timer of timers.values()) {
        if (timer.due > until) continue;
        if (!next || timer.due < next.due || (timer.due === next.due && timer.order < next.order)) {
          next = timer;
        }
      }
      if (!next) break;
      now = next.due;
      if (next.every) {
        next.due = now + next.every;
        next.order = order++;
      } else {
        timers.delete(next.id);
      }
      nesting++;
      invoke(next.fn, next.args);
      nesting--;
    }
    now = until;
  };

  const runFrameCallbacks = () => {
    round = frameCallbacks;
    frameCallbacks = new Map();
    for (const [id, callback] of round) {
      round.delete(id);
      invoke(callback, [now]);
    }
  };

  const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  const describe = (err) => {
    try {
      return String(err);
    } catch {
      return 'a value String() cannot convert';
    }
  };

  const unpainted = (el) => {
    if (!el) return true;
    const style = g.getComputedStyle(el);
    return style.backgroundColor === TRANSPARENT && style.backgroundImage === 'none';
  };

  const step = async (frame, frames, speed) => {
    const doc = g.document;
    if (blackRoot) {
      blackRoot.style.removeProperty('background-color');
      blackRoot = null;
    }
    runTimers(Math.max(now, frame * speed));
    await settle();
    runFrameCallbacks();
    await settle();
    if (typeof g.render === 'function') {
      try {
        await g.render(frame / frames, frame);
      } catch (err) {
        return 'window.render threw at frame ' + frame + ': ' + describe(err);
      }
    }
    for (const animation of doc.getAnimations()) {
      if (animation.timeline !== doc.timeline) continue;
      if (!origins.has(animation)) origins.set(animation, now);
      animation.pause();
      animation.currentTime = now - origins.get(animation);
    }
    const root = doc.documentElement;
    if (root && unpainted(root) && unpainted(doc.body)) {
      root.style.setProperty('background-color', '#000');
      blackRoot = root;
    }
    return undefined;
  };

  const virtualNow = () => Math.floor(wallStart + now);
  function VirtualDate(...args) {
    if (!new.target) return new RealDate(virtualNow()).toString();
    return Reflect.construct(RealDate, args.length > 0 ? args : [virtualNow()], new.target);
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = virtualNow;
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: VirtualDate });

  Object.assign(g, {
    Date: VirtualDate,
    setTimeout: (handler, delay, ...args) => schedule(handler, delay, args, false),
    setInterval: (handler, delay, ...args) => schedule(handler, delay, args, true),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    requestAnimationFrame: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('requestAnimationFrame: the callback is not a function.');
      }
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      frameCallbacks.delete(Number(id));
      round.delete(Number(id));
    },
  });
  Object.defineProperty(g.performance, 'now', {
    value: () => now,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(g, '__pixooFrame', { value: step });
})();
`;

/**
 * The expression `RenderPage.evaluate` runs to step to frame `frame` of `frames`, `speed`
 * ms apart. The step advances the clock to `frame × speed` ms, firing the timers due by
 * then; runs one `requestAnimationFrame` round; awaits `window.render(frame / frames,
 * frame)` when the page defines it; pauses each animation on `document.timeline` and seeks
 * it to the virtual time since the step first saw it; and paints the root black when
 * neither the root nor the body paints a background (removed again before the next step).
 *
 * It resolves to `undefined`, or, when `render` throws or rejects, to
 * `window.render threw at frame <frame>: <String(error)>`, meant for a `page_error`.
 */
export function frameStepExpression(frame: number, frames: number, speed: number): string {
  return `globalThis.__pixooFrame(${frame}, ${frames}, ${speed})`;
}

/**
 * The document `withPage` serves: `<!doctype html>` and a style ahead of the caller's
 * `html` that hides every scrollbar, so no layout width goes to one, and zeroes the body
 * margin, since the panel is the whole page and the default 8 px would take a quarter of
 * a 64-px panel. Both rules come first, at no more than a type selector's specificity,
 * so a page rule selecting `body` or an inline style overrides them.
 */
export function pageDocument(html: string): string {
  return `<!doctype html><style>*{scrollbar-width:none}body{margin:0}</style>${html}`;
}
