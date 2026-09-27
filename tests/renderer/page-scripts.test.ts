/**
 * @fileoverview Tests for the scripts `pixoo_render_html` injects: the order of the
 * virtual clock, the panel size, and the `pixoo` runtime; where the runtime bundle is
 * read from; and the reader that reads it once and fails loudly when it is missing.
 * @module tests/renderer/page-scripts.test
 */

import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vm from 'node:vm';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { PAGE_RUNTIME_URL, pageRuntimeReader, pageScripts } from '@/renderer/page-scripts.js';
import { VIRTUAL_CLOCK_SOURCE } from '@/renderer/virtual-clock.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('pageScripts', () => {
  it.each([64, 32, 16])(
    'size %i: the virtual clock, then the size, then the runtime that reads it',
    (size) => {
      expect(pageScripts(size, '/* runtime */')).toEqual([
        VIRTUAL_CLOCK_SOURCE,
        `globalThis.__PIXOO_SIZE__ = ${size};`,
        '/* runtime */',
      ]);
    },
  );

  it('the size script sets the global the runtime reads', () => {
    const [, sizeScript] = pageScripts(32, '');
    const page = vm.createContext({});
    vm.runInContext(sizeScript ?? '', page);
    expect(vm.runInContext('globalThis.__PIXOO_SIZE__', page)).toBe(32);
  });
});

describe('PAGE_RUNTIME_URL', () => {
  it('names dist/page-runtime.js at the package root, where the bundle build writes it', () => {
    expect(fileURLToPath(PAGE_RUNTIME_URL)).toBe(
      path.join(PROJECT_ROOT, 'dist', 'page-runtime.js'),
    );
  });
});

describe('pageRuntimeReader', () => {
  const bundleFile = (name: string) => pathToFileURL(path.join(os.tmpdir(), name));

  it('reads the bundle on first use and returns that text from then on', async () => {
    const file = bundleFile('runtime-once.js');
    await writeFile(file, 'globalThis.pixoo = 1;');
    const read = pageRuntimeReader(file);

    expect(await read()).toBe('globalThis.pixoo = 1;');
    await writeFile(file, 'globalThis.pixoo = 2;');
    expect(await read()).toBe('globalThis.pixoo = 1;');
  });

  it('a missing bundle fails ConfigurationError naming the path and the build; the next call reads again', async () => {
    const file = bundleFile('runtime-missing.js');
    const read = pageRuntimeReader(file);

    const failure = await read().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: `The pixoo page runtime bundle ${fileURLToPath(file)} does not exist. \`bun run build\` writes it: build the server, or reinstall the package.`,
    });

    await writeFile(file, 'globalThis.pixoo = 3;');
    expect(await read()).toBe('globalThis.pixoo = 3;');
  });

  it('a read that fails for another reason passes through unchanged', async () => {
    // A directory where the bundle should be: EISDIR, not ENOENT.
    const read = pageRuntimeReader(pathToFileURL(os.tmpdir()));
    await expect(read()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
