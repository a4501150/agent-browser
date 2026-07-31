/**
 * Bodies derived from playwright-core/src/tools/backend/{snapshot,find,screenshot}.ts
 * (Apache-2.0, v1.62.1). Upstream's screenshot image-rescaling path is dropped.
 */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { captureAriaSnapshot } from '../browser/snapshot';
import { formatObject } from '../vendor/stringUtils';

import type * as playwright from 'playwright-core';

const targetDescription =
  'A ref from the page outline (e.g. "e12", or "f1e3" for an element inside an iframe), ' +
  'or a CSS selector, or an XPath (detected by a leading "/").';

export const elementSchema = z.object({
  target: z.string().describe(targetDescription),
  element: z.string().optional().describe('Short human-readable description of the element, used in error messages.'),
});

const readPage = defineTabTool({
  schema: {
    name: 'browser_read_page',
    title: 'Read the page',
    description: 'Return the page as an accessibility outline with [ref=eN] handles that every action tool accepts. ' +
      'This is the primary way to perceive a page: it is 10-50x smaller than the HTML and it recurses into iframes, ' +
      'including cross-origin ones, whose refs come back frame-prefixed (f1e3). Prefer this over a screenshot.',
    inputSchema: z.object({
      target: z.string().optional().describe(`Read only this element's subtree. ${targetDescription}`),
      depth: z.number().int().positive().optional().describe('Limit how deep the outline goes.'),
      full: z.boolean().optional().describe('Write the complete outline to a file and return its path instead of inlining it. Use for very large pages, or to search the outline with other tools.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    let root: playwright.Locator | undefined;
    if (params.target)
      root = (await tab.targetLocator({ target: params.target })).locator;
    response.setIncludeExplicitSnapshot({ root, depth: params.depth, toFile: params.full });
  },
});

// Number of context lines shown around each match, like `grep -C`.
const contextLines = 3;

const find = defineTabTool({
  schema: {
    name: 'browser_find',
    title: 'Find in the page outline',
    description: 'Search the page\'s accessibility outline and return the matching nodes with their refs and a few lines ' +
      'of surrounding context, each shown under its path from the root. Cheaper than reading the whole page when you ' +
      'only need to locate one element.',
    inputSchema: z.object({
      text: z.string().optional().describe('Case-insensitive substring to look for in the outline (matches accessible names and text).'),
      role: z.string().optional().describe('Only match nodes of this accessibility role, e.g. "button", "textbox", "link".'),
      limit: z.number().int().positive().optional().describe('Stop after this many matches. Defaults to 50.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (!params.text && !params.role) {
      response.addError('Provide "text", "role", or both.');
      return;
    }

    const snapshot = await captureAriaSnapshot(tab.page);
    const lines = snapshot.split('\n');
    const indents = lines.map(indentOf);

    const needle = params.text?.toLowerCase();
    const role = params.role?.toLowerCase();
    const matched: number[] = [];
    const limit = params.limit ?? 50;
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      if (needle && !lines[i].toLowerCase().includes(needle))
        continue;
      if (role && roleOf(lines[i]) !== role)
        continue;
      if (matched.length >= limit) {
        truncated = true;
        break;
      }
      matched.push(i);
    }

    const query = [params.role ? `role "${params.role}"` : '', params.text ? `text "${params.text}"` : ''].filter(Boolean).join(' and ');
    if (!matched.length) {
      response.addTextResult(`No matches found for ${query}.`);
      return;
    }

    // Coalesce overlapping context windows.
    const windows: { start: number; end: number }[] = [];
    for (const line of matched) {
      const start = Math.max(0, line - contextLines);
      const end = Math.min(lines.length - 1, line + contextLines);
      const last = windows[windows.length - 1];
      if (last && start <= last.end + 1)
        last.end = Math.max(last.end, end);
      else
        windows.push({ start, end });
    }

    const onPath = new Set<number>();
    for (const match of matched) {
      onPath.add(match);
      for (const ancestor of ancestorIndices(lines, indents, match))
        onPath.add(ancestor);
    }

    const snippets = windows.map(window => {
      const indices = ancestorIndices(lines, indents, window.start);
      for (let i = window.start; i <= window.end; i++)
        indices.push(i);
      const out: string[] = [];
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (i > 0 && index > indices[i - 1] + 1 && !onPath.has(index) && !onPath.has(indices[i - 1]))
          out.push(' '.repeat(indents[index]) + '...');
        out.push(lines[index]);
      }
      return out.join('\n');
    });

    const word = matched.length === 1 ? 'match' : 'matches';
    const note = truncated ? ` (stopped at the limit of ${limit})` : '';
    response.addTextResult(`Found ${matched.length} ${word} for ${query}${note}:\n\n${snippets.join('\n\n----\n\n')}`);
  },
});

const screenshot = defineTabTool({
  schema: {
    name: 'browser_screenshot',
    title: 'Take a screenshot',
    description: 'Capture a PNG or JPEG of the page or one element. You cannot act on coordinates read off a screenshot ' +
      'reliably; use browser_read_page and refs for that.',
    inputSchema: z.object({
      target: z.string().optional().describe(`Screenshot only this element. ${targetDescription}`),
      element: z.string().optional().describe('Short human-readable description of the element, used in error messages.'),
      format: z.enum(['png', 'jpeg']).optional().describe('Image format. Defaults to png.'),
      full_page: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Cannot be combined with target.'),
      quality: z.number().int().min(0).max(100).optional().describe('JPEG quality, 0-100. Ignored for png. Defaults to 90.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (params.full_page && params.target)
      throw new Error('full_page cannot be combined with target.');

    const format = params.format ?? 'png';
    const options: playwright.PageScreenshotOptions = {
      type: format,
      quality: format === 'jpeg' ? (params.quality ?? 90) : undefined,
      // CSS pixels, so the result is sized the way the page is laid out and
      // stays consistent regardless of devicePixelRatio.
      scale: 'css',
      ...tab.actionTimeoutOptions,
      ...(params.full_page !== undefined && { fullPage: params.full_page }),
    };

    const label = params.target ? params.element || 'element' : (params.full_page ? 'full page' : 'viewport');
    const target = params.target ? await tab.targetLocator({ element: params.element, target: params.target }) : null;
    const data = target ? await target.locator.screenshot(options) : await tab.page.screenshot(options);

    const file = await tab.instance.artifacts.outputFile({ prefix: target ? 'element' : 'page', ext: format });
    response.addCode(`// Screenshot ${label}`);
    response.addCode(target
      ? `await page.${target.resolved}.screenshot(${formatObject({ ...options, path: file })});`
      : `await page.screenshot(${formatObject({ ...options, path: file })});`);
    await response.addFileResult(`Screenshot of ${label}`, file, data);
    response.addImage(data, format);
  },
});

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Outline lines read `- button "Save" [ref=e7]`. */
function roleOf(line: string): string | undefined {
  return /^\s*-\s+([a-zA-Z]+)/.exec(line)?.[1].toLowerCase();
}

function ancestorIndices(lines: string[], indents: number[], index: number): number[] {
  const result: number[] = [];
  let indent = indents[index];
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    if (!lines[i].trim())
      continue;
    if (indents[i] < indent) {
      result.push(i);
      indent = indents[i];
    }
  }
  return result.reverse();
}

export default [readPage, find, screenshot];
