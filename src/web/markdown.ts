import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export type Article = {
  title: string | undefined;
  byline: string | undefined;
  /** The article HTML if Readability found one, otherwise the whole body. */
  html: string;
  text: string;
  /** True when Readability declined or was disbelieved, so `html` is the unreduced document. */
  wholeDocument: boolean;
};

export type Link = { url: string; text: string };

type ParsedDocument = {
  document: Document;
  title: string | undefined;
};

/**
 * linkedom does not implement `baseURI`, and Readability leaves relative hrefs
 * alone, which is how hand-rolled converters end up emitting `../foo` links
 * that resolve against nothing. Absolutize before doing anything else.
 */
export function parseDocument(html: string, url: string): ParsedDocument {
  const { document } = parseHTML(html);
  absolutizeUrls(document, url);
  const title = document.querySelector('title')?.textContent?.trim() || undefined;
  return { document: document as unknown as Document, title };
}

function absolutizeUrls(document: any, url: string): void {
  let base: string;
  try {
    base = new URL(document.querySelector('base[href]')?.getAttribute('href') || url, url).toString();
  } catch {
    base = url;
  }
  const resolve = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed || /^(?:[a-z+.-]+:|#|\/\/)/i.test(trimmed) && !/^https?:/i.test(trimmed))
      return /^https?:/i.test(trimmed) ? trimmed : undefined;
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return undefined;
    }
  };
  for (const attribute of ['href', 'src', 'poster', 'action']) {
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      const resolved = resolve(element.getAttribute(attribute) || '');
      if (resolved)
        element.setAttribute(attribute, resolved);
    }
  }
  for (const element of document.querySelectorAll('[srcset]')) {
    const rewritten = (element.getAttribute('srcset') || '').split(',').map((candidate: string) => {
      const [href, ...rest] = candidate.trim().split(/\s+/);
      const resolved = resolve(href || '');
      return [resolved ?? href, ...rest].join(' ');
    }).join(', ');
    element.setAttribute('srcset', rewritten);
  }
}

/**
 * Whether to believe Readability's extraction. It reports no confidence of its
 * own, and the one signal that separates a real extraction from a stray block is
 * how much of the page's text it kept. Measured against saved DOM:
 *
 *   github README     7,458 / 128,619   5.8%   content -- the low legitimate bound
 *   MDN fetch         4,412 /  24,945  17.7%   content
 *   Chrome notes     20,287 /  46,077  44.0%   content
 *   Wikipedia        44,091 /  67,926  64.9%   content
 *   Hacker News       3,713 /   3,941  94.2%   content
 *   Zillow listings   2,400 / 486,090   0.5%   the legal footer
 *   Zillow listings     102 / 491,662   0.02%  a "see commute times" promo
 *
 * Both Zillow answers came back in place of 486KB of prices. A character
 * minimum cannot separate these -- the footer clears any floor low enough to let
 * a genuinely short page through -- so the share is the whole test, and a short
 * page is safe because it is also mostly article.
 *
 * `charThreshold` is not the lever: 250 and 500 both gave the same 102.
 */
const minArticleShare = 0.02;

export function isPlausibleArticle(articleChars: number, pageChars: number): boolean {
  return articleChars >= pageChars * minArticleShare;
}

/**
 * Readability mutates the document it is given, so anything else that needs the
 * original -- the fallback content, the links -- has to be read out *before* it
 * runs rather than from a second parse of the same HTML. Parsing a large page
 * twice is the most expensive thing in this file: 24-40ms for 585KB.
 */
export function readPage(html: string, url: string): { article: Article; links: Link[] } {
  const { document, title } = parseDocument(html, url);
  const links = collectLinks(document);
  return { article: articleOf(document, title), links };
}

export function extractArticle(html: string, url: string): Article {
  const { document, title } = parseDocument(html, url);
  return articleOf(document, title);
}

function articleOf(document: Document, title: string | undefined): Article {
  const body = (document.body ?? document) as any;
  const text = (body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const fallback = {
    title,
    byline: undefined,
    html: body.innerHTML ?? '',
    text,
    wholeDocument: true as const,
  };

  let parsed: ReturnType<Readability['parse']>;
  try {
    parsed = new Readability(document as any, { charThreshold: 250 }).parse();
  } catch {
    parsed = null;
  }
  if (!parsed?.content)
    return fallback;

  const extracted = (parsed.textContent || '').trim();
  if (!isPlausibleArticle(extracted.length, text.length))
    return fallback;

  return {
    title: parsed.title || title,
    byline: parsed.byline || undefined,
    html: parsed.content,
    text: extracted,
    wholeDocument: false,
  };
}

let turndown: TurndownService | undefined;

function turndownService(): TurndownService {
  if (turndown)
    return turndown;
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });
  service.remove(['script', 'style', 'noscript', 'iframe']);
  service.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: content => `~~${content}~~`,
  });
  // turndown has no table support of its own, and a table without a separator
  // row is not a table any Markdown renderer will recognise.
  service.addRule('table', {
    filter: node => node.nodeName === 'TABLE',
    replacement: (_content, node) => renderTable(node as HTMLTableElement),
  });
  turndown = service;
  return service;
}

/**
 * Walks childNodes rather than using querySelectorAll: turndown parses with its
 * own minimal DOM, whose nodes have no query methods.
 */
function renderTable(table: Node): string {
  type Row = { cells: string[]; isHeader: boolean };
  const rows: Row[] = [];

  const collect = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeName === 'TBODY' || child.nodeName === 'THEAD' || child.nodeName === 'TFOOT') {
        collect(child);
        continue;
      }
      if (child.nodeName !== 'TR')
        continue;
      const cells: string[] = [];
      let isHeader = false;
      for (const cell of Array.from(child.childNodes)) {
        if (cell.nodeName !== 'TH' && cell.nodeName !== 'TD')
          continue;
        isHeader ||= cell.nodeName === 'TH';
        cells.push((cell.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      }
      if (cells.length)
        rows.push({ cells, isHeader });
    }
  };
  collect(table);

  if (!rows.length)
    return '';

  const width = Math.max(...rows.map(row => row.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill('')];
  const hasHeaderRow = rows[0].isHeader;
  const header = hasHeaderRow ? pad(rows[0].cells) : Array(width).fill('');
  const body = (hasHeaderRow ? rows.slice(1) : rows).map(row => pad(row.cells));

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ];
  return '\n\n' + lines.join('\n') + '\n\n';
}

export function htmlToMarkdown(html: string): string {
  return turndownService().turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

export function extractLinks(html: string, url: string): Link[] {
  return collectLinks(parseDocument(html, url).document);
}

/** Takes a document rather than HTML, so a caller that has one need not reparse. */
export function collectLinks(document: Document): Link[] {
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href || !/^https?:/i.test(href))
      continue;
    const clean = href.split('#')[0];
    if (seen.has(clean))
      continue;
    seen.add(clean);
    links.push({ url: clean, text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim() });
  }
  return links;
}
