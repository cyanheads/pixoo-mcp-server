/**
 * @fileoverview Global setup for the gated browser suite: fails the whole run, before any
 * test starts, unless PIXOO_TEST_BROWSER_PATH names an executable file.
 * @module tests/browser/helpers/require-test-browser
 */

import { testBrowserPath } from './browser-under-test.js';

export default async function requireTestBrowser(): Promise<void> {
  await testBrowserPath();
}
