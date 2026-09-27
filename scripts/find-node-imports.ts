/**
 * @fileoverview Bundles entry points for the browser and reports every Node-only import
 * reachable from them — a Node built-in (`node:fs`, `path`, …) or `sharp` — with the
 * module that imports it. Code that must run in a page (the `pixoo` runtime) passes only
 * when the list is empty. The bundler walks the real import graph, package `exports` maps
 * included, and drops type-only imports, so a hit is an import a browser bundle would
 * have to carry. Each hit is marked external, so one run reports all of them.
 * @module scripts/find-node-imports
 *
 * @example
 * // Prints the hits as JSON; exits 1 when there are any:
 * // bun run scripts/find-node-imports.ts src/renderer/text-engine.ts src/renderer/icon-draw.ts
 */
import { isBuiltin } from 'node:module';
import * as path from 'node:path';

/** Packages that load native Node code and can never reach a browser bundle. */
const NODE_ONLY_PACKAGES = ['sharp'];

/** One Node-only import: what was imported, and the module (relative to cwd) importing it. */
export interface NodeImport {
  importer: string;
  specifier: string;
}

/** The package a bare specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

function isNodeOnly(specifier: string): boolean {
  return isBuiltin(specifier) || NODE_ONLY_PACKAGES.includes(packageOf(specifier));
}

/**
 * Bundle `entrypoints` for the browser (in memory; nothing is written) and return every
 * Node-only import reachable from them, in the order the bundler met them.
 * Throws the bundler's `AggregateError` when the build fails for another reason.
 */
export async function findNodeImports(entrypoints: string[]): Promise<NodeImport[]> {
  const found: NodeImport[] = [];
  await Bun.build({
    entrypoints,
    target: 'browser',
    plugins: [
      {
        name: 'find-node-imports',
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path: specifier, importer }) => {
            if (!isNodeOnly(specifier)) return;
            found.push({ importer: path.relative(process.cwd(), importer), specifier });
            return { path: specifier, external: true };
          });
        },
      },
    ],
  });
  return found;
}

if (import.meta.main) {
  const found = await findNodeImports(process.argv.slice(2));
  console.log(JSON.stringify(found, null, 2));
  process.exitCode = found.length > 0 ? 1 : 0;
}
