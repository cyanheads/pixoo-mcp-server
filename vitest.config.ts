/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest 4 `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */

import { readFile } from 'node:fs/promises';
import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig, type Plugin } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

/**
 * pixoo-toolkit publishes `dist/src/*.js.map` files whose `sources` point at
 * `../../src/*.ts`, which the package does not ship. Inlining the toolkit (below)
 * routes it through Vite, which then warns once per file that the map points to
 * missing sources. Loading the JS without its map comment removes the dead
 * reference; stack traces land on the published JS, the only source there is.
 * Remove once cyanheads/pixoo-toolkit#42 ships resolvable maps.
 */
const pixooToolkitWithoutSourcemaps: Plugin = {
  name: 'pixoo-toolkit-without-sourcemaps',
  enforce: 'pre',
  async load(id) {
    if (!/\/@cyanheads\/pixoo-toolkit\/dist\/.+\.js$/.test(id)) return null;
    const code = await readFile(id, 'utf8');
    return code.replace(/^\/\/# sourceMappingURL=.*$/m, '');
  },
};

export default mergeConfig(
  coreConfig,
  defineConfig({
    plugins: [pixooToolkitWithoutSourcemaps],
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
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
          },
        },
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
