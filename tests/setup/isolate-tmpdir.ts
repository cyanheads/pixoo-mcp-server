/**
 * @fileoverview Unit-project setup file: points `os.tmpdir()` at a fresh directory for
 * each test file and deletes it after the file's own teardown, so `bun run test` leaves
 * the system temp dir as it found it. Everything a test writes there lands in it: the
 * preview a failed push keeps, browser profiles, image-source fixtures, fake executables.
 * @module tests/setup/isolate-tmpdir
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env['TMPDIR'];
const dir = mkdtempSync(path.join(os.tmpdir(), 'pixoo-test-file-'));
process.env['TMPDIR'] = dir;

// Registered before the test file's hooks, so it runs after them.
afterAll(() => {
  if (previous === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = previous;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
