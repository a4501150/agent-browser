import { describe, expect, it } from 'vitest';

import { CliExit, parseCli } from '../src/cli';
import { extract } from '../src/web/extract';
import { extractArticle, extractLinks, htmlToMarkdown, isPlausibleArticle, readPage } from '../src/web/markdown';
import { allTools } from '../src/mcp/registry';
import { assertUrlAllowed, BlockedUrlError } from '../src/util/ssrf';
import { parseResults } from '../src/web/search';
import { maxConcurrentPages, PageGate } from '../src/web/render';
import { refPattern } from '../src/browser/snapshot';

describe('cli', () => {
  it('defaults to stdio with no arguments', () => {
    expect(parseCli([])).toEqual({ command: 'stdio', port: 3000, host: '127.0.0.1', headed: false });
  });

  it('parses serve and its options', () => {
    const cli = parseCli(['serve', '--port', '8080', '--host', '0.0.0.0', '--headed', '--idle-timeout', '0']);
    expect(cli).toMatchObject({ command: 'serve', port: 8080, host: '0.0.0.0', headed: true, idleTimeout: 0 });
  });

  it('exits zero for --help and --version', () => {
    expect(() => parseCli(['--help'])).toThrow(CliExit);
    try {
      parseCli(['--version']);
    } catch (e) {
      expect((e as CliExit).code).toBe(0);
    }
  });

  it('rejects unknown options and bad values', () => {
    expect(() => parseCli(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseCli(['serve', '--port', 'abc'])).toThrow(/--port must be an integer/);
    expect(() => parseCli(['--binary'])).toThrow(/needs a value/);
  });
});

describe('tool registry', () => {
  it('exposes exactly 32 uniquely named tools', () => {
    expect(allTools).toHaveLength(32);
    expect(new Set(allTools.map(t => t.schema.name)).size).toBe(32);
  });

  it('prefixes every tool name so it cannot collide with another MCP server', () => {
    for (const tool of allTools)
      expect(tool.schema.name).toMatch(/^(browser|web)_/);
  });

  it('injects instance_id into browser tools and leaves global ones alone', () => {
    const needsInstance = allTools.filter(t => t.kind !== 'global');
    const globals = allTools.filter(t => t.kind === 'global');
    for (const tool of needsInstance)
      expect(Object.keys(tool.schema.inputSchema.shape)).toContain('instance_id');
    for (const tool of globals)
      expect(Object.keys(tool.schema.inputSchema.shape)).not.toContain('instance_id');
    expect(globals.map(t => t.schema.name).sort()).toEqual(
      ['browser_list', 'browser_open', 'web_crawl', 'web_extract', 'web_fetch', 'web_search']);
  });

  it('gives every tool a description', () => {
    for (const tool of allTools)
      expect(tool.schema.description.length).toBeGreaterThan(20);
  });
});

describe('snapshot refs', () => {
  it('recognises plain and frame-prefixed refs, and nothing else', () => {
    expect(refPattern.test('e1')).toBe(true);
    expect(refPattern.test('f1e3')).toBe(true);
    expect(refPattern.test('f12e345')).toBe(true);
    expect(refPattern.test('#button')).toBe(false);
    expect(refPattern.test('/html/body')).toBe(false);
    expect(refPattern.test('div.foo')).toBe(false);
  });
});

describe('page gate', () => {
  const saturate = async (gate: PageGate) => {
    for (let i = 0; i < maxConcurrentPages; i++)
      await gate.acquire(undefined);
  };

  it('queues past the cap and admits one per release', async () => {
    const gate = new PageGate();
    await saturate(gate);
    let admitted = false;
    const queued = gate.acquire(undefined).then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted, 'the cap should have held this one back').toBe(false);
    gate.release();
    await queued;
    expect(admitted).toBe(true);
  });

  it('rejects a queued waiter on abort instead of parking it forever', async () => {
    // An aborted crawl would otherwise never settle, and its slot would be lost.
    const gate = new PageGate();
    await saturate(gate);
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    controller.abort(new Error('caller went away'));
    await expect(queued).rejects.toThrow('caller went away');
    gate.release();
    await expect(gate.acquire(undefined)).resolves.toBeUndefined();
  });

  it('refuses immediately when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too late'));
    await expect(new PageGate().acquire(controller.signal)).rejects.toThrow('too late');
  });
});

describe('ssrf policy', () => {
  it('refuses non-http schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow(BlockedUrlError);
    await expect(assertUrlAllowed('ftp://example.com/x', { allowPrivate: true })).rejects.toThrow(/only http and https/);
  });

  it('always refuses link-local, which is where instance metadata lives', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/', { allowPrivate: true }))
      .rejects.toThrow(/link-local/);
  });

  it('allows loopback for a URL the caller named but not for a redirect target', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:8080/', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertUrlAllowed('http://127.0.0.1:8080/', { allowPrivate: false })).rejects.toThrow(/private address/);
    await expect(assertUrlAllowed('http://10.0.0.5/', { allowPrivate: false })).rejects.toThrow(/private address/);
    await expect(assertUrlAllowed('http://[::1]/', { allowPrivate: false })).rejects.toThrow(/private address/);
  });
});

const article = `<!doctype html><title>T</title><body><article>
<p>${'Long enough paragraph to be treated as article content. '.repeat(8)}</p>
<p><a href="../other/page.html">relative</a> and <a href="https://example.com/x">absolute</a></p>
<table><tr><th>Name</th><th>N</th></tr><tr><td>a|b</td><td>1</td></tr></table>
<ol><li>one</li><li>two</li></ol>
</article></body>`;

