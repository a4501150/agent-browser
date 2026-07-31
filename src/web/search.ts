/**
 * DuckDuckGo search, ported from stealth-browser-mcp's src/web_tools.py
 * (MIT): the html.duckduckgo.com endpoint, the region->kl and time_range->df
 * mapping, unwrapping the `uddg=` redirect parameter, and paginating by
 * submitting the "Next" form with a pause between pages.
 *
 * What is added: that implementation claims to return non-sponsored results but
 * only selects `.result` and requires `.result__a`, with no ad check at all.
 * Ads are rejected explicitly here rather than trusting the endpoint not to
 * serve them.
 */
import { httpFetch, decodeBody } from './httpFetch';
import { parseDocument } from './markdown';
import { fetchPage } from './render';

import type { ServerHost } from '../mcp/host';

const endpoint = 'https://html.duckduckgo.com/html/';
const pageGapMs = 1500;

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

const adClasses = ['result--ad', 'result--ad-u', 'results--ads'];
const adHosts = new Set([
  'duckduckgo.com',
  'www.bing.com',
  'bing.com',
  'r.search.yahoo.com',
  'ad.doubleclick.net',
  'googleadservices.com',
  'www.googleadservices.com',
]);

export async function search(host: ServerHost, query: string, options: SearchOptions = {}): Promise<{ results: SearchResult[]; pages: number }> {
  const count = Math.max(1, Math.min(options.count ?? 10, 100));
  const params = new URLSearchParams({ q: query });
  if (options.region)
    params.set('kl', options.region);
  if (options.timeRange)
    params.set('df', options.timeRange);

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let html = await loadFirstPage(host, `${endpoint}?${params}`, options.signal);
  let pages = 0;

  for (let page = 0; page < 10; page++) {
    pages++;
    const parsed = parseResults(html);
    for (const result of parsed.results) {
      if (seen.has(result.url))
        continue;
      seen.add(result.url);
      results.push(result);
    }
    if (results.length >= count || !parsed.next)
      break;
    await new Promise(f => setTimeout(f, pageGapMs));
    const response = await httpFetch(parsed.next.action, {
      method: 'POST',
      body: parsed.next.fields,
      signal: options.signal,
      headers: { referer: endpoint },
    });
    if (response.status >= 400)
      break;
    html = decodeBody(response);
  }

  return {
    results: results.slice(0, count).map((result, index) => ({ ...result, position: index + 1 })),
    pages,
  };
}

async function loadFirstPage(host: ServerHost, url: string, signal: AbortSignal | undefined): Promise<string> {
  const response = await httpFetch(url, { signal, headers: { referer: 'https://duckduckgo.com/' } });
  const html = decodeBody(response);
  if (response.status < 400 && /class="result/.test(html))
    return html;
  // The endpoint is rate-limiting or challenging us; fall back to a real browser.
  const rendered = await fetchPage(host, url, { render: 'always', signal });
  return rendered.html;
}

type NextForm = { action: string; fields: URLSearchParams };

export function parseResults(html: string): { results: SearchResult[]; next: NextForm | undefined } {
  const { document } = parseDocument(html, endpoint);
  const results: SearchResult[] = [];

  for (const element of document.querySelectorAll('.result')) {
    if (isAd(element))
      continue;
    const anchor = element.querySelector('.result__a');
    if (!anchor)
      continue;
    const url = unwrapRedirect(anchor.getAttribute('href') || '');
    if (!url || !/^https?:/i.test(url))
      continue;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (adHosts.has(hostname))
      continue;
    results.push({
      position: results.length + 1,
      title: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      url,
      snippet: (element.querySelector('.result__snippet')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    });
  }

  return { results, next: findNextForm(document) };
}

function isAd(element: Element): boolean {
  const className = element.getAttribute('class') ?? '';
  if (adClasses.some(cls => className.split(/\s+/).includes(cls)))
    return true;
  if (element.closest('.results--ads'))
    return true;
  // DuckDuckGo labels sponsored blocks in the badge next to the URL.
  const badge = element.querySelector('.badge--ad, .result__type');
  if (badge && /^\s*ad\b|sponsored/i.test(badge.textContent ?? ''))
    return true;
  return false;
}

/** Real URLs hide behind `/l/?uddg=<encoded>`. */
function unwrapRedirect(href: string): string {
  if (!href.includes('uddg='))
    return href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(href, endpoint);
    return decodeURIComponent(parsed.searchParams.get('uddg') || href);
  } catch {
    return href;
  }
}

function findNextForm(document: Document): NextForm | undefined {
  const input = [...document.querySelectorAll('input[value="Next"], input.btn--alt')]
    .find(el => (el.getAttribute('value') ?? '').trim() === 'Next');
  const form = input?.closest('form');
  if (!form)
    return undefined;
  const fields = new URLSearchParams();
  for (const field of form.querySelectorAll('input[name]')) {
    const name = field.getAttribute('name')!;
    if (field.getAttribute('type') === 'submit')
      continue;
    fields.set(name, field.getAttribute('value') ?? '');
  }
  const action = new URL(form.getAttribute('action') || endpoint, endpoint).toString();
  return { action, fields };
}
