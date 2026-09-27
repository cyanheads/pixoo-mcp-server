/**
 * @fileoverview The renderer modules a page can load — the `pixoo` page runtime's entry,
 * the text engine, icon drawing, and the icon and theme registries — reach no Node
 * built-in and no `sharp`, checked by
 * bundling them for the browser with `scripts/find-node-imports.ts`. A canary module that
 * does reach Node proves the check reports what it is meant to.
 * @module tests/renderer/browser-safe-imports.test
 */

import { spawnSync } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = 'scripts/find-node-imports.ts';

/** The page runtime's entry and the renderer modules it bundles. */
const BROWSER_SAFE_MODULES = [
  'src/renderer/page-runtime.ts',
  'src/renderer/text-engine.ts',
  'src/renderer/icon-draw.ts',
  'src/renderer/icons.ts',
  'src/renderer/themes.ts',
];

interface NodeImport {
  importer: string;
  specifier: string;
}

/** Run the check under Bun (the bundler it drives) and parse the imports it reports. */
function findNodeImports(entrypoints: string[]): { found: NodeImport[]; status: number | null } {
  const run = spawnSync('bun', ['run', SCRIPT, ...entrypoints], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  return { found: JSON.parse(run.stdout) as NodeImport[], status: run.status };
}

describe('renderer modules a page can load', () => {
  it('reach no Node built-in and no sharp', () => {
    expect(findNodeImports(BROWSER_SAFE_MODULES)).toEqual({ found: [], status: 0 });
  });

  it('the check reports every Node-only import a module reaches, with its importer, and exits 1', async () => {
    // The canary lives outside the project, so it names the toolkit's main barrel by path.
    const toolkitBarrel = createRequire(import.meta.url).resolve('@cyanheads/pixoo-toolkit');
    // Real path: the bundler reports importers with symlinks (macOS /var) resolved.
    const canary = path.join(await realpath(os.tmpdir()), 'canary.ts');
    await writeFile(
      canary,
      [
        `import { loadImage } from ${JSON.stringify(toolkitBarrel)};`,
        `import * as nodePath from 'node:path';`,
        `import * as barePath from 'path';`,
        'export const reach = [loadImage, nodePath.sep, barePath.sep];',
      ].join('\n'),
    );
    const { found, status } = findNodeImports([canary]);
    expect(status).toBe(1);
    const importer = path.relative(PROJECT_ROOT, canary);
    expect(found).toEqual(
      expect.arrayContaining([
        { importer, specifier: 'node:path' },
        { importer, specifier: 'path' },
        {
          importer: expect.stringMatching(/pixoo-toolkit\/dist\/src\/image\.js$/),
          specifier: 'sharp',
        },
      ]),
    );
  });
});
