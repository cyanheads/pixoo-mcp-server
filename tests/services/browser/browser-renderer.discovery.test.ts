/**
 * @fileoverview Tests for browser discovery: PIXOO_BROWSER_PATH as the only candidate when
 * set, then the newest chrome-headless-shell for the host in Puppeteer's cache, and
 * `browser_unavailable` otherwise. Every browser here is an empty executable file in a
 * temp directory; nothing is launched.
 * @module tests/services/browser/browser-renderer.discovery.test
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BROWSER_UNAVAILABLE_RECOVERY,
  discoverBrowser,
} from '@/services/browser/browser-renderer.js';

let root: string;
let cache: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pixoo-discovery-'));
  cache = path.join(root, 'puppeteer');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Lay out a Puppeteer install: `<cache>/chrome-headless-shell/<build>/<folder>/<exe>`. */
async function install(build: string, folder: string, exe = 'chrome-headless-shell', mode = 0o755) {
  const dir = path.join(cache, 'chrome-headless-shell', build, folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, exe);
  await writeFile(file, '');
  await chmod(file, mode);
  return file;
}

async function executable(name: string, mode = 0o755) {
  const file = path.join(root, name);
  await writeFile(file, '');
  await chmod(file, mode);
  return file;
}

const macArm = { platform: 'darwin', arch: 'arm64' } as const;

async function unavailable(promise: Promise<unknown>): Promise<McpError> {
  const err = (await promise.then(
    () => {
      throw new Error('expected browser_unavailable');
    },
    (e: unknown) => e,
  )) as McpError;
  expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
  expect(err.data).toMatchObject({ reason: 'browser_unavailable' });
  return err;
}

