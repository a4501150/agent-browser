/**
 * Bodies derived from playwright-core/src/tools/backend/{console,network}.ts
 * (Apache-2.0, v1.62.1). The 1-based request index is upstream's; a stable
 * request_id is friendlier across calls, so it is `#<n>` here.
 */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { getExtensionForMimeType, isTextualMimeType } from '../vendor/mimeType';
import { isRegexString } from '../vendor/rtti';
import { truncateDataUrl } from '../vendor/stringUtils';

import type * as playwright from 'playwright-core';

const readConsole = defineTabTool({
  schema: {
    name: 'browser_read_console',
    description: 'Return the page\'s console messages and uncaught errors.',
    inputSchema: z.object({
      level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum severity to include; each level also includes the more severe ones. Defaults to info.'),
      all: z.boolean().optional().describe('Include messages from before the last navigation too.'),
      clear: z.boolean().optional().describe('Clear the buffer after reading it.'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const level = params.level ?? 'info';
    const count = await tab.consoleMessageCount(params.all);
    const messages = await tab.consoleMessages(level, params.all);
    const header = [`Total messages: ${count.total} (errors: ${count.errors}, warnings: ${count.warnings})`];
    if (messages.length !== count.total)
      header.push(`Showing ${messages.length} at level "${level}".`);
    await response.addResult('Console', [...header, '', ...messages.map(m => m.toString())].join('\n'), { prefix: 'console', ext: 'log' });
    if (params.clear)
      await tab.clearConsoleMessages();
  },
});

const listRequests = defineTabTool({
  schema: {
    name: 'browser_list_requests',
    description: 'List the network requests made since the page loaded, newest last. Use browser_get_request with a ' +
      'request_id for headers and bodies. Successful static resources are hidden unless resource_type asks for them.',
    inputSchema: z.object({
      url: z.string().optional().refine(v => !v || isRegexString(v), { message: 'Invalid regular expression' }).describe('Only requests whose URL matches this regular expression.'),
      method: z.string().optional().describe('Only requests with this HTTP method.'),
      status: z.number().int().optional().describe('Only requests whose response has this status code.'),
      resource_type: z.string().optional().describe('Only this resource type, e.g. "xhr", "fetch", "document", "script", "image". Naming a type also stops static resources being hidden.'),
      body_contains: z.string().optional().describe('Only requests whose response body contains this string. Fetches bodies, so it is slower.'),
      limit: z.number().int().positive().optional().describe('Return at most this many. Defaults to 100.'),
      offset: z.number().int().nonnegative().optional().describe('Skip this many matches first.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const { requests: all, dropped } = await tab.requests();
    const urlFilter = params.url ? new RegExp(params.url) : undefined;
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const matches: { index: number; request: playwright.Request }[] = [];
    let hiddenStatic = 0;
    for (let i = 0; i < all.length; i++) {
      const request = all[i];
      if (params.resource_type && request.resourceType() !== params.resource_type)
        continue;
      if (params.method && request.method().toUpperCase() !== params.method.toUpperCase())
        continue;
      if (params.status !== undefined && request.existingResponse()?.status() !== params.status)
        continue;
      if (urlFilter) {
        urlFilter.lastIndex = 0;
        if (!urlFilter.test(request.url()))
          continue;
      }
      if (params.body_contains && !await responseBodyContains(request, params.body_contains))
        continue;
      // Counted last, so the number describes what the other filters kept
      // rather than the whole page.
      if (!params.resource_type && !isFetch(request) && isSuccessfulResponse(request)) {
        hiddenStatic++;
        continue;
      }
      matches.push({ index: i + 1, request });
    }

    const page = matches.slice(offset, offset + limit);
    const lines = page.map(m => `#${m.index}. ${renderRequestLine(m.request)}`);
    if (matches.length > page.length)
      lines.push(`\nShowing ${page.length} of ${matches.length} matches (offset ${offset}).`);
    if (hiddenStatic)
      lines.push(`\n${hiddenStatic} successful static request(s) hidden. Pass resource_type to see them.`);
    if (dropped)
      lines.push(`\n${dropped} further request(s) were not recorded; the per-page cap was reached.`);
    if (!lines.length)
      lines.push('No matching requests.');
    await response.addResult('Network', lines.join('\n'), { prefix: 'network', ext: 'log' });
  },
});

const getRequest = defineTabTool({
  schema: {
    name: 'browser_get_request',
    description: 'Return one network request in full: status, timing, request and response headers, and optionally the bodies.',
    inputSchema: z.object({
      request_id: z.string().regex(/^#?[1-9]\d*$/, 'A request id looks like "#3" or "3".').describe('The request id from browser_list_requests, e.g. "#3" or "3".'),
      include_body: z.boolean().optional().describe('Include the request and response bodies. Non-textual bodies are written to a file. Defaults to true.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const index = Number(params.request_id.replace(/^#/, ''));
    const { requests } = await tab.requests();
    const request = requests[index - 1];
    if (!request) {
      response.addError(`Request #${index} not found. Call browser_list_requests for the current ids.`);
      return;
    }

    const lines = renderRequestDetails(index, request);
    if (params.include_body ?? true) {
      const postData = request.postData();
      if (postData !== null)
        lines.push('', '  Request body', indentBlock(postData));

      const httpResponse = request.existingResponse();
      if (canHaveResponseBody(httpResponse)) {
        const contentType = httpResponse.headers()['content-type'] ?? '';
        if (isTextualMimeType(contentType)) {
          const text = await httpResponse.text().catch(() => undefined);
          if (text !== undefined)
            lines.push('', '  Response body', indentBlock(text));
        } else {
          const body = await httpResponse.body().catch(() => undefined);
          if (body?.length) {
            const file = await tab.instance.artifacts.outputFile({ prefix: 'response', ext: getExtensionForMimeType(contentType) });
            await tab.instance.artifacts.write(file, body);
            lines.push('', `  Response body written to ${file} (${body.length} bytes, ${contentType || 'unknown type'})`);
          }
        }
      }
    }
    await response.addResult('Request', lines.join('\n'), { prefix: 'request', ext: 'log' });
  },
});

async function responseBodyContains(request: playwright.Request, needle: string): Promise<boolean> {
  const httpResponse = request.existingResponse();
  if (!canHaveResponseBody(httpResponse))
    return false;
  if (!isTextualMimeType(httpResponse.headers()['content-type'] ?? ''))
    return false;
  const text = await httpResponse.text().catch(() => '');
  return text.includes(needle);
}

function isSuccessfulResponse(request: playwright.Request): boolean {
  if (request.failure())
    return false;
  const response = request.existingResponse();
  return !!response && response.status() < 400;
}

function isFetch(request: playwright.Request): boolean {
  return ['fetch', 'xhr'].includes(request.resourceType());
}

function renderRequestLine(request: playwright.Request): string {
  const response = request.existingResponse();
  let line = `[${request.method().toUpperCase()}] ${truncateDataUrl(request.url())}`;
  if (response)
    line += ` => [${response.status()}] ${response.statusText()}`;
  else if (request.failure())
    line += ` => [FAILED] ${request.failure()?.errorText ?? 'Unknown error'}`;
  return line;
}

function renderRequestDetails(index: number, request: playwright.Request): string[] {
  const httpResponse = request.existingResponse();
  const responseHeaders = httpResponse?.headers();
  const lines: string[] = [`#${index} [${request.method().toUpperCase()}] ${truncateDataUrl(request.url())}`];

  lines.push('', '  General');
  if (httpResponse)
    lines.push(`    status:    [${httpResponse.status()}] ${httpResponse.statusText()}`);
  else if (request.failure())
    lines.push(`    status:    [FAILED] ${request.failure()?.errorText ?? 'Unknown error'}`);
  const timing = request.timing();
  if (timing && timing.responseEnd >= 0)
    lines.push(`    duration:  ${Math.round(timing.responseEnd)}ms`);
  lines.push(`    type:      ${request.resourceType()}`);
  const contentType = responseHeaders?.['content-type'];
  if (contentType)
    lines.push(`    mimeType:  ${contentType.split(';')[0].trim()}`);

  appendHeaderSection(lines, 'Request headers', request.headers());
  if (responseHeaders)
    appendHeaderSection(lines, 'Response headers', responseHeaders);
  return lines;
}

function canHaveResponseBody(httpResponse: playwright.Response | null | undefined): httpResponse is playwright.Response {
  if (!httpResponse)
    return false;
  const status = httpResponse.status();
  // Statuses that cannot carry a body, per RFC 7230.
  return status !== 204 && status !== 304 && !(status >= 100 && status < 200);
}

function appendHeaderSection(lines: string[], title: string, headers: Record<string, string>): void {
  const entries = Object.entries(headers);
  if (!entries.length)
    return;
  lines.push('', `  ${title}`);
  for (const [k, v] of entries)
    lines.push(`    ${k}: ${v}`);
}

function indentBlock(text: string): string {
  return text.split('\n').map(line => '    ' + line).join('\n');
}

export default [readConsole, listRequests, getRequest];
