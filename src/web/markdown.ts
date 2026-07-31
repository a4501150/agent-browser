import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export type Article = {
  title: string | undefined;
  byline: string | undefined;
  excerpt: string | undefined;
  /** The article HTML if Readability found one, otherwise the whole body. */
  html: string;
  text: string;
  /** True when Readability declined, so `html` is the unreduced document. */
  wholeDocument: boolean;
};

export type ParsedDocument = {
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

export function extractArticle(html: string, url: string): Article {
  const { document, title } = parseDocument(html, url);
  // Readability mutates the document, so give it a copy.
  const { document: forReadability } = parseHTML(html);
  absolutizeUrls(forReadability, url);
  let parsed: ReturnType<Readability['parse']>;
  try {
    parsed = new Readability(forReadability as any, { charThreshold: 250 }).parse();
  } catch {
    parsed = null;
  }

  if (parsed?.content) {
    return {
      title: parsed.title || title,
      byline: parsed.byline || undefined,
      excerpt: parsed.excerpt || undefined,
      html: parsed.content,
      text: (parsed.textContent || '').trim(),
      wholeDocument: false,
    };
  }

  const body = document.body ?? document;
  return {
    title,
    byline: undefined,
    excerpt: undefined,
    html: (body as any).innerHTML ?? '',
    text: ((body as any).textContent ?? '').replace(/\n{3,}/g, '\n\n').trim(),
    wholeDocument: true,
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

export function extractLinks(html: string, url: string): { url: string; text: string }[] {
  const { document } = parseDocument(html, url);
  const seen = new Set<string>();
  const links: { url: string; text: string }[] = [];
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
