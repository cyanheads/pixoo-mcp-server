/**
 * @fileoverview Child process for the gated pipe-transport tests, written as plain ESM so
 * the same file runs under Bun and under Node (which strips the types of the `.ts` module
 * it imports). It launches a browser through `spawnPiped`, drives a page over the CDP
 * pipe, and prints one JSON line: the runtime, the browser's pid and product, and the
 * page's answer. It then waits. A `close` line on stdin closes the browser, prints how it
 * exited, and exits; a SIGKILL from the parent stands in for a server that dies with its
 * browser open.
 *
 * Usage: `<bun|node> pipe-child.mjs <browser> <launch-args-json>`
 * @module tests/browser/helpers/pipe-child
 */

import { createInterface } from 'node:readline';
import { spawnPiped } from '../../../src/services/browser/cdp-pipe.ts';

const [browserPath = '', args = '[]'] = process.argv.slice(2);
const browser = await spawnPiped(browserPath, JSON.parse(args));
const { cdp } = browser;

const { product } = await cdp.send('Browser.getVersion');
const { browserContextId } = await cdp.send('Target.createBrowserContext');
const { targetId } = await cdp.send('Target.createTarget', {
  url: 'about:blank',
  browserContextId,
});
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const { result } = await cdp.send(
  'Runtime.evaluate',
  { expression: '6 * 7', returnByValue: true },
  { sessionId },
);

console.log(
  JSON.stringify({
    runtime: process.versions.bun ? 'bun' : 'node',
    version: process.versions.bun ?? process.versions.node,
    browserPid: browser.pid,
    product,
    value: result.value,
  }),
);

for await (const line of createInterface({ input: process.stdin })) {
  if (line !== 'close') continue;
  await cdp.send('Browser.close').catch(() => {});
  console.log(JSON.stringify({ exited: await browser.exited }));
  process.exit(0);
}
