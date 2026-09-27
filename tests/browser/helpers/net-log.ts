/**
 * @fileoverview Reads the net logs the browser wrapper has Chromium write
 * (`--log-net-log`, capture mode `Everything`). A log is complete JSON only once its
 * browser has exited, so the reader searches the raw text, which also works on a log
 * still being written. Search for a per-run token embedded in every hostname a page
 * tries, so a hit can only come from that page.
 * @module tests/browser/helpers/net-log
 */

import { readFile } from 'node:fs/promises';

/**
 * The raw text of every net log in `files`, joined.
 * @throws When a log is missing or is not a net log, so a check that finds nothing in it
 *   is never vacuous.
 */
export async function readNetLogs(files: string[]): Promise<string> {
  if (files.length === 0) throw new Error('No browser launched, so there is no net log to read.');
  const texts = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, 'utf8').catch((err: unknown) => {
        throw new Error(`The browser wrote no net log at ${file}.`, { cause: err });
      });
      if (!text.startsWith('{"constants":')) {
        throw new Error(`${file} is not a Chromium net log (${text.length} bytes).`);
      }
      return text;
    }),
  );
  return texts.join('\n');
}

/** Every distinct hostname in `text` that contains `token`, lowercased. */
export function hostnamesWith(text: string, token: string): string[] {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(`[a-z0-9-]*${escaped}[a-z0-9.-]*`, 'gi')) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}
