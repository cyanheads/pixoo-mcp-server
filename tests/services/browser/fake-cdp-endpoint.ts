/**
 * @fileoverview A fake Chrome DevTools Protocol endpoint for tests that must not launch a
 * browser. `FakeCdpEndpoint.start()` writes a launchable executable that stands in for
 * the browser: spawned with `--remote-debugging-pipe` wiring, it reads commands from its
 * fd 3 and writes to its fd 4, and bridges both to this process over one 127.0.0.1
 * connection, so each launch is a real child process with a real pid and real pipes,
 * while its CDP behavior is scripted here. Like Chromium, it exits when fd 3 closes.
 *
 * On connect it reports its launch — argv and the `Default/Preferences` file of its
 * `--user-data-dir`, read before anything could delete it — as a `FakeLaunch`. Each
 * command it receives is recorded on `FakeBrowser.commands` (with its `sessionId`, so a
 * browser-session command is one without) and answered by the handler registered for its
 * method: the handler's return value is the result, a throw is a CDP error, and a promise
 * that never settles is a command that never answers (a hung renderer). A method with no
 * handler gets Chromium's "wasn't found" error, so a test declares every command it
 * expects. `FakeBrowser.emit` sends events; `kill()` crashes the process by its pid.
 *
 * `fakePipePair()` gives the same `FakeBrowser` over in-memory streams, with the raw-byte
 * access framing tests need, and no process.
 * @module tests/services/browser/fake-cdp-endpoint
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { CdpPipe } from '@/services/browser/cdp-pipe.js';

/** One command as the fake browser received it. */
export interface CdpCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  /** Absent for a command sent on the browser session. */
  sessionId?: string;
}

/** What a spawned fake browser saw at launch. */
export interface FakeLaunch {
  /** Arguments after the executable, in order. */
  argv: string[];
  /** The process id — the pid the launcher spawned. */
  pid: number;
  /** Raw contents of `<--user-data-dir>/Default/Preferences` at launch; null when absent. */
  preferences: string | null;
}

/**
 * Answers one command. Return (or resolve) the result; throw for a CDP error response —
 * an error with a numeric `code` keeps it, anything else answers -32000.
 */
export type CommandHandler = (command: CdpCommand, browser: FakeBrowser) => unknown;

/** Handlers every fake browser starts with; `handle()` overrides them. */
const DEFAULT_HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  [
    'Browser.getVersion',
    () => ({
      protocolVersion: '1.3',
      product: 'HeadlessChrome/0.0.0.0',
      revision: '@fake',
      userAgent: 'FakeCdpEndpoint',
      jsVersion: '0.0',
    }),
  ],
  [
    'Browser.close',
    (_command, browser) => {
      setImmediate(() => browser.disconnect());
      return {};
    },
  ],
]);

/** Splits a byte stream on NUL bytes; each complete frame goes to `onFrame` as text. */
function readFrames(input: Readable, onFrame: (text: string) => void): void {
  let pending: Buffer[] = [];
  input.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString('utf8');
      pending = [];
      onFrame(text);
      start = end + 1;
    }
    if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
  });
}

/** The browser side of one CDP pipe. */
export class FakeBrowser {
  /** Every command received, in arrival order. */
  readonly commands: CdpCommand[] = [];
  /** Resolves once the browser side of the pipe has closed. */
  readonly disconnected: Promise<void>;
  readonly #output: Writable;
  readonly #handlers: ReadonlyMap<string, CommandHandler>;
  readonly #waiters = new Set<{ match(c: CdpCommand): boolean; resolve(c: CdpCommand): void }>();
  readonly #pid: number | undefined;
  #connected = true;

  constructor(
    input: Readable,
    output: Writable,
    handlers: ReadonlyMap<string, CommandHandler>,
    /** Set for a spawned fake; absent over `fakePipePair()`. */
    readonly launch?: FakeLaunch,
  ) {
    this.#output = output;
    this.#handlers = handlers;
    this.#pid = launch?.pid;
    this.disconnected = new Promise((resolve) =>
      output.once('close', () => {
        this.#connected = false;
        resolve();
      }),
    );
    readFrames(input, (text) => this.#receive(JSON.parse(text) as CdpCommand));
  }

  /** Send an event, on `sessionId` when given. */
  emit(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.#write({ method, params, ...(sessionId !== undefined && { sessionId }) });
  }

  /** Write bytes to the client as they are — for framing tests. */
  sendRaw(bytes: string | Uint8Array): void {
    this.#output.write(bytes);
  }

  /** The first received command of `method` matching `predicate`, now or when it arrives. */
  waitForCommand(
    method: string,
    predicate: (command: CdpCommand) => boolean = () => true,
  ): Promise<CdpCommand> {
    const match = (c: CdpCommand) => c.method === method && predicate(c);
    const seen = this.commands.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.#waiters.add({ match, resolve }));
  }

  /** False once the browser side of the pipe has closed. */
  get isConnected(): boolean {
    return this.#connected;
  }

  /** Close the browser's side of the pipe, as a browser that exits does. */
  disconnect(): void {
    this.#output.end();
  }

  /** Signal the spawned fake process by its pid (default SIGKILL: a crash). */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.#pid === undefined) throw new Error('kill() needs a spawned fake browser');
    process.kill(this.#pid, signal);
  }

  #receive(command: CdpCommand): void {
    this.commands.push(command);
    for (const waiter of this.#waiters) {
      if (!waiter.match(command)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(command);
    }
    const handler = this.#handlers.get(command.method) ?? DEFAULT_HANDLERS.get(command.method);
    const session = command.sessionId !== undefined && { sessionId: command.sessionId };
    if (!handler) {
      this.#write({
        id: command.id,
        error: { code: -32601, message: `'${command.method}' wasn't found` },
        ...session,
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(command, this))
      .then(
        (result) => this.#write({ id: command.id, result: result ?? {}, ...session }),
        (err: Error & { code?: unknown }) =>
          this.#write({
            id: command.id,
            error: { code: typeof err.code === 'number' ? err.code : -32000, message: err.message },
            ...session,
          }),
      );
  }

  #write(message: Record<string, unknown>): void {
    if (this.#output.writableEnded || this.#output.destroyed) return;
    this.#output.write(`${JSON.stringify(message)}\0`);
  }
}

