import * as z from 'zod';

import { defineGlobalTool } from '../mcp/tool';
import { crawl } from '../web/crawler';
import { extract } from '../web/extract';
import { extractArticle, extractLinks, htmlToMarkdown } from '../web/markdown';
import { fetchPage, Renderer } from '../web/render';
import { search } from '../web/search';

const webSearch = defineGlobalTool({
  schema: {
    name: 'web_search',
    description: 'Search DuckDuckGo and return organic results with titles, URLs and snippets. Sponsored results are ' +
      'filtered out. No browser instance is needed.',
    inputSchema: z.object({
      query: z.string().min(2).describe('What to search for.'),
      count: z.number().int().positive().max(100).optional().describe('How many results to return. Defaults to 10.'),
      region: z.string().optional().describe('Region and language, e.g. "us-en", "uk-en", "de-de".'),
      time_range: z.enum(['d', 'w', 'm', 'y']).optional().describe('Restrict to the past day, week, month or year.'),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    const { results, pages } = await search(host, params.query, {
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
    response.addTextResult([`${results.length} result(s) for "${params.query}" (${pages} page(s) of results):`, '', ...lines].join('\n'));
  },
});

const webFetch = defineGlobalTool({
  schema: {
    name: 'web_fetch',
    description: 'Fetch one URL and return it as markdown, plain text, raw HTML or a PDF. Tries a plain HTTP request ' +
      'first and escalates to a real browser when the response looks like a bot challenge or renders client-side. ' +
      'No browser instance is needed; for a page you have already interacted with or logged into, use ' +
      'browser_read_page instead, since this refetches the URL cold.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch.'),
      format: z.enum(['markdown', 'text', 'html', 'pdf']).optional().describe('Output format. Defaults to markdown.'),
      render: z.enum(['auto', 'always', 'never']).optional().describe('Whether to use a real browser. "auto" escalates only when the plain response looks incomplete or challenged. Defaults to auto.'),
      extract_links: z.boolean().optional().describe('Also list the absolute links found on the page.'),
      timeout: z.number().int().positive().optional().describe('Milliseconds to allow for the fetch. Defaults to 30000.'),
    }),
    type: 'readOnly',
  },

  handle: async (host, params, response, signal) => {
    const format = params.format ?? 'markdown';

    if (format === 'pdf') {
      // Print-to-PDF only exists in the browser.
      const renderer = await Renderer.create(host);
      try {
        const printed = await renderer.pdf(params.url, { timeoutMs: params.timeout, signal });
        const file = await host.artifacts.outputFile({ prefix: 'page', ext: 'pdf' });
        await response.addFileResult(`PDF of ${params.url}`, file, printed.data);
        response.addTextResult(`Rendered ${printed.url} to PDF (${printed.data.length} bytes).`);
      } finally {
        await renderer.close();
      }
      return;
    }

    const page = await fetchPage(host, params.url, { render: params.render, timeoutMs: params.timeout, signal });
    const header = [
      `- URL: ${page.url}`,
      page.status !== undefined ? `- HTTP status: ${page.status}` : undefined,
      `- Fetched with: ${page.rendered ? 'a real browser' : 'a plain HTTP request'}${page.renderReason ? ` (${page.renderReason})` : ''}`,
    ].filter(Boolean) as string[];

    let body: string;
    if (format === 'html') {
      body = page.html;
    } else {
      const article = extractArticle(page.html, page.url);
      if (article.title)
        header.push(`- Title: ${article.title}`);
      if (article.byline)
        header.push(`- Byline: ${article.byline}`);
      if (article.wholeDocument)
        header.push('- Note: no article could be isolated, so this is the whole page.');
      body = format === 'text' ? article.text : htmlToMarkdown(article.html);
    }

    if (params.extract_links) {
      const links = extractLinks(page.html, page.url);
      header.push(`- Links: ${links.length}`);
      body += `\n\n## Links\n\n${links.map(l => `- [${l.text || l.url}](${l.url})`).join('\n')}`;
    }

    response.addTextResult(header.join('\n'));
    await response.addResult(`Content of ${page.url}`, body, {
      prefix: 'fetch',
      ext: format === 'html' ? 'html' : format === 'text' ? 'txt' : 'md',
    });
  },
});

const webCrawl = defineGlobalTool({
  schema: {
    name: 'web_crawl',
    description: 'Walk a site from one URL, staying on the same origin, and return each page as markdown. ' +
      'robots.txt is not consulted. Use "map" to collect URLs and titles only, which is much cheaper.',
    inputSchema: z.object({
      url: z.string().describe('Where to start.'),
      strategy: z.enum(['bfs', 'dfs', 'sitemap', 'map']).optional().describe('"bfs" (default) goes level by level, "dfs" follows one branch down, "sitemap" reads /sitemap.xml instead of crawling, "map" crawls but returns only URLs and titles.'),
      max_depth: z.number().int().nonnegative().optional().describe('How many links deep to follow. Defaults to 2.'),
      max_pages: z.number().int().positive().max(500).optional().describe('Stop after this many pages. Defaults to 20.'),
      include: z.array(z.string()).optional().describe('Only follow URLs matching one of these regular expressions.'),
      exclude: z.array(z.string()).optional().describe('Never follow URLs matching any of these regular expressions.'),
      concurrency: z.number().int().positive().max(16).optional().describe('How many pages to fetch at once. Defaults to 4.'),
      render: z.enum(['auto', 'always', 'never']).optional().describe('Whether to use a real browser per page. Defaults to never, since crawling with a browser is far slower.'),
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
      render: params.render,
      signal,
    }, (html, url) => {
      const article = extractArticle(html, url);
      return { title: article.title, markdown: htmlToMarkdown(article.html) };
    });

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
        (page.rendered ? '\n- Fetched with a real browser' : '') +
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
      render: z.enum(['auto', 'always', 'never']).optional().describe('Whether to use a real browser when fetching a url. Defaults to auto.'),
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
      const page = await fetchPage(host, params.url!, { render: params.render, signal });
      html = page.html;
      url = page.url;
      source = {
        source: page.url,
        http_status: page.status,
        fetched_with: page.rendered ? 'a real browser' : 'a plain HTTP request',
      };
    }

    // Provenance goes *inside* the JSON, not in a line above it, so the whole
    // result parses as one object.
    const extracted = { mode: params.mode, ...source, ...extract(html, url, params.mode, params.selector) };
    await response.addResult(`Extracted ${params.mode}`, JSON.stringify(extracted, null, 2), { prefix: 'extract', ext: 'json' });
  },
});

export default [webSearch, webFetch, webCrawl, webExtract];
