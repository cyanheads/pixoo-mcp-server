/**
 * @fileoverview Boots the server entry point over stdio and pins how `PIXOO_HTML_ENABLED`
 * gates `pixoo_render_html`: listed when unset or true, gone from `tools/list` when false,
 * and a startup failure for a value that is not a boolean. The entry runs under
 * `bun --no-env-file` in a scratch directory, so `.env` is loaded only the way it is under
 * Node — by the framework — which is what the `.env` case checks.
 * @module tests/index.html-flag.test
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOOL = 'pixoo_render_html';

let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

interface JsonRpcResponse {
  error?: { message: string };
  id: number;
  result?: Record<string, unknown>;
}

/** The test runner's environment without any server or framework setting. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('PIXOO_') && !key.startsWith('MCP_')) env[key] = value;
  }
  return { ...env, MCP_TRANSPORT_TYPE: 'stdio', MCP_LOG_LEVEL: 'error', ...extra };
}

/**
 * Starts the entry point in `cwd` with `env` and returns a line-delimited JSON-RPC
 * client over its stdio, plus a promise of its exit code and stderr.
 */
function startServer(cwd: string, env: Record<string, string>) {
  const proc = spawn('bun', ['--no-env-file', ENTRY], { cwd, env: cleanEnv(env) });
  child = proc;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    for (let end = stdout.indexOf('\n'); end >= 0; end = stdout.indexOf('\n')) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      pending.get(message.id)?.(message);
    }
  });
  proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) =>
    proc.once('exit', (code) => resolve({ code, stderr })),
  );

  let nextId = 1;
  const send = (message: object) => proc.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (response) =>
        response.error ? reject(new Error(response.error.message)) : resolve(response.result ?? {}),
      );
      void exited.then(({ code, stderr: log }) =>
        reject(new Error(`Server exited (${code}) before answering ${method}: ${log}`)),
      );
      send({ jsonrpc: '2.0', id, method, params });
    });

  return {
    exited,
    request,
    /** `initialize` then `notifications/initialized`; resolves the initialize result. */
    async initialize() {
      const result = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'html-flag-test', version: '0.0.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result as { instructions?: string };
    },
  };
}

async function scratchDir(dotenv?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixoo-html-flag-'));
  if (dotenv !== undefined) await fs.writeFile(path.join(dir, '.env'), dotenv);
  return dir;
}

/** Boots the server with `env`, returning its tool names and server instructions. */
async function surface(env: Record<string, string>, dotenv?: string) {
  const server = startServer(await scratchDir(dotenv), env);
  const { instructions } = await server.initialize();
  const { tools } = (await server.request('tools/list')) as { tools: { name: string }[] };
  return { instructions: instructions ?? '', names: tools.map((t) => t.name), server };
}

describe('PIXOO_HTML_ENABLED', () => {
  it('lists pixoo_render_html and names it in the instructions when unset', async () => {
    const { instructions, names } = await surface({});
    expect(names).toContain(TOOL);
    expect(instructions).toContain(TOOL);
  }, 30_000);

  it('lists pixoo_render_html when true', async () => {
    const { names } = await surface({ PIXOO_HTML_ENABLED: 'true' });
    expect(names).toContain(TOOL);
  }, 30_000);

  it('removes pixoo_render_html from tools/list and the instructions when false', async () => {
    const { instructions, names } = await surface({ PIXOO_HTML_ENABLED: 'false' });
    expect(names).not.toContain(TOOL);
    expect(names).toContain('pixoo_compose_scene');
    expect(instructions).not.toContain(TOOL);
  }, 30_000);

  it('fails startup on a value that is not a boolean', async () => {
    const server = startServer(await scratchDir(), { PIXOO_HTML_ENABLED: 'nope' });
    const { code, stderr } = await server.exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain('PIXOO_HTML_ENABLED');
  }, 30_000);

  it('is read from .env with the rest of the server config, PIXOO_IP included', async () => {
    const { names, server } = await surface(
      {},
      'PIXOO_IP=127.0.0.1\nPIXOO_HTML_ENABLED=false\nPIXOO_PUSH_MIN_INTERVAL_MS=0\n',
    );
    expect(names).not.toContain(TOOL);
    const { contents } = (await server.request('resources/read', {
      uri: 'pixoo://device/status',
    })) as { contents: { text: string }[] };
    expect(JSON.parse(contents[0]?.text ?? '{}')).toMatchObject({ configuredIp: '127.0.0.1' });
  }, 30_000);
});
