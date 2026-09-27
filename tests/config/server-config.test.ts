/**
 * @fileoverview Tests for the server config read from environment variables.
 * @module tests/config/server-config.test
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe('getServerConfig', () => {
  describe('PIXOO_OUTPUT_DIR', () => {
    /** The working directory the config is read from, as the process reports it. */
    let cwd: string;
    let previousCwd: string;

    beforeAll(async () => {
      cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixoo-config-cwd-')));
    });

    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    beforeEach(() => {
      previousCwd = process.cwd();
      process.chdir(cwd);
      resetServerConfig();
    });

    afterEach(() => {
      process.chdir(previousCwd);
      delete process.env['PIXOO_OUTPUT_DIR'];
      resetServerConfig();
    });

    it.each([
      ['previews', 'previews'],
      ['./previews', 'previews'],
      ['nested/previews/', 'nested/previews'],
      ['../previews', '../previews'],
    ])('a relative %j resolves against the working directory', (value, under) => {
      process.env['PIXOO_OUTPUT_DIR'] = value;
      const dir = getServerConfig().pixooOutputDir;
      expect(dir).toBe(path.join(cwd, under));
      expect(path.isAbsolute(dir as string)).toBe(true);
    });

    it('an absolute directory is kept as given', () => {
      process.env['PIXOO_OUTPUT_DIR'] = '/tmp/pixoo-previews';
      expect(getServerConfig().pixooOutputDir).toBe('/tmp/pixoo-previews');
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['an unsubstituted placeholder', `\${user_config.pixoo_output_dir}`],
    ])('%s leaves the directory unset', (_label, value) => {
      if (value !== undefined) process.env['PIXOO_OUTPUT_DIR'] = value;
      expect(getServerConfig().pixooOutputDir).toBeUndefined();
    });
  });

  describe('PIXOO_SERVE_HOST / PIXOO_SERVE_PORT', () => {
    beforeEach(() => resetServerConfig());

    afterEach(() => {
      delete process.env['PIXOO_SERVE_HOST'];
      delete process.env['PIXOO_SERVE_PORT'];
      resetServerConfig();
    });

    it('reads the advertised host and the fixed port', () => {
      process.env['PIXOO_SERVE_HOST'] = 'pixoo-host.lan';
      process.env['PIXOO_SERVE_PORT'] = '8765';
      expect(getServerConfig()).toMatchObject({
        pixooServeHost: 'pixoo-host.lan',
        pixooServePort: 8765,
      });
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['an unsubstituted placeholder', `\${user_config.pixoo_serve_port}`],
    ])('%s leaves both unset', (_label, value) => {
      if (value !== undefined) {
        process.env['PIXOO_SERVE_HOST'] = value;
        process.env['PIXOO_SERVE_PORT'] = value;
      }
      const cfg = getServerConfig();
      expect(cfg.pixooServeHost).toBeUndefined();
      expect(cfg.pixooServePort).toBeUndefined();
    });

    it.each(['0', '65536', '80.5', 'http'])('rejects PIXOO_SERVE_PORT=%s', (port) => {
      process.env['PIXOO_SERVE_PORT'] = port;
      expect(() => getServerConfig()).toThrow();
    });

    it.each([
      ['1', 1],
      ['65535', 65535],
    ])('accepts PIXOO_SERVE_PORT=%s', (port, expected) => {
      process.env['PIXOO_SERVE_PORT'] = port;
      expect(getServerConfig().pixooServePort).toBe(expected);
    });
  });

  describe('PIXOO_BROWSER_PATH', () => {
    beforeEach(() => resetServerConfig());

    afterEach(() => {
      delete process.env['PIXOO_BROWSER_PATH'];
      resetServerConfig();
    });

    it('an absolute path is kept as given', () => {
      process.env['PIXOO_BROWSER_PATH'] = '/opt/browsers/chrome-headless-shell';
      expect(getServerConfig().pixooBrowserPath).toBe('/opt/browsers/chrome-headless-shell');
    });

    it('a relative path resolves against the working directory, so it is never looked up on PATH', () => {
      process.env['PIXOO_BROWSER_PATH'] = 'chrome-headless-shell';
      expect(getServerConfig().pixooBrowserPath).toBe(
        path.join(process.cwd(), 'chrome-headless-shell'),
      );
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['an unsubstituted placeholder', `\${user_config.pixoo_browser_path}`],
    ])('%s leaves it unset', (_label, value) => {
      if (value !== undefined) process.env['PIXOO_BROWSER_PATH'] = value;
      expect(getServerConfig().pixooBrowserPath).toBeUndefined();
    });
  });
});
