import { collectLinks, parseDocument, readPage } from './markdown';
import { isXmlMimeType } from '../vendor/mimeType';

import type { Link } from './markdown';
import type { ServerHost } from '../mcp/host';
import type { Renderer } from './render';

export type CrawlStrategy = 'bfs' | 'dfs' | 'sitemap' | 'map';

export type CrawlOptions = {
  strategy?: CrawlStrategy;
  maxDepth?: number;
  maxPages?: number;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  signal?: AbortSignal;
};

export type CrawlPage = {
  url: string;
  depth: number;
  status: number | undefined;
  contentType: string | undefined;
  title: string | undefined;
  /** Present unless the strategy is "map", which only collects URLs. */
  markdown?: string;
  links: number;
  error?: string;
};

export type CrawlResult = {
  root: string;
  strategy: CrawlStrategy;
  pages: CrawlPage[];
  discovered: number;
  truncated: boolean;
};

/**
 * A real bounded worker pool. Results are ordered deterministically by
 * discovery order, not by whichever request happened to finish first.
 */
export async function crawl(
  host: ServerHost,
  root: string,
  options: CrawlOptions,
  toMarkdown: (article: { html: string; title: string | undefined }) => string,
): Promise<CrawlResult> {
  const strategy = options.strategy ?? 'bfs';
  const maxDepth = options.maxDepth ?? 2;
  const maxPages = options.maxPages ?? 20;
  // Unbounded on purpose: the renderer's page gate is what keeps this from
  // opening more Chromium pages than the machine has memory for, and it queues
  // rather than refusing, so a high number costs nothing but patience.
  const concurrency = options.concurrency ?? 4;
  const include = (options.include ?? []).map(p => new RegExp(p));
  const exclude = (options.exclude ?? []).map(p => new RegExp(p));

  const rootUrl = new URL(root);
  const allowed = (candidate: string): boolean => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }
    if (url.origin !== rootUrl.origin)
      return false;
    if (exclude.some(re => re.test(candidate)))
      return false;
    if (include.length && !include.some(re => re.test(candidate)))
      return false;
    return true;
  };

  const seen = new Set<string>([normalize(root)]);
  // Ordering discipline: for bfs take from the front, for dfs from the back.
  const frontier: { url: string; depth: number }[] = [{ url: root, depth: 0 }];
  const order: string[] = [];
  const byUrl = new Map<string, CrawlPage>();
  let truncated = false;

  // One lease for the whole crawl, so the shared browser is neither relaunched
  // per page nor idle-closed between them.
  return await host.withRenderer(async renderer => {
    if (strategy === 'sitemap') {
      const urls = await fetchSitemapUrls(renderer, rootUrl, options.signal);
      const kept = urls.filter(allowed);
      return {
        root,
        strategy,
        pages: kept.slice(0, maxPages).map(url => ({ url, depth: 0, status: undefined, contentType: undefined, title: undefined, links: 0 })),
        discovered: kept.length,
        truncated: kept.length > maxPages,
      };
    }

    const visit = async (job: { url: string; depth: number }): Promise<void> => {
      const page: CrawlPage = { url: job.url, depth: job.depth, status: undefined, contentType: undefined, title: undefined, links: 0 };
      byUrl.set(job.url, page);
      try {
        const fetched = await renderer.fetchPage(job.url, { signal: options.signal });
        page.status = fetched.status;
        page.contentType = fetched.contentType;

        // A crawl follows links, and only a document has any. Anything else is
        // recorded as what it was and left alone -- regexing JSON or plain text
        // for URLs would be a different crawler policy.
        if (fetched.kind !== 'html')
          return;

        // One parse per page either way. `readPage` reads the links out before
        // Readability mutates the document; "map" wants neither the article nor
        // the 75-85ms Readability costs to find it.
        let links: Link[];
        if (strategy === 'map') {
          const { document, title } = parseDocument(fetched.html, fetched.url);
          links = collectLinks(document);
          page.title = title;
        } else {
          const read = readPage(fetched.html, fetched.url);
          links = read.links;
          page.title = read.article.title;
          page.markdown = toMarkdown(read.article);
        }
        page.links = links.length;

        if (job.depth < maxDepth) {
          for (const link of links) {
            const key = normalize(link.url);
            if (seen.has(key) || !allowed(link.url))
              continue;
            seen.add(key);
            frontier.push({ url: link.url, depth: job.depth + 1 });
          }
        }
      } catch (e) {
        page.error = e instanceof Error ? e.message : String(e);
      }
    };

    let started = 0;
    const inFlight = new Set<Promise<void>>();

    const startNext = (): boolean => {
      if (options.signal?.aborted)
        return false;
      if (started >= maxPages) {
        truncated = truncated || frontier.length > 0;
        return false;
      }
      const job = strategy === 'dfs' ? frontier.pop() : frontier.shift();
      if (!job)
        return false;
      started++;
      order.push(job.url);
      const promise = visit(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
      return true;
    };

    while (started < maxPages && (frontier.length || inFlight.size)) {
      while (inFlight.size < concurrency && startNext()) {
        // Fill the pool.
      }
      if (!inFlight.size)
        break;
      await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    if (frontier.length)
      truncated = true;

    return {
      root,
      strategy,
      pages: order.map(url => byUrl.get(url)!).filter(Boolean),
      discovered: seen.size,
      truncated,
    };
  });
}

function normalize(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // A trailing slash on a directory is the same page.
    if (parsed.pathname.endsWith('/') && parsed.pathname !== '/')
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

async function fetchSitemapUrls(renderer: Renderer, root: URL, signal: AbortSignal | undefined): Promise<string[]> {
  const candidates = [new URL('/sitemap.xml', root).toString(), new URL('/sitemap_index.xml', root).toString()];
  const collected: string[] = [];
  const visited = new Set<string>();

  const load = async (url: string, depth: number): Promise<void> => {
    if (depth > 2 || visited.has(url))
      return;
    // A sitemap index names its own children, and this crawl promised to stay
    // on one origin -- otherwise a public index could point us at an internal
    // endpoint and we would fetch it as though the caller had asked.
    if (depth > 0 && new URL(url).origin !== root.origin)
      return;
    visited.add(url);
    // A site with no sitemap answers 404 with a normal document, so nothing
    // here needs catching: a timeout, a crash or a refusal is worth reporting
    // rather than reading as "no sitemap".
    const fetched = await renderer.fetchPage(url, { signal });
    if (fetched.kind !== 'text' || (fetched.status ?? 0) >= 400)
      return;
    if (!isXmlMimeType(fetched.contentType ?? ''))
      return;
    const xml = fetched.text;
    const isIndex = /<sitemapindex/i.test(xml);
    for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const found = match[1].replace(/&amp;/g, '&');
      if (isIndex)
        await load(found, depth + 1);
      else
        collected.push(found);
    }
  };


  for (const candidate of candidates) {
    await load(candidate, 0);
    if (collected.length)
      break;
  }
  return [...new Set(collected)];
}