describe('markdown', () => {
  it('absolutizes relative links against the page URL', () => {
    const links = extractLinks(article, 'https://site.test/dir/sub/index.html');
    expect(links.map(l => l.url)).toContain('https://site.test/dir/other/page.html');
    expect(links.map(l => l.url)).toContain('https://example.com/x');
  });

  it('emits a table with a separator row', () => {
    const markdown = htmlToMarkdown(extractArticle(article, 'https://site.test/').html);
    expect(markdown).toContain('| Name | N |');
    expect(markdown).toContain('| --- | --- |');
    // A pipe inside a cell must be escaped or it splits the row.
    expect(markdown).toContain('a\\|b');
  });

  it('numbers ordered lists rather than bulleting them', () => {
    const markdown = htmlToMarkdown(extractArticle(article, 'https://site.test/').html);
    expect(markdown).toMatch(/1\.\s+one/);
    expect(markdown).toMatch(/2\.\s+two/);
  });

  it('reads the links and the article from one parse', () => {
    // Readability mutates the document, so a single-parse path has to collect
    // the links first; if it ever stops doing that, these come back empty.
    const url = 'https://site.test/dir/sub/index.html';
    const once = readPage(article, url);
    expect(once.links).toEqual(extractLinks(article, url));
    expect(once.article).toEqual(extractArticle(article, url));
  });
});

describe('extract', () => {
  const html = `<!doctype html><title>Title</title>
    <meta name="description" content="Desc"><meta property="og:image" content="/img.png">
    <link rel="canonical" href="https://site.test/canon">
    <script type="application/ld+json">{"@type":"Product","name":"Widget"}</script>
    <div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Ada</span></div>
    <table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>
    <p class="x">first</p><p class="x">second</p>`;

  it('reads metadata and absolutizes og urls', () => {
    const result = extract(html, 'https://site.test/page', 'metadata') as any;
    expect(result.title).toBe('Title');
    expect(result.description).toBe('Desc');
    expect(result.canonical).toBe('https://site.test/canon');
    expect(result.open_graph.image).toBe('/img.png');
  });

  it('reads JSON-LD and microdata', () => {
    const result = extract(html, 'https://site.test/page', 'structured') as any;
    expect(result.json_ld[0]).toMatchObject({ '@type': 'Product', name: 'Widget' });
    expect(result.microdata[0]).toMatchObject({ name: 'Ada' });
  });

  it('turns tables into keyed records', () => {
    const result = extract(html, 'https://site.test/page', 'tables') as any;
    expect(result.tables[0].headers).toEqual(['k', 'v']);
    expect(result.tables[0].records).toEqual([{ k: 'a', v: '1' }]);
  });

  it('matches a selector and requires one for that mode', () => {
    const result = extract(html, 'https://site.test/page', 'selector', 'p.x') as any;
    expect(result.matches.map((m: any) => m.text)).toEqual(['first', 'second']);
    expect(() => extract(html, 'https://site.test/page', 'selector')).toThrow(/"selector" is required/);
  });
});

describe('article plausibility', () => {
  // Every pair here was measured against saved DOM; they are the specification,
  // not illustrations. Readability reports no confidence of its own.
  it('believes a real extraction, down to a code view on a heavy site', () => {
    expect(isPlausibleArticle(7458, 128619)).toBe(true);   // github README, 5.8% -- the low bound
    expect(isPlausibleArticle(4412, 24945)).toBe(true);    // MDN
    expect(isPlausibleArticle(20287, 46077)).toBe(true);   // Chrome release notes
    expect(isPlausibleArticle(44091, 67926)).toBe(true);   // Wikipedia
    expect(isPlausibleArticle(3713, 3941)).toBe(true);     // a link list
  });

  it('rejects a stray block returned in place of the page', () => {
    // Both of these were handed back instead of 486KB of Zillow listings, and
    // the larger one clears any character floor a short page could also clear.
    expect(isPlausibleArticle(2400, 486090)).toBe(false);  // the legal footer
    expect(isPlausibleArticle(102, 491662)).toBe(false);   // a promo block
  });

  it('keeps a short page that is mostly article', () => {
    expect(isPlausibleArticle(300, 400)).toBe(true);
  });
});

describe('duckduckgo parsing', () => {
  // Shaped like the real SERP: ads are a sibling layout, the title anchor is
  // already absolute, and a snippet's date lives in its own span.
  const html = `<ol>
    <li data-layout="ad"><article data-testid="result">
      <a data-testid="result-title-a" href="https://duckduckgo.com/y.js?ad_domain=sponsor.example">Sponsored</a>
    </article></li>
    <li data-layout="organic"><article data-testid="result">
      <a data-testid="result-title-a" href="https://real.example/page">Real</a>
      <div data-result="snippet"><div><span><span>3 days ago</span><span>A snippet</span></span></div></div>
    </article></li>
    <li data-layout="organic"><article data-testid="result">
      <a data-testid="result-title-a" href="https://other.example/x">Other</a>
      <div data-result="snippet"><div><span><span>Undated text</span></span></div></div>
    </article></li>
    <li data-layout="organic"><article data-testid="result">
      <a data-testid="result-title-a" href="/settings">Furniture</a>
    </article></li>
  </ol>`;

  it('takes organic results and drops ads and DuckDuckGo\'s own links', () => {
    const results = parseResults(html);
    expect(results.map(r => r.url)).toEqual(['https://real.example/page', 'https://other.example/x']);
    expect(results.map(r => r.position)).toEqual([1, 2]);
  });

  it('separates a snippet\'s date, which otherwise runs into the text', () => {
    const results = parseResults(html);
    expect(results[0].snippet).toBe('3 days ago — A snippet');
    expect(results[1].snippet).toBe('Undated text');
  });
});
