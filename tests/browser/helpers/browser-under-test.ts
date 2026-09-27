/**
 * @fileoverview The browser the gated suite runs, and a wrapper around it. The browser
 * comes from PIXOO_TEST_BROWSER_PATH; `testBrowserPath()` throws when that is unset or
 * not an executable file. `BrowserWrapper` writes a launchable shell script that `exec`s
 * the browser under test with the same arguments plus `--log-net-log`, recording each
 * launch's pid (the browser's own, since `exec` keeps it) and profile directory first,
 * and exporting a per-wrapper marker that every browser process inherits. Hand its
 * `executablePath` to `BrowserRenderer` as `browserPath`, or to `spawnPiped`.
 * `survivors()` finds any process of any launch still running, helpers included;
 * `cleanup()` kills those by exact pid and reports them.
 * @module tests/browser/helpers/browser-under-test
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const INSTALL_HINT =
  '`npx @puppeteer/browsers install chrome-headless-shell@stable --path <dir>` prints the executable path.';

/** The environment variable the wrapper exports to every process of its launches. */
export const RUN_MARKER = 'PIXOO_BROWSER_SUITE_RUN';

/**
 * The browser under test, resolved to an absolute path.
 * @throws When PIXOO_TEST_BROWSER_PATH is unset or does not name an executable file.
 */
export async function testBrowserPath(): Promise<string> {
  const value = process.env.PIXOO_TEST_BROWSER_PATH;
  if (!value) {
    throw new Error(
      `PIXOO_TEST_BROWSER_PATH is unset. The browser suite needs it to name a chrome-headless-shell executable; ${INSTALL_HINT}`,
    );
  }
  const file = path.resolve(value);
  const executable = await access(file, constants.X_OK)
    .then(() => stat(file))
    .then((s) => s.isFile())
    .catch(() => false);
  if (!executable) {
    throw new Error(`PIXOO_TEST_BROWSER_PATH (${file}) is not an executable file; ${INSTALL_HINT}`);
  }
  return file;
}

/** One browser launch through the wrapper. */
export interface Launch {
  /** Where the browser writes its net log; see `readNetLogs`. */
  readonly netLog: string;
  /** The browser's pid. */
  readonly pid: number;
  /** The browser's `--user-data-dir`, or `''` when it was launched without one. */
  readonly profile: string;
}

/** A process still running after its browser should have exited. */
export interface Survivor {
  readonly command: string;
  readonly pid: number;
}

/** A launchable wrapper around the browser under test, with its own scratch directory. */
export class BrowserWrapper {
  private constructor(readonly dir: string) {}

  /** Write the wrapper into a fresh temp directory. */
  static async create(): Promise<BrowserWrapper> {
    const browser = await testBrowserPath();
    const wrapper = new BrowserWrapper(
      await mkdtemp(path.join(os.tmpdir(), 'pixoo-browser-suite-')),
    );
    await writeFile(wrapper.executablePath, wrapperScript(browser, wrapper.dir), { mode: 0o755 });
    return wrapper;
  }

  /** The file to launch in place of the browser. */
  get executablePath(): string {
    return path.join(this.dir, 'browser');
  }

  /** Every launch so far, oldest first. */
  async launches(): Promise<Launch[]> {
    const text = await readFile(path.join(this.dir, 'launches'), 'utf8').catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return '';
        throw err;
      },
    );
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid = '', arg = ''] = line.split(' ', 2);
        return {
          pid: Number(pid),
          profile: arg.replace(/^--user-data-dir=/, ''),
          netLog: this.netLogPath(Number(pid)),
        };
      });
  }

  /**
   * Processes still running from any launch: a recorded browser pid that is alive, or any
   * process carrying this wrapper's {@link RUN_MARKER} in its environment. Chromium's
   * helper processes (GPU, network, renderers) inherit the environment but not the
   * browser's arguments, and keep the marker after the browser dies and they are
   * reparented.
   */
  async survivors(): Promise<Survivor[]> {
    const pids = new Set((await this.launches()).map((l) => l.pid));
    const marked = await markedPids(`${RUN_MARKER}=${this.marker}`);
    return (await listProcesses()).filter(
      ({ pid }) => pid !== process.pid && (pids.has(pid) || marked.has(pid)),
    );
  }

  /**
   * Kill every survivor by its exact pid, delete the scratch directory, and return the
   * survivors as they were found (empty when every launch had already exited).
   */
  async cleanup(): Promise<Survivor[]> {
    const survivors = await this.survivors();
    for (const { pid } of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Exited between the listing and the kill.
      }
    }
    await rm(this.dir, { recursive: true, force: true, maxRetries: 3 });
    return survivors;
  }

  /** This wrapper's value of {@link RUN_MARKER}: its directory's unique name. */
  private get marker(): string {
    return path.basename(this.dir);
  }

  private netLogPath(pid: number): string {
    return path.join(this.dir, `net-log-${pid}.json`);
  }
}

/** Pids of the processes whose environment holds `entry` (`NAME=value`); `ps -E` lists it. */
async function markedPids(entry: string): Promise<Set<number>> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-ww', '-E', '-o', 'pid=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const pids = new Set<number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line);
    if (match && line.split(/\s/).includes(entry)) pids.add(Number(match[1]));
  }
  return pids;
}

/** Every process on the host, as `ps` lists it. */
export async function listProcesses(): Promise<Survivor[]> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-ww', '-o', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2] ?? '' }));
}

/** Whether a process with `pid` exists. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `exec` keeps the shell's pid, so `$$` is the browser's pid. The profile argument is
 * recorded whole; `launches()` strips its flag.
 */
function wrapperScript(browser: string, dir: string): string {
  return `${[
    '#!/bin/sh',
    `export ${RUN_MARKER}=${shellQuote(path.basename(dir))}`,
    'profile=',
    'for arg in "$@"; do',
    '  case "$arg" in --user-data-dir=*) profile="$arg" ;; esac',
    'done',
    `echo "$$ $profile" >> ${shellQuote(path.join(dir, 'launches'))}`,
    `exec ${shellQuote(browser)} "$@" ${shellQuote(`--log-net-log=${dir}/net-log-`)}"$$.json" --net-log-capture-mode=Everything`,
  ].join('\n')}\n`;
}
