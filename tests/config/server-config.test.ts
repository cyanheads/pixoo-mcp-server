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
});
