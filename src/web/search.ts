/**
 * DuckDuckGo search through the browser's own SERP, which is what makes a `site:`
 * query work at all. Ads are excluded structurally: `data-layout` marks every
 * result `organic` or `ad`.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { parseDocument } from './markdown';

import type { ServerHost } from '../mcp/host';

const endpoint = 'https://duckduckgo.com/';

/** The endpoint is somebody else's; do not hammer it between batches. */
const batchGapMs = 1200;
const batchTimeoutMs = 10_000;

const organicSelector = 'li[data-layout="organic"]';
const moreResultsSelector = '#more-results';

export type SearchResult = {
  position: number;
  title: string;
  url: string;
  snippet: string;
};

export type SearchOptions = {
  count?: number;
  region?: string;
  timeRange?: 'd' | 'w' | 'm' | 'y';
  signal?: AbortSignal;
};

export async function search(host: ServerHost, query: string, options: SearchOptions = {}): Promise<{ results: SearchResult[]; batches: number }> {
  const count = options.count ?? 10;
  const params = new URLSearchParams({ q: query });
  if (options.region)
    params.set('kl', options.region);
  if (options.timeRange)
    params.set('df', options.timeRange);

  // One page held across every batch, so the cookies and tokens the endpoint
  // hands out survive from one set of results to the next.
  return await host.withRenderer(renderer => renderer.withPage(
    `${endpoint}?${params}`,
    { signal: options.signal },
    async ({ page, settled }) => {
      await settled();
      // This SERP renders client-side, and `settled` is the redirect policy, not
      // a load wait: without waiting for a result to exist, the parse below sees
      // an empty shell and the tool reports no results for everything.
      await page.waitForSelector(organicSelector, { timeout: batchTimeoutMs }).catch(() => {});
      let batches = 1;
      let loaded = await page.locator(organicSelector).count();

      // "More results" appends into the same document -- no navigation, so
      // nothing here waits for one, and there is no new URL to vet either. The
      // loop ends when the engine stops giving more, not at a batch count of
      // ours: `count` is what the caller asked for and the only thing bounding it.
      while (loaded && loaded < count) {
        const more = page.locator(moreResultsSelector);
        if (!await more.isVisible().catch(() => false))
          break;
        await sleep(batchGapMs, { signal: options.signal });
        await more.click({ timeout: batchTimeoutMs });
        const grown = await page
          .waitForFunction(
            ([selector, seen]) => document.querySelectorAll(selector as string).length > (seen as number),
            [organicSelector, loaded] as const,
            { timeout: batchTimeoutMs })
          .then(() => true)
          .catch(() => false);
        if (!grown)
          break;
        batches++;
        loaded = await page.locator(organicSelector).count();
      }

      // Already numbered from one, and a prefix of that is still numbered from one.
      return { results: parseResults(await page.content()).slice(0, count), batches };
    },
  ));
}

export function parseResults(html: string): SearchResult[] {
  const { document } = parseDocument(html, endpoint);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const item of document.querySelectorAll(organicSelector)) {
    const anchor = item.querySelector('[data-testid="result-title-a"]');
    // Already absolute on this SERP, and `parseDocument` would have absolutized
    // it anyway -- which is also what turns DuckDuckGo's own relative ad and
    // navigation links into something the host check below can reject.
    const url = anchor?.getAttribute('href') ?? '';
    if (!isOffsite(url) || seen.has(url))
      continue;
    seen.add(url);
    results.push({
      position: results.length + 1,
      title: collapse(anchor?.textContent),
      url,
      snippet: snippetOf(item),
    });
  }

  return results;
}

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** A result has to point somewhere else; DuckDuckGo's own links are furniture. */
function isOffsite(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && hostname !== 'duckduckgo.com' && !hostname.endsWith('.duckduckgo.com');
  } catch {
    return false;
  }
}

/**
 * A snippet is sometimes prefixed by a relative date in its own span, and the
 * two run together in `textContent` ("3 days agoStable release date:"). Two
 * element children mean that has happened; anything else falls back to the
 * whole text, which is also the graceful answer if the markup changes.
 */
function snippetOf(item: Element): string {
  const snippet = item.querySelector('[data-result="snippet"]');
  if (!snippet)
    return '';
  const clamp = snippet.querySelector('span');
  const parts = clamp ? [...clamp.children] : [];
  if (parts.length < 2)
    return collapse(snippet.textContent);
  return parts.map(part => collapse(part.textContent)).filter(Boolean).join(' — ');
}