/**
 * The stand-in browser executable. It bridges its fds 3 and 4 to the endpoint's
 * 127.0.0.1 listener and exits when fd 3 closes or the endpoint hangs up. CommonJS, so it
 * runs from an extensionless file.
 */
function bridgeSource(port: number): string {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const argv = process.argv.slice(2);
const dirFlag = argv.find((arg) => arg.startsWith('--user-data-dir='));
let preferences = null;
if (dirFlag) {
  try {
    preferences = fs.readFileSync(path.join(dirFlag.slice('--user-data-dir='.length), 'Default', 'Preferences'), 'utf8');
  } catch {}
}
const socket = net.connect(${port}, '127.0.0.1');
socket.on('error', () => process.exit(1));
socket.write(JSON.stringify({ pid: process.pid, argv, preferences }) + '\\0');
const commands = fs.createReadStream(null, { fd: 3 });
commands.on('end', () => process.exit(0));
commands.pipe(socket, { end: false });
const replies = fs.createWriteStream(null, { fd: 4 });
socket.pipe(replies);
socket.on('close', () => replies.end());
replies.on('finish', () => process.exit(0));
`;
}

/** A fake browser executable plus the scripted CDP endpoint its launches connect to. */
export class FakeCdpEndpoint {
  /** Every launch that has connected, in order. */
  readonly browsers: FakeBrowser[] = [];
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #server: Server;
  readonly #dir: string;
  readonly #sockets = new Set<Socket>();
  readonly #arrivals: ((browser: FakeBrowser) => void)[] = [];

  private constructor(server: Server, dir: string) {
    this.#server = server;
    this.#dir = dir;
    server.on('connection', (socket) => this.#accept(socket));
  }

  /** Listen on 127.0.0.1 and write the fake browser executable. */
  static async start(): Promise<FakeCdpEndpoint> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pixoo-fake-cdp-'));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = new FakeCdpEndpoint(server, dir);
    await writeFile(endpoint.executablePath, bridgeSource((server.address() as AddressInfo).port), {
      mode: 0o755,
    });
    return endpoint;
  }

  /** Path to launch as the browser. */
  get executablePath(): string {
    return path.join(this.#dir, 'fake-browser');
  }

  /** Answer `method` with `handler` on every launch. */
  handle(method: string, handler: CommandHandler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  /** The next launch to connect after this call. */
  nextBrowser(): Promise<FakeBrowser> {
    return new Promise((resolve) => this.#arrivals.push(resolve));
  }

  /**
   * Hang up on every fake still connected — each exits once its fd 4 has flushed, so no
   * pid is signalled — then stop listening and delete the executable.
   */
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await Promise.all(this.browsers.map((browser) => browser.disconnected));
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.#dir, { recursive: true, force: true });
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(0);
      if (end === -1) return;
      socket.off('data', onData);
      socket.pause();
      const launch = JSON.parse(head.subarray(0, end).toString('utf8')) as FakeLaunch;
      if (end + 1 < head.length) socket.unshift(head.subarray(end + 1));
      const browser = new FakeBrowser(socket, socket, this.#handlers, launch);
      this.browsers.push(browser);
      for (const arrive of this.#arrivals.splice(0)) arrive(browser);
      socket.resume();
    };
    socket.on('data', onData);
  }
}

/** A `CdpPipe` wired to a `FakeBrowser` over in-memory streams — no process. */
export function fakePipePair(handlers: Record<string, CommandHandler> = {}): {
  cdp: CdpPipe;
  browser: FakeBrowser;
} {
  const toBrowser = new PassThrough();
  const toClient = new PassThrough();
  const browser = new FakeBrowser(toBrowser, toClient, new Map(Object.entries(handlers)));
  return { cdp: new CdpPipe(toClient, toBrowser), browser };
}
