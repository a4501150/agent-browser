import { parseDocument } from './markdown';

export type ExtractMode = 'selector' | 'tables' | 'metadata' | 'structured';

export type ExtractResult = Record<string, unknown>;

/** Deterministic extraction: no model in the loop, so the output is stable. */
export function extract(html: string, url: string, mode: ExtractMode, selector?: string): ExtractResult {
  const { document } = parseDocument(html, url);
  switch (mode) {
    case 'selector':
      if (!selector)
        throw new Error('"selector" is required for mode "selector".');
      return { selector, matches: extractSelector(document, selector) };
    case 'tables':
      return { tables: extractTables(document) };
    case 'metadata':
      return extractMetadata(document, url);
    case 'structured':
      return extractStructured(document);
  }
}

function extractSelector(document: Document, selector: string): unknown[] {
  const nodes = [...document.querySelectorAll(selector)];
  return nodes.map(node => {
    const element = node as any;
    const attributes: Record<string, string> = {};
    for (const attribute of element.attributes ?? [])
      attributes[attribute.name] = attribute.value;
    return {
      tag: element.tagName?.toLowerCase(),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      html: element.innerHTML ?? '',
      attributes,
    };
  });
}

function extractTables(document: Document): unknown[] {
  return [...document.querySelectorAll('table')].map((table, index) => {
    const rows = [...table.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('th, td')].map(cell => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()));
    const nonEmpty = rows.filter(row => row.length);
    const hasHeader = !!table.querySelector('tr th');
    const headers = hasHeader ? nonEmpty[0] ?? [] : [];
    const body = hasHeader ? nonEmpty.slice(1) : nonEmpty;
    return {
      index,
      caption: table.querySelector('caption')?.textContent?.trim() || undefined,
      headers,
      rows: body,
      // A keyed form too, since that is what callers usually want.
      records: headers.length
        ? body.map(row => Object.fromEntries(headers.map((h, i) => [h || `column_${i}`, row[i] ?? ''])))
        : undefined,
    };
  });
}

function extractMetadata(document: Document, url: string): ExtractResult {
  const meta: Record<string, string> = {};
  for (const element of document.querySelectorAll('meta')) {
    const key = element.getAttribute('property') || element.getAttribute('name') || element.getAttribute('itemprop');
    const value = element.getAttribute('content');
    if (key && value)
      meta[key] = value;
  }
  const links: Record<string, string> = {};
  for (const element of document.querySelectorAll('link[rel][href]')) {
    const rel = element.getAttribute('rel')!;
    if (!links[rel])
      links[rel] = element.getAttribute('href')!;
  }
  return {
    url,
    title: document.querySelector('title')?.textContent?.trim() || undefined,
    description: meta['description'] || meta['og:description'] || undefined,
    canonical: links['canonical'] || undefined,
    language: document.querySelector('html')?.getAttribute('lang') || undefined,
    open_graph: pickPrefixed(meta, 'og:'),
    twitter: pickPrefixed(meta, 'twitter:'),
    meta,
    links,
  };
}

function pickPrefixed(meta: Record<string, string>, prefix: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(prefix))
      out[key.slice(prefix.length)] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function extractStructured(document: Document): ExtractResult {
  const jsonLd: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent?.trim();
    if (!text)
      continue;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed))
        jsonLd.push(...parsed);
      else
        jsonLd.push(parsed);
    } catch {
      // Malformed JSON-LD is common; skip it rather than failing the call.
    }
  }
  return { json_ld: jsonLd, microdata: extractMicrodata(document) };
}

function extractMicrodata(document: Document): unknown[] {
  const roots = [...document.querySelectorAll('[itemscope]')].filter(node => !(node as any).parentElement?.closest?.('[itemscope]'));
  return roots.map(root => readItem(root as any));
}

function readItem(root: any): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  const type = root.getAttribute('itemtype');
  if (type)
    item['@type'] = type;
  for (const node of root.querySelectorAll('[itemprop]')) {
    // Nested scopes belong to their own item.
    if (node.parentElement?.closest('[itemscope]') !== root && node !== root)
      continue;
    const name = node.getAttribute('itemprop')!;
    const value = node.hasAttribute('itemscope')
      ? readItem(node)
      : node.getAttribute('content')
        ?? node.getAttribute('href')
        ?? node.getAttribute('src')
        ?? node.getAttribute('datetime')
        ?? (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const existing = item[name];
    if (existing === undefined)
      item[name] = value;
    else if (Array.isArray(existing))
      existing.push(value);
    else
      item[name] = [existing, value];
  }
  return item;
}
