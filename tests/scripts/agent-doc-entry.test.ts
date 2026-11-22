/**
 * @fileoverview The bundle cleaner (`scripts/clean-mcpb.ts`) and the packaging lint's
 * post-bundle check (`scripts/lint-packaging.ts`) select the same agent-doc entries:
 * agent skill trees and `AGENTS.md`/`CLAUDE.md` at an installed package root go, as does
 * a `SKILL.md` anywhere, while a `skills/` directory deeper in a package — the MCP SDK's
 * runtime `dist/ext/skills/` modules — and a scoped package named `skills` stay in the
 * bundle (cyanheads/mcp-ts-core#794, #820). Both scripts are framework copies whose own
 * pair assertion lives in the framework's unpublished suite, so this one runs here.
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import { checkBundleEntries, AGENT_DOC_ENTRY as LINT_ENTRY } from '../../scripts/lint-packaging.js';

/** Entries that stay in the bundle: runtime modules, and agent-doc names below a package root. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/.claude/settings.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
];

/** Agent documentation shipped at a dependency's package root, or a `SKILL.md` anywhere. */
const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/',
  'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/thread-stream/AGENTS.md',
  'node_modules/some-pkg/.agents/skills/x/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/a/SKILL.md',
  'node_modules/outer/node_modules/inner/CLAUDE.md',
  'node_modules/@outer/pkg/node_modules/@inner/pkg/.claude/rules.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('agent-doc entry matcher', () => {
  it('is the same literal in the cleaner and the packaging lint', () => {
    expect(LINT_ENTRY.source).toBe(CLEANER_ENTRY.source);
    expect(LINT_ENTRY.flags).toBe(CLEANER_ENTRY.flags);
  });

  it('keeps nested runtime skills modules, a scoped package named skills, and other runtime files', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
    expect(checkBundleEntries(RUNTIME_ENTRIES, 'bundle')).toEqual([]);
  });

  it('removes agent docs at scoped, unscoped, and nested package roots, each in one class', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
    const errors = checkBundleEntries(AGENT_DOC_ENTRIES, 'bundle');
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
    expect(
      filterAgentDocEntries(['skills/pixoo-guide/SKILL.md', 'CLAUDE.md', 'dist/index.js']),
    ).toEqual([]);
  });
});
