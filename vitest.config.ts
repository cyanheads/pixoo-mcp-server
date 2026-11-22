/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      // gifenc ships only a CJS "main" (no "exports" map). When pixoo-toolkit
      // imports it as a named ESM import in the forks pool's native-ESM context,
      // Node can't find the named exports. Inlining it forces the transform
      // pipeline to handle the CJS→ESM conversion so named imports resolve.
      server: {
        deps: { inline: ['gifenc', '@cyanheads/pixoo-toolkit'] },
      },
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: [
              'tests/smoke/**',
              'tests/integration/**',
              'tests/fuzz/**',
              'tests/browser/**',
            ],
            // Each test file writes to its own temp dir, deleted after the file.
            setupFiles: ['tests/setup/isolate-tmpdir.ts'],
          },
        },
        /**
         * The gated real-browser suite (`bun run test:browser`). It exists only when
         * PIXOO_BROWSER_SUITE=1, so `bun run test` launches no browser even with
         * PIXOO_TEST_BROWSER_PATH exported; the global setup fails the run when that
         * variable does not name an executable.
         */
        ...(process.env.PIXOO_BROWSER_SUITE === '1'
          ? [
              {
                extends: true,
                test: {
                  name: 'browser',
                  include: ['tests/browser/**/*.test.ts'],
                  globalSetup: ['tests/browser/helpers/require-test-browser.ts'],
                  maxWorkers: 1,
                  testTimeout: 60_000,
                  hookTimeout: 60_000,
                },
              },
            ]
          : []),
        // Add more projects as your suite grows. Each inherits the framework's
        // base config (environment, pool, coverage) and can override freely.
        //
        // {
        //   extends: true,
        //   test: {
        //     name: 'smoke',
        //     include: ['tests/smoke/**/*.test.ts'],
        //   },
        // },
        // {
        //   extends: true,
        //   test: {
        //     name: 'fuzz',
        //     include: ['tests/fuzz/**/*.test.ts'],
        //     testTimeout: 15_000,
        //   },
        // },
        // {
        //   extends: true,
        //   test: {
        //     name: 'integration',
        //     include: ['tests/integration/**/*.test.ts'],
        //     maxWorkers: 1,
        //     testTimeout: 30_000,
        //   },
        // },
      ],
    },
  }),
);
