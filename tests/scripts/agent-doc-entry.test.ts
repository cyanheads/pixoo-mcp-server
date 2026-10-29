/**
 * @fileoverview The bundle cleaner (`scripts/clean-mcpb.ts`) and the packaging lint's
 * post-bundle check (`scripts/lint-packaging.ts`) select the same agent-doc entries:
 * agent skill trees at an installed package root go, while a `skills/` directory deeper
 * in a package — the MCP SDK's runtime `dist/ext/skills/` modules — stays in the bundle
 * (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: a static import would pull the script into the test
 * typecheck, where its fallback `import('../src/mcp-server/skills.js')` does not
 * resolve (cyanheads/mcp-ts-core#797).
 */
const lintPackaging = (await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
)) as LintPackagingModule;

/** Runtime modules that a skills-serving bundle loads at startup. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/.claude/settings.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
];

/** Agent documentation shipped at a dependency's package root. */
const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/x/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/a/SKILL.md',
  'node_modules/@outer/pkg/node_modules/@inner/pkg/.claude/rules.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('agent-doc entry matcher', () => {
  it('is the same literal in the cleaner and the packaging lint', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(CLEANER_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(CLEANER_ENTRY.flags);
  });

  it('keeps nested runtime skills modules and other runtime files', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
    expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'bundle')).toEqual([]);
  });

  it('removes agent docs at scoped, unscoped, and nested package roots', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
    const errors = lintPackaging.checkBundleEntries(AGENT_DOC_ENTRIES, 'bundle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      `contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`,
    );
  });

  it('selects only the agent docs from a mixed listing', () => {
    expect(filterAgentDocEntries([...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES])).toEqual(
      AGENT_DOC_ENTRIES,
    );
  });

  it('leaves the server’s own root files alone', () => {
    expect(filterAgentDocEntries(['skills/pixoo-guide/SKILL.md', 'dist/index.js'])).toEqual([]);
  });
});
