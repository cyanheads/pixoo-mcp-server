/**
 * @fileoverview Boots the server entry point over HTTP and reads the session mode
 * it publishes on the server card, pinning the posture `createApp()` declares.
 * @module tests/index.session-mode.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSION_MODE_META_KEY = 'io.github.cyanheads.mcp-ts-core/sessionMode';

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port assigned')),
      );
    });
  });
}

/**
 * Starts the entry point with the given `MCP_SESSION_MODE` and returns the
 * session mode from `/.well-known/mcp.json`. An empty value reads as unset.
 * The probed port is released before the child binds it, so another process can
 * take it in between; a child that exits before serving is retried on a fresh port.
 */
async function publishedSessionMode(sessionModeEnv: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const card = await bootAndReadCard(sessionModeEnv);
    if (card) return card._meta?.[SESSION_MODE_META_KEY];
  }
  throw new Error('Server exited before serving its card on three consecutive ports');
}

/** Boots one child; resolves its card, or `undefined` when the child exits first. */
async function bootAndReadCard(
  sessionModeEnv: string,
): Promise<{ _meta?: Record<string, unknown> } | undefined> {
  const port = await freePort();
  const proc = spawn('bun', [ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(port),
      MCP_SESSION_MODE: sessionModeEnv,
      MCP_LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  child = proc;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) return undefined;
    // Each attempt is bounded so one stalled connection cannot outlive the deadline.
    const card = await fetch(`http://127.0.0.1:${port}/.well-known/mcp.json`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (res) => (res.ok ? (res.json() as Promise<{ _meta?: Record<string, unknown> }>) : undefined),
      () => undefined,
    );
    // A card read after the child exited came from whatever took the port.
    if (card && !exited) return card;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server did not serve its card within 20s');
}

describe('entry point session mode', () => {
  it('runs stateless when MCP_SESSION_MODE is unset', async () => {
    expect(await publishedSessionMode('')).toBe('stateless');
  }, 30_000);

  it('lets an explicit MCP_SESSION_MODE override the declared default', async () => {
    expect(await publishedSessionMode('stateful')).toBe('stateful');
  }, 30_000);
});
