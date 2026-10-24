/**
 * @fileoverview Reads a tool result's `content[]` text back through a real CommonMark
 * parser (`markdown-it`), so a test asserts what a client renders rather than the bytes
 * written. The framework escapes error messages, recovery hints, and trailer values with
 * `escapeMarkdownInline`; the parse undoes exactly those escapes and nothing else.
 * @module tests/helpers/commonmark
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt, { type Token } from 'markdown-it';
import { resultText } from './device-failure.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const parser = new MarkdownIt('commonmark');

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads as: each paragraph's text (line breaks
 * as `\n`), joined by a blank line, with every node that is not plain text named in place
 * (`⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`, `⟨bullet_list_open⟩`), so an expectation
 * written as plain text fails on any live syntax.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}

/** Every text block of a tool result, joined and read back through CommonMark. */
export function resultReadBack(result: ToolResult): string {
  return readCommonMark(resultText(result));
}
