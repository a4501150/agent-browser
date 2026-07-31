import { describe, expect, it } from 'vitest';

import { CliExit, parseCli } from '../src/cli';
import { extract } from '../src/web/extract';
import { extractArticle, extractLinks, htmlToMarkdown } from '../src/web/markdown';
import { allTools } from '../src/mcp/registry';
import { assertUrlAllowed, BlockedUrlError } from '../src/util/ssrf';
import { parseResults } from '../src/web/search';
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

describe('duckduckgo parsing', () => {
  const html = `<div class="results">
    <div class="result result--ad"><a class="result__a" href="https://ad.example/x">Sponsored</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage">Real</a>
      <a class="result__snippet">A snippet</a></div>
    <div class="result"><a class="result__a" href="https://www.bing.com/aclick?ad">Bing ad</a></div>
    <div class="nav-link"><form action="/html/"><input name="q" value="x"><input name="s" value="30"><input type="submit" value="Next"></form></div>
  </div>`;

  it('unwraps the uddg redirect and rejects ads', () => {
    const { results, next } = parseResults(html);
    expect(results.map(r => r.url)).toEqual(['https://real.example/page']);
    expect(results[0].snippet).toBe('A snippet');
    expect(next?.fields.get('s')).toBe('30');
    // The submit button itself is not a form field to resubmit.
    expect(next?.fields.has('Next')).toBe(false);
  });
});
