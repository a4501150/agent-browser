import * as z from 'zod';

import { defineGlobalTool } from '../mcp/tool';
import { crawl } from '../web/crawler';
import { extract } from '../web/extract';
import { htmlToMarkdown, readPage } from '../web/markdown';
import { fetchPage, printPdf } from '../web/render';
import { getExtensionForMimeType } from '../vendor/mimeType';
import { search } from '../web/search';

const webSearch = defineGlobalTool({
  schema: {
    name: 'web_search',
    description: 'Search DuckDuckGo and return organic results with titles, URLs and snippets. Sponsored results are ' +
      'filtered out. No instance_id is needed.',
    inputSchema: z.object({
      query: z.string().min(2).describe('What to search for.'),
      count: z.number().int().positive().optional().describe('How many results to return. Defaults to 10. More than the engine will give ends the search early rather than failing.'),
      region: z.string().optional().describe('Region and language, e.g. "us-en", "uk-en", "de-de".'),
      time_range: z.enum(['d', 'w', 'm', 'y']).optional().describe('Restrict to the past day, week, month or year.'),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    const { results, batches } = await search(host, params.query, {
      count: params.count,
      region: params.region,
      timeRange: params.time_range,
      signal,
    });
    if (!results.length) {
      response.addTextResult(`No results for "${params.query}".`);
      return;
    }
    const lines = results.map(r => `${r.position}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
    response.addTextResult([`${results.length} result(s) for "${params.query}" (${batches} batch(es) loaded):`, '', ...lines].join('\n'));
  },
});

const webFetch = defineGlobalTool({
  schema: {
    name: 'web_fetch',
    description: 'Fetch one URL with a real browser and return it as a self-contained markdown document, the rendered ' +
      'HTML, the raw response body, or a print-to-PDF. No instance_id is needed; for a page you have already ' +
      'interacted with or logged into, use browser_read_page instead, since this refetches the URL cold.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch.'),
      format: z.enum(['markdown', 'html', 'raw', 'pdf']).optional().describe('"markdown" (default) is the article as one self-contained document. "html" is the DOM after scripts have run, "raw" the bytes the server sent before them, "pdf" prints the page. Anything that is not a web page comes back as itself whatever you ask for.'),
      extract_links: z.boolean().optional().describe('Also list the absolute links found on the page.'),
      timeout: z.number().int().positive().optional().describe('Milliseconds to allow for the fetch. Defaults to 30000.'),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    const format = params.format ?? 'markdown';

    if (format === 'pdf') {
      const printed = await printPdf(host, params.url, { timeoutMs: params.timeout, signal });
      const file = await host.artifacts.outputFile({ prefix: 'page', ext: 'pdf' });
      await response.addFileResult(`PDF of ${params.url}`, file, printed.data);
      response.addTextResult(`Rendered ${printed.url} to PDF (${printed.data.length} bytes).`);
      return;
    }

    const page = await fetchPage(host, params.url, { timeoutMs: params.timeout, signal, raw: format === 'raw' });
    const facts = [
      `- URL: ${page.url}`,
      page.status !== undefined ? `- Status: ${page.status}` : undefined,
      page.contentType ? `- Content type: ${page.contentType}` : undefined,
    ];

    if (page.kind === 'binary') {
      const file = await host.artifacts.outputFile({
        prefix: 'fetch',
        ext: getExtensionForMimeType(page.contentType),
        suggestedFilename: page.filename,
      });
      await response.addFileResult(`${page.bytes.length} bytes from ${page.url}`, file, page.bytes);
      response.addTextResult(facts.filter(Boolean).join('\n'));
      return;
    }

    // Either not a web page at all, or the raw source of one. Nothing to
    // isolate an article from, so it comes back as itself.
    if (page.kind === 'text') {
      response.addTextResult(facts.filter(Boolean).join('\n'));
      await response.addResult(`Content of ${page.url}`, page.text, {
        prefix: 'fetch',
        ext: getExtensionForMimeType(page.contentType),
      });
      return;
    }

    if (format === 'html') {
      response.addTextResult(facts.filter(Boolean).join('\n'));
      await response.addResult(`Content of ${page.url}`, page.html, { prefix: 'fetch', ext: 'html' });
      return;
    }

    // One document, so a result that spills to a file still says where it came
    // from and what it is.
    // One parse for the article and the links both.
    const { article, links } = readPage(page.html, page.url);
    if (article.byline)
      facts.push(`- Byline: ${article.byline}`);
    if (article.wholeDocument)
      facts.push('- Note: no article could be isolated, so this is the whole page.');

    const sections = [
      article.title ? `# ${article.title}` : undefined,
      facts.filter(Boolean).join('\n'),
      '---',
      htmlToMarkdown(article.html),
    ].filter(Boolean) as string[];

    if (params.extract_links)
      sections.push(`## Links\n\n${links.map(l => `- [${l.text || l.url}](${l.url})`).join('\n')}`);

    await response.addResult(`Content of ${page.url}`, sections.join('\n\n'), { prefix: 'fetch', ext: 'md' });
  },
});

const webCrawl = defineGlobalTool({
  schema: {
    name: 'web_crawl',
    description: 'Walk a site with a real browser from one URL, staying on the same origin, and return each page as ' +
      'markdown. robots.txt is not consulted. Use "map" to collect URLs and titles only, which is much cheaper.',
    inputSchema: z.object({
      url: z.string().describe('Where to start.'),
      strategy: z.enum(['bfs', 'dfs', 'sitemap', 'map']).optional().describe('"bfs" (default) goes level by level, "dfs" follows one branch down, "sitemap" reads /sitemap.xml instead of crawling, "map" crawls but returns only URLs and titles.'),
      max_depth: z.number().int().nonnegative().optional().describe('How many links deep to follow. Defaults to 2.'),
      max_pages: z.number().int().positive().optional().describe('Stop after this many pages. Defaults to 20.'),
      include: z.array(z.string()).optional().describe('Only follow URLs matching one of these regular expressions.'),
      exclude: z.array(z.string()).optional().describe('Never follow URLs matching any of these regular expressions.'),
      concurrency: z.number().int().positive().optional().describe('How many pages to fetch at once. Defaults to 4.'),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    const result = await crawl(host, params.url, {
      strategy: params.strategy,
      maxDepth: params.max_depth,
      maxPages: params.max_pages,
      include: params.include,
      exclude: params.exclude,
      concurrency: params.concurrency,
      signal,
    }, article => htmlToMarkdown(article.html));

    const summary = [
      `- Root: ${result.root}`,
      `- Strategy: ${result.strategy}`,
      `- Pages fetched: ${result.pages.length}`,
      `- URLs discovered: ${result.discovered}`,
      result.truncated ? '- Stopped at a limit; more pages remain.' : undefined,
    ].filter(Boolean) as string[];
    response.addTextResult(summary.join('\n'));

    const sections = result.pages.map(page => {
      const head = `## ${page.title || page.url}\n\n- URL: ${page.url}\n- Depth: ${page.depth}` +
        (page.status !== undefined ? `\n- HTTP status: ${page.status}` : '') +
        (page.contentType ? `\n- Content type: ${page.contentType}` : '') +
        (page.error ? `\n- Error: ${page.error}` : '') +
        `\n- Links found: ${page.links}`;
      return page.markdown ? `${head}\n\n${page.markdown}` : head;
    });
    await response.addResult(`Crawl of ${result.root}`, sections.join('\n\n---\n\n'), { prefix: 'crawl', ext: 'md' });
  },
});

const webExtract = defineGlobalTool({
  schema: {
    name: 'web_extract',
    description: 'Pull structured data out of a page: elements matching a selector, tables as records, page metadata, ' +
      'or JSON-LD and microdata. Deterministic, with no model in the loop. Pass either url or html.',
    inputSchema: z.object({
      url: z.string().optional().describe('Page to fetch and extract from.'),
      html: z.string().optional().describe('HTML to extract from, instead of fetching a URL.'),
      mode: z.enum(['selector', 'tables', 'metadata', 'structured']).describe('What to extract. "structured" reads JSON-LD and microdata.'),
      selector: z.string().describe('CSS selector, required for mode "selector".').optional(),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    if (!!params.url === !!params.html)
      throw new Error('Provide exactly one of "url" or "html".');

    let html: string;
    let url: string;
    let source: Record<string, unknown>;
    if (params.html) {
      html = params.html;
      url = 'about:blank';
      source = { source: 'supplied html' };
    } else {
      const page = await fetchPage(host, params.url!, { signal });
      if (page.kind !== 'html')
        throw new Error(`Cannot extract HTML from ${page.url}: the response content type is ${page.contentType ?? 'unknown'}.`);
      html = page.html;
      url = page.url;
      source = {
        source: page.url,
        http_status: page.status,
        content_type: page.contentType,
      };
    }

    // Provenance goes *inside* the JSON, not in a line above it, so the whole
    // result parses as one object.
    const extracted = { mode: params.mode, ...source, ...extract(html, url, params.mode, params.selector) };
    await response.addResult(`Extracted ${params.mode}`, JSON.stringify(extracted, null, 2), { prefix: 'extract', ext: 'json' });
  },
});

export default [webSearch, webFetch, webCrawl, webExtract];
