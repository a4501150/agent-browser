/**
 * The web_* tools, exercised against the local fixture server so the suite needs
 * no internet. The live DuckDuckGo path is opt-in via AGENT_BROWSER_LIVE=1,
 * because a search engine is not a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness } from './helpers/client';
import { startFixtures } from './helpers/server';

import type { Harness } from './helpers/client';
import type { Fixtures } from './helpers/server';

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  fixtures = await startFixtures();
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
  await fixtures?.close();
});

describe('web_fetch', () => {
  it('returns markdown with a real table and absolute links, without opening a browser', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('page.html') });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('Fetched with: a plain HTTP request');
    const body = result.section('Result')!;
    expect(body).toContain('| Name | Value |');
    expect(body).toContain('| --- | --- |');
    // The fixture's link is written as ../relative/target.html.
    expect(body).toContain('/relative/target.html');
    expect(body).not.toContain('](../');
    // No instance was left running by a plain fetch.
    expect((await harness.call('browser_list', {})).section('Result')).toMatch(/No browser instances are open/);
  });

  it('returns plain text and raw html on request', async () => {
    const text = await harness.call('web_fetch', { url: fixtures.url('page.html'), format: 'text' });
    expect(text.section('Result')).toContain('reasonably long paragraph');
    expect(text.section('Result')).not.toContain('<p>');

    const html = await harness.call('web_fetch', { url: fixtures.url('page.html'), format: 'html' });
    expect(html.section('Result')).toContain('<title>Fixture page</title>');
  });

  it('escalates to a real browser for a page that renders client-side', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('spa.html') });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('Fetched with: a real browser');
    expect(result.text).toMatch(/characters of text, so the page probably renders client-side/);
    expect(result.section('Result')).toContain('Rendered heading');
  });

  it('does not escalate when render is never', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('spa.html'), render: 'never' });
    expect(result.text).toContain('Fetched with: a plain HTTP request');
    expect(result.section('Result') ?? '').not.toContain('Rendered heading');
  });

  it('uses a browser when render is always, and says why', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('page.html'), render: 'always' });
    expect(result.text).toContain('Fetched with: a real browser');
    expect(result.text).toContain('render: "always"');
  });

  it('lists links when asked', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('a.html'), extract_links: true });
    const body = result.section('Result')!;
    expect(body).toContain('## Links');
    expect(body).toContain('https://elsewhere.example/off-site');
  });

  it('prints the page to PDF', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('page.html'), format: 'pdf' });
    expect(result.isError, result.text).toBe(false);
    expect(result.section('Result')).toMatch(/Rendered .* to PDF \(\d+ bytes\)/);
  });

  it('refuses a link-local address wherever cloud metadata lives', async () => {
    const result = await harness.call('web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/link-local/);
  });

  it('refuses a non-http scheme', async () => {
    const result = await harness.call('web_fetch', { url: 'file:///etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/only http and https/);
  });

  it('applies the same url policy to the pdf path, which goes straight to a browser', async () => {
    for (const url of ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/']) {
      const result = await harness.call('web_fetch', { url, format: 'pdf' });
      expect(result.isError, `${url} should have been refused`).toBe(true);
      expect(result.text).toMatch(/only http and https|link-local/);
    }
  });

  it('runs concurrent browser-rendered fetches without leaking browsers', async () => {
    const before = (await harness.call('browser_list', {})).section('Result');
    expect(before).toMatch(/No browser instances are open/);
    const results = await Promise.all([
      harness.call('web_fetch', { url: fixtures.url('spa.html'), render: 'always' }),
      harness.call('web_fetch', { url: fixtures.url('a.html'), render: 'always' }),
      harness.call('web_fetch', { url: fixtures.url('b.html'), render: 'always' }),
    ]);
    for (const result of results)
      expect(result.isError, result.text).toBe(false);
    expect((await harness.call('browser_list', {})).section('Result')).toMatch(/No browser instances are open/);
  });

  it('reports a 404 rather than pretending', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('no-such-page.html'), render: 'never' });
    expect(result.text).toContain('HTTP status: 404');
  });
});

describe('web_crawl', () => {
  it('walks the same origin breadth first, respecting the page cap', async () => {
    const result = await harness.call('web_crawl', { url: fixtures.url('a.html'), max_depth: 2, max_pages: 4 });
    expect(result.isError, result.text).toBe(false);
    const summary = result.text;
    expect(summary).toContain('Strategy: bfs');
    const body = result.section('Result')!;
    expect(body).toContain('Page A');
    expect(body).toContain('Page B');
    // Off-site links are never followed.
    expect(body).not.toContain('elsewhere.example/off-site\n- Depth');
  });

  it('honours exclude patterns', async () => {
    const result = await harness.call('web_crawl', {
      url: fixtures.url('a.html'),
      max_depth: 3,
      max_pages: 10,
      exclude: ['excluded\\.html'],
    });
    expect(result.section('Result')).not.toContain('URL: ' + fixtures.url('excluded.html'));
  });

  it('honours include patterns', async () => {
    const result = await harness.call('web_crawl', {
      url: fixtures.url('a.html'),
      max_depth: 2,
      max_pages: 10,
      include: ['[ab]\\.html$'],
    });
    const body = result.section('Result')!;
    expect(body).toContain('Page B');
    expect(body).not.toContain('Fixture page');
  });

  it('collects urls only in map mode', async () => {
    const result = await harness.call('web_crawl', { url: fixtures.url('a.html'), strategy: 'map', max_pages: 3 });
    const body = result.section('Result')!;
    expect(body).toContain('## Page A');
    // No page content, only the heading block for each URL.
    expect(body).not.toContain('links onward');
  });

  it('reads a sitemap instead of crawling', async () => {
    const result = await harness.call('web_crawl', { url: fixtures.origin, strategy: 'sitemap' });
    expect(result.text).toContain('Strategy: sitemap');
    const body = result.section('Result')!;
    expect(body).toContain('a.html');
    expect(body).toContain('b.html');
  });

  it('crawls with a real browser per page without leaking one', async () => {
    const result = await harness.call('web_crawl', {
      url: fixtures.url('a.html'),
      max_pages: 3,
      concurrency: 3,
      render: 'always',
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.section('Result')).toContain('Fetched with a real browser');
    // One shared renderer, closed when the crawl ends.
    expect((await harness.call('browser_list', {})).section('Result')).toMatch(/No browser instances are open/);
  });

  it('runs pages concurrently rather than one at a time', async () => {
    // Four pages at concurrency 4 must not take four times one page.
    const started = Date.now();
    const result = await harness.call('web_crawl', { url: fixtures.url('a.html'), max_pages: 4, concurrency: 4 });
    expect(result.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('web_extract', () => {
  it('extracts metadata from a url', async () => {
    const result = await harness.call('web_extract', { url: fixtures.url('page.html'), mode: 'metadata' });
    const data = JSON.parse(result.section('Result')!);
    expect(data.source).toContain('page.html');
    expect(data.fetched_with).toBe('a plain HTTP request');
    expect(data.title).toBe('Fixture page');
    expect(data.description).toBe('A fixture for agent-browser tests.');
    expect(data.open_graph.title).toBe('Fixture OG title');
  });

  it('extracts tables as records', async () => {
    const result = await harness.call('web_extract', { url: fixtures.url('page.html'), mode: 'tables' });
    const data = JSON.parse(result.section('Result')!);
    expect(data.tables[0].caption).toBe('Fixture table');
    expect(data.tables[0].records).toEqual([{ Name: 'alpha', Value: '1' }, { Name: 'beta', Value: '2' }]);
  });

  it('extracts JSON-LD', async () => {
    const result = await harness.call('web_extract', { url: fixtures.url('page.html'), mode: 'structured' });
    const data = JSON.parse(result.section('Result')!);
    expect(data.json_ld[0]).toMatchObject({ '@type': 'Article', headline: 'Fixture headline' });
  });

  it('extracts from supplied html without fetching', async () => {
    const result = await harness.call('web_extract', { html: '<p class="x">only this</p>', mode: 'selector', selector: 'p.x' });
    const data = JSON.parse(result.section('Result')!);
    expect(data.matches[0].text).toBe('only this');
  });

  it('insists on exactly one of url and html', async () => {
    expect((await harness.call('web_extract', { mode: 'metadata' })).isError).toBe(true);
    expect((await harness.call('web_extract', { mode: 'metadata', url: fixtures.origin, html: '<p>x</p>' })).isError).toBe(true);
  });
});

describe.runIf(process.env.AGENT_BROWSER_LIVE === '1')('web_search against the live engine', () => {
  it('returns organic results', async () => {
    const result = await harness.call('web_search', { query: 'playwright accessibility snapshot', count: 5 });
    expect(result.isError, result.text).toBe(false);
    const body = result.section('Result')!;
    expect(body).toMatch(/^\d+ result\(s\)/);
    expect(body).toMatch(/https?:\/\//);
    // No ad hosts, and no unresolved DuckDuckGo redirect wrappers.
    expect(body).not.toContain('uddg=');
    expect(body).not.toContain('duckduckgo.com/l/');
  });
});
