/**
 * The web_* tools, exercised against the local fixture server so the suite needs
 * no internet. The live DuckDuckGo path is opt-in via AGENT_BROWSER_LIVE=1,
 * because a search engine is not a fixture.
 */
import fs from 'node:fs';
import path from 'node:path';

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
  it('returns one self-contained markdown document, with a real table and absolute links', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('page.html') });
    expect(result.isError, result.text).toBe(false);
    const body = result.section('Result')!;
    // Provenance travels *with* the content, so a document written to a file
    // still says what it is and where it came from.
    expect(body).toContain('# Fixture headline');
    expect(body).toContain(`- URL: ${fixtures.url('page.html')}`);
    expect(body).toContain('- Status: 200');
    expect(body).toContain('- Content type: text/html');
    expect(body).toContain('| Name | Value |');
    expect(body).toContain('| --- | --- |');
    // The fixture's link is written as ../relative/target.html.
    expect(body).toContain('/relative/target.html');
    expect(body).not.toContain('](../');
    // The browser the web tools fetch through is ours, not the agent's.
    expect((await harness.call('browser_list', {})).section('Result')).toMatch(/No browser instances are open/);
  });

  it('separates raw from html: one is the source, the other the DOM after scripts', async () => {
    const raw = await harness.call('web_fetch', { url: fixtures.url('spa.html'), format: 'raw' });
    expect(raw.isError, raw.text).toBe(false);
    // The heading exists only as a string inside the script until it runs.
    expect(raw.section('Result')).toContain('<div id="root"></div>');
    expect(raw.section('Result')).not.toContain('<h1>Rendered heading</h1>');

    const html = await harness.call('web_fetch', { url: fixtures.url('spa.html'), format: 'html' });
    expect(html.section('Result')).toContain('<h1>Rendered heading</h1>');
  });

  it('renders a client-side page into markdown', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('spa.html') });
    expect(result.isError, result.text).toBe(false);
    expect(result.section('Result')).toContain('Rendered heading');
  });

  it('returns text/plain as itself, not wrapped in Chromium\'s pre viewer', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('notes.txt') });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('- Content type: text/plain');
    const body = result.section('Result')!;
    expect(body).toContain('  indented line, two spaces');
    expect(body).toContain('"quoted" & ampersanded <angled>');
    expect(body).not.toContain('<pre');
  });

  it('returns json byte-exact', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('data.json') });
    const body = result.section('Result')!;
    expect(body).toContain('- Content type: application/json');
    const json = body.slice(body.indexOf('{'));
    expect(JSON.parse(json)).toMatchObject({ name: 'fixture', unicode: 'caf\u00e9 \u2014 na\u00efve' });
  });

  it('returns xml as the document, not as Chromium\'s xml viewer', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('sitemap.xml') });
    const body = result.section('Result')!;
    expect(body).toContain('<urlset');
    // The viewer injects its own stylesheet and would multiply the payload.
    expect(body).not.toContain('xml-viewer-style');
    expect(body).not.toContain('This XML file does not appear');
  });

  it('returns the pdf itself, not the viewer shell that answers the navigation', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('doc.pdf') });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('- Content type: application/pdf');
    const file = /\((\/[^)]+\.pdf)\)/.exec(result.text)?.[1];
    expect(file, result.text).toBeTruthy();
    expect(fs.readFileSync(file!).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('saves an attachment, which aborts the navigation instead of rendering', async () => {
    const result = await harness.call('web_fetch', { url: `${fixtures.url('doc.pdf')}?attachment` });
    expect(result.isError, result.text).toBe(false);
    const file = /\((\/[^)]+)\)/.exec(result.text)?.[1];
    expect(file, result.text).toBeTruthy();
    expect(path.basename(file!)).toContain('doc.pdf');
    expect(fs.readFileSync(file!).subarray(0, 5).toString()).toBe('%PDF-');
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

  it('runs concurrent fetches through one shared browser, and leaks none', async () => {
    const results = await Promise.all([
      harness.call('web_fetch', { url: fixtures.url('spa.html') }),
      harness.call('web_fetch', { url: fixtures.url('a.html') }),
      harness.call('web_fetch', { url: fixtures.url('b.html') }),
    ]);
    for (const result of results)
      expect(result.isError, result.text).toBe(false);
    expect((await harness.call('browser_list', {})).section('Result')).toMatch(/No browser instances are open/);
  });

  it('serves more concurrent fetches than the page cap allows', async () => {
    // Past maxConcurrentPages the rest queue rather than opening a page each;
    // every one still has to complete.
    const urls = Array.from({ length: 20 }, (_, i) => fixtures.url(i % 2 ? 'a.html' : 'b.html'));
    const results = await Promise.all(urls.map(url => harness.call('web_fetch', { url })));
    for (const result of results)
      expect(result.isError, result.text).toBe(false);
  }, 180_000);

  it('lists a browser the agent opened, while still hiding its own', async () => {
    await harness.call('web_fetch', { url: fixtures.url('a.html') });
    const opened = await harness.call('browser_open', {});
    const id = JSON.parse(opened.section('Result')!).instance_id;
    const listed = JSON.parse((await harness.call('browser_list', {})).section('Result')!);
    expect(listed).toHaveLength(1);
    expect(listed[0].instance_id).toBe(id);
    await harness.call('browser_close', { instance_id: id });
  });

  it('reports a 404 rather than pretending', async () => {
    const result = await harness.call('web_fetch', { url: fixtures.url('no-such-page.html') });
    expect(result.text).toContain('- Status: 404');
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

  it('records a page that is not a document, without calling it an error', async () => {
    const result = await harness.call('web_crawl', { url: fixtures.url('data.json'), max_pages: 1 });
    expect(result.isError, result.text).toBe(false);
    const body = result.section('Result')!;
    expect(body).toContain('- Content type: application/json');
    expect(body).toContain('- Links found: 0');
    expect(body).not.toContain('- Error:');
  });

  it('crawls concurrently through one shared browser without leaking it', async () => {
    const result = await harness.call('web_crawl', {
      url: fixtures.url('a.html'),
      max_pages: 3,
      concurrency: 3,
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.section('Result')).toContain('- Content type: text/html');
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
    expect(data.content_type).toBe('text/html');
    expect(data.title).toBe('Fixture page');
    expect(data.description).toBe('A fixture for agent-browser tests.');
    expect(data.open_graph.title).toBe('Fixture OG title');
  });

  it('refuses a url that is not a document, naming what it was', async () => {
    const result = await harness.call('web_extract', { url: fixtures.url('data.json'), mode: 'metadata' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('application/json');
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
    // Nothing sponsored, and no DuckDuckGo furniture presented as a result.
    expect(body).not.toContain('duckduckgo.com');
  });

  it('loads more batches by clicking the SERP\'s own "More results"', async () => {
    const result = await harness.call('web_search', { query: 'chromium devtools protocol', count: 25 });
    expect(result.isError, result.text).toBe(false);
    const body = result.section('Result')!;
    expect(body).toMatch(/\(([2-9]|\d\d) batch\(es\) loaded\)/);
    const positions = [...body.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
    expect(positions.length).toBeGreaterThan(10);
    // Numbered straight through, so page two was parsed rather than repeated.
    expect(positions).toEqual(positions.map((_, index) => index + 1));
    const urls = [...body.matchAll(/^ {3}(https?:\S+)$/gm)].map(m => m[1]);
    expect(new Set(urls).size).toBe(urls.length);
  }, 60_000);

  it('honours a site: operator, which the html endpoint could not', async () => {
    const result = await harness.call('web_search', { query: 'site:playwright.dev getByRole locator', count: 5 });
    expect(result.isError, result.text).toBe(false);
    const body = result.section('Result')!;
    expect(body).toMatch(/^\d+ result\(s\)/);
    const urls = [...body.matchAll(/^ {3}(https?:\S+)$/gm)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls)
      expect(new URL(url).hostname).toContain('playwright.dev');
  }, 60_000);
});
