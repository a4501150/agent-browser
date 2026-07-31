import { httpFetch, decodeBody } from './httpFetch';
import { extractLinks, parseDocument } from './markdown';
import { fetchPage, withRenderer } from './render';

import type { ServerHost } from '../mcp/host';
import type { RenderMode } from './render';

export type CrawlStrategy = 'bfs' | 'dfs' | 'sitemap' | 'map';

/** Cap on URLs remembered, independent of how many pages are fetched. */
const maxDiscovered = 10_000;

export type CrawlOptions = {
  strategy?: CrawlStrategy;
  maxDepth?: number;
  maxPages?: number;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  render?: RenderMode;
  signal?: AbortSignal;
};

export type CrawlPage = {
  url: string;
  depth: number;
  status: number | undefined;
  title: string | undefined;
  /** Present unless the strategy is "map", which only collects URLs. */
  markdown?: string;
  links: number;
  rendered?: boolean;
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
  toMarkdown: (html: string, url: string) => { title: string | undefined; markdown: string },
): Promise<CrawlResult> {
  const strategy = options.strategy ?? 'bfs';
  const maxDepth = options.maxDepth ?? 2;
  const maxPages = options.maxPages ?? 20;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
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

  if (strategy === 'sitemap') {
    const urls = await fetchSitemapUrls(rootUrl, options.signal);
    const kept = urls.filter(allowed);
    return {
      root,
      strategy,
      pages: kept.slice(0, maxPages).map(url => ({ url, depth: 0, status: undefined, title: undefined, links: 0 })),
      discovered: kept.length,
      truncated: kept.length > maxPages,
    };
  }

  const seen = new Set<string>([normalize(root)]);
  // Ordering discipline: for bfs take from the front, for dfs from the back.
  const frontier: { url: string; depth: number }[] = [{ url: root, depth: 0 }];
  const order: string[] = [];
  const byUrl = new Map<string, CrawlPage>();
  let truncated = false;

  return await withRenderer(host, async getRenderer => {
    const visit = async (job: { url: string; depth: number }): Promise<void> => {
      const page: CrawlPage = { url: job.url, depth: job.depth, status: undefined, title: undefined, links: 0 };
      byUrl.set(job.url, page);
      try {
        const fetched = await fetchPage(host, job.url, {
          render: options.render ?? 'never',
          signal: options.signal,
          renderer: options.render && options.render !== 'never' ? await getRenderer() : undefined,
        });
        page.status = fetched.status;
        page.rendered = fetched.rendered || undefined;

        const links = extractLinks(fetched.html, fetched.url);
        page.links = links.length;
        if (strategy !== 'map') {
          const { title, markdown } = toMarkdown(fetched.html, fetched.url);
          page.title = title;
          page.markdown = markdown;
        } else {
          page.title = parseDocument(fetched.html, fetched.url).title;
        }

        if (job.depth < maxDepth) {
          for (const link of links) {
            const key = normalize(link.url);
            if (seen.has(key) || !allowed(link.url))
              continue;
            seen.add(key);
            // A wide site can discover far more links than max_pages will ever
            // fetch, and keeping them all costs memory for nothing.
            if (seen.size > maxDiscovered) {
              truncated = true;
              break;
            }
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

async function fetchSitemapUrls(root: URL, signal: AbortSignal | undefined): Promise<string[]> {
  const candidates = [new URL('/sitemap.xml', root).toString(), new URL('/sitemap_index.xml', root).toString()];
  const collected: string[] = [];
  const visited = new Set<string>();

  const load = async (url: string, depth: number): Promise<void> => {
    if (depth > 2 || visited.has(url))
      return;
    visited.add(url);
    const result = await httpFetch(url, { signal, retries: 0 }).catch(() => undefined);
    if (!result || result.status >= 400)
      return;
    const xml = decodeBody(result);
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