describe('discoverBrowser', () => {
  describe('PIXOO_BROWSER_PATH', () => {
    it('is returned when it names an executable file, ahead of the cache', async () => {
      await install('mac_arm-154.0.8037.57', 'chrome-headless-shell-mac-arm64');
      const browserPath = await executable('my-browser');
      await expect(discoverBrowser({ browserPath, cacheDir: cache, ...macArm })).resolves.toBe(
        browserPath,
      );
    });

    it('fails browser_unavailable naming a missing path, with no fall-through to the cache', async () => {
      await install('mac_arm-154.0.8037.57', 'chrome-headless-shell-mac-arm64');
      const browserPath = path.join(root, 'nowhere', 'chrome-headless-shell');
      const err = await unavailable(discoverBrowser({ browserPath, cacheDir: cache, ...macArm }));
      expect(err.message).toBe(
        `PIXOO_BROWSER_PATH is set to ${browserPath}, which does not exist.`,
      );
    });

    it('fails browser_unavailable for a directory, such as an app bundle', async () => {
      const browserPath = path.join(root, 'Chromium.app');
      await mkdir(browserPath);
      const err = await unavailable(discoverBrowser({ browserPath, cacheDir: cache, ...macArm }));
      expect(err.message).toBe(
        `PIXOO_BROWSER_PATH is set to ${browserPath}, which is not a file. Set it to the browser executable itself.`,
      );
    });

    it('fails browser_unavailable for a file that is not executable', async () => {
      const browserPath = await executable('not-executable', 0o644);
      const err = await unavailable(discoverBrowser({ browserPath, cacheDir: cache, ...macArm }));
      expect(err.message).toBe(
        `PIXOO_BROWSER_PATH is set to ${browserPath}, which is not executable.`,
      );
    });
  });

  describe("Puppeteer's cache", () => {
    it('returns the newest build for the host by numeric version, ignoring other platforms', async () => {
      await install('mac_arm-99.0.4844.51', 'chrome-headless-shell-mac-arm64');
      await install('mac_arm-138.0.7204.168', 'chrome-headless-shell-mac-arm64');
      const newest = await install('mac_arm-154.0.8037.57', 'chrome-headless-shell-mac-arm64');
      await install('mac_arm-154.0.8037.9', 'chrome-headless-shell-mac-arm64');
      await install('mac-200.0.0.0', 'chrome-headless-shell-mac-x64');
      await install('linux_arm-200.0.0.0', 'chrome-headless-shell-linux-arm64');
      await expect(discoverBrowser({ cacheDir: cache, ...macArm })).resolves.toBe(newest);
    });

    it('skips a build with no executable and takes the next newest', async () => {
      const older = await install('mac_arm-138.0.7204.168', 'chrome-headless-shell-mac-arm64');
      await mkdir(path.join(cache, 'chrome-headless-shell', 'mac_arm-154.0.8037.57'), {
        recursive: true,
      });
      await install(
        'mac_arm-155.0.0.0',
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
        0o644,
      );
      await expect(discoverBrowser({ cacheDir: cache, ...macArm })).resolves.toBe(older);
    });

    it.each([
      [
        'darwin',
        'arm64',
        'mac_arm-154.0.8037.57',
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      ],
      [
        'darwin',
        'x64',
        'mac-154.0.8037.57',
        'chrome-headless-shell-mac-x64',
        'chrome-headless-shell',
      ],
      [
        'linux',
        'x64',
        'linux-154.0.8037.57',
        'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      ],
      [
        'linux',
        'arm64',
        'linux_arm-154.0.8037.57',
        'chrome-headless-shell-linux-arm64',
        'chrome-headless-shell',
      ],
      [
        'linux',
        'arm64',
        'linux_arm-138.0.7204.168',
        'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      ],
      [
        'win32',
        'x64',
        'win64-154.0.8037.57',
        'chrome-headless-shell-win64',
        'chrome-headless-shell.exe',
      ],
      [
        'win32',
        'ia32',
        'win32-154.0.8037.57',
        'chrome-headless-shell-win32',
        'chrome-headless-shell.exe',
      ],
    ] as const)('on %s/%s reads %s/%s/%s', async (platform, arch, build, folder, exe) => {
      const file = await install(build, folder, exe);
      await expect(discoverBrowser({ cacheDir: cache, platform, arch })).resolves.toBe(file);
    });

    it("defaults to ~/.cache/puppeteer under the user's home directory", async () => {
      const home = process.env['HOME'];
      process.env['HOME'] = root;
      try {
        cache = path.join(root, '.cache', 'puppeteer');
        const file = await install('mac_arm-154.0.8037.57', 'chrome-headless-shell-mac-arm64');
        await expect(discoverBrowser(macArm)).resolves.toBe(file);
      } finally {
        process.env['HOME'] = home;
      }
    });

    it('fails browser_unavailable naming the cache when it holds no build for the host', async () => {
      await install('mac-154.0.8037.57', 'chrome-headless-shell-mac-x64');
      const err = await unavailable(discoverBrowser({ cacheDir: cache, ...macArm }));
      expect(err.message).toBe(
        `No browser found: PIXOO_BROWSER_PATH is unset, and ${path.join(cache, 'chrome-headless-shell')} holds no chrome-headless-shell build for mac_arm.`,
      );
    });

    it('fails browser_unavailable when the cache does not exist', async () => {
      await unavailable(discoverBrowser({ cacheDir: cache, ...macArm }));
    });

    it('fails browser_unavailable on a host Puppeteer has no build for', async () => {
      const err = await unavailable(
        discoverBrowser({ cacheDir: cache, platform: 'freebsd', arch: 'x64' }),
      );
      expect(err.message).toBe(
        'No browser found: PIXOO_BROWSER_PATH is unset, and chrome-headless-shell has no build for freebsd/x64.',
      );
    });
  });
});

describe('BROWSER_UNAVAILABLE_RECOVERY', () => {
  it('names the install command and PIXOO_BROWSER_PATH', () => {
    expect(BROWSER_UNAVAILABLE_RECOVERY).toContain(
      'npx @puppeteer/browsers install chrome-headless-shell@stable --path <dir>',
    );
    expect(BROWSER_UNAVAILABLE_RECOVERY).toContain(
      'set PIXOO_BROWSER_PATH to the executable path the install prints',
    );
  });
});
