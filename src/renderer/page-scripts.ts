/**
 * @fileoverview The scripts `pixoo_render_html` injects ahead of a page's own: the virtual
 * clock, the panel size, and the `pixoo` page runtime bundle that
 * `scripts/build-page-runtime.ts` writes to `dist/page-runtime.js`.
 * @module renderer/page-scripts
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';
import { VIRTUAL_CLOCK_SOURCE } from './virtual-clock.js';

/**
 * The runtime bundle, `dist/page-runtime.js` at the package root. The relative path holds
 * from `src/renderer/` and from the compiled `dist/renderer/`, which sit at the same depth.
 */
export const PAGE_RUNTIME_URL = new URL('../../dist/page-runtime.js', import.meta.url);

/**
 * A reader for the runtime bundle at `file`: it reads the file on first use and returns
 * that text from then on. A failed read is not kept, so the next call reads again.
 * @throws {McpError} ConfigurationError when the file does not exist.
 */
export function pageRuntimeReader(file: URL): () => Promise<string> {
  let source: string | undefined;
  return async () => {
    source ??= await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      throw configurationError(
        `The pixoo page runtime bundle ${fileURLToPath(file)} does not exist. \`bun run build\` writes it: build the server, or reinstall the package.`,
      );
    });
    return source;
  };
}

/** The runtime bundle `pixoo_render_html` injects, read on its first render. */
export const pageRuntime = pageRuntimeReader(PAGE_RUNTIME_URL);

/**
 * Every script a render injects, in order: the virtual clock, the panel size, then the
 * runtime, which reads the size once as it loads and refuses to load without it.
 */
export function pageScripts(size: number, runtime: string): string[] {
  return [VIRTUAL_CLOCK_SOURCE, `globalThis.__PIXOO_SIZE__ = ${size};`, runtime];
}
