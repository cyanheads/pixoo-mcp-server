/**
 * @fileoverview Builds the `pixoo` page runtime that `pixoo_render_html` injects into every
 * page. Three steps, each failing the build: typecheck `src/renderer/page-runtime.ts`
 * against the DOM lib (`tsconfig.page-runtime.json`, its own program, so DOM globals stay
 * out of the server's compile); refuse when a Node built-in or `sharp` is reachable from it
 * (`find-node-imports.ts`); bundle it with `Bun.build` as one minified IIFE,
 * `page-runtime.js`. The IIFE exposes no global of its own, so the entry assigns
 * `globalThis.pixoo`. Runs after `scripts/build.ts` in `bun run build` and `bun run rebuild`.
 * @module scripts/build-page-runtime
 *
 * @example
 * // Writes dist/page-runtime.js:
 * // bun run scripts/build-page-runtime.ts
 * // Writes <outdir>/page-runtime.js:
 * // bun run scripts/build-page-runtime.ts <outdir>
 */
import * as path from 'node:path';
import { findNodeImports } from './find-node-imports.ts';

const ROOT = path.join(import.meta.dir, '..');
const ENTRY = path.join(ROOT, 'src/renderer/page-runtime.ts');
const OUTDIR = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist'));
const OUTFILE = 'page-runtime.js';

const tsc = Bun.spawnSync(
  [path.join(ROOT, 'node_modules/.bin/tsc'), '-p', path.join(ROOT, 'tsconfig.page-runtime.json')],
  { stdout: 'inherit', stderr: 'inherit' },
);
if (tsc.exitCode !== 0) {
  console.error('page runtime: typecheck against the DOM lib failed (tsconfig.page-runtime.json).');
  process.exit(1);
}

const nodeImports = await findNodeImports([ENTRY]);
if (nodeImports.length > 0) {
  const lines = nodeImports.map(({ importer, specifier }) => `  ${importer} imports ${specifier}`);
  console.error(
    `page runtime: a page cannot load Node-only code, and the entry reaches:\n${lines.join('\n')}`,
  );
  process.exit(1);
}

await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  naming: OUTFILE,
  target: 'browser',
  format: 'iife',
  minify: true,
});

const bytes = Bun.file(path.join(OUTDIR, OUTFILE)).size;
console.log(
  `page runtime: ${path.relative(ROOT, path.join(OUTDIR, OUTFILE))} (${(bytes / 1024).toFixed(1)} KB)`,
);
