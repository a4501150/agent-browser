import { httpFetch, decodeBody } from './httpFetch';
import { assertUrlAllowed } from '../util/ssrf';

import type { Instance } from '../browser/instance';
import type { ServerHost } from '../mcp/host';

export type RenderMode = 'auto' | 'always' | 'never';

export type FetchedPage = {
  url: string;
  status: number | undefined;
  headers: Record<string, string>;
  html: string;
  /** Set when a real browser produced the HTML. */
  rendered: boolean;
  /** Why the browser was used, for the tool result. */
  renderReason?: string;
};

/**
 * Markers that mean the HTML we got is not the page: a bot challenge, or a
 * shell that only fills in once scripts run.
 */
const challengeMarkers = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'cf_chl_opt',
  '_cf_chl_',
  'enable javascript and cookies to continue',
  'ddos-guard',
  'please turn javascript on',
  'you need to enable javascript to run this app',
];

const thinTextThreshold = 500;

export async function fetchPage(
  host: ServerHost,
  url: string,
  options: { render?: RenderMode; timeoutMs?: number; signal?: AbortSignal; renderer?: Renderer },
): Promise<FetchedPage> {
  const mode = options.render ?? 'auto';

  if (mode === 'always') {
    const renderer = options.renderer ?? (await Renderer.create(host));
    try {
      return { ...await renderer.render(url, options), renderReason: 'render: "always"' };
    } finally {
      if (!options.renderer)
        await renderer.close();
    }
  }

  const result = await httpFetch(url, { timeoutMs: options.timeoutMs, signal: options.signal });
  const html = decodeBody(result);
  const plain: FetchedPage = {
    url: result.url,
    status: result.status,
    headers: result.headers,
    html,
    rendered: false,
  };

  if (mode === 'never')
    return plain;

  const reason = escalationReason(result.status, html, result.headers['content-type'] ?? '');
  if (!reason)
    return plain;

  const renderer = options.renderer ?? (await Renderer.create(host));
  try {
    return { ...await renderer.render(url, options), renderReason: reason };
  } catch {
    // The plain response is still better than nothing.
    return { ...plain, renderReason: `${reason}; the browser attempt failed` };
  } finally {
    if (!options.renderer)
      await renderer.close();
  }
}

function escalationReason(status: number, html: string, contentType: string): string | undefined {
  if (contentType && !/html|xml|text\/plain/i.test(contentType))
    return undefined;
  if (status === 403 || status === 429 || status === 503)
    return `HTTP ${status} looks like a bot challenge`;
  const lower = html.toLowerCase();
  for (const marker of challengeMarkers) {
    if (lower.includes(marker))
      return `the response contains a challenge marker ("${marker}")`;
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < thinTextThreshold)
    return `the plain response has only ${text.length} characters of text, so the page probably renders client-side`;
  return undefined;
}

/**
 * A throwaway browser for the web_* tools. Always an ephemeral profile, so
 * research traffic never touches a logged-in one; shared across the pages of
 * one crawl so a crawl does not launch a browser per page.
 */
export class Renderer {
  private _instance: Instance;

  private constructor(instance: Instance) {
    this._instance = instance;
  }

  static async create(host: ServerHost): Promise<Renderer> {
    const instance = await host.instances.open({ profile: null, headless: true });
    return new Renderer(instance);
  }

  get instance(): Instance {
    return this._instance;
  }

  async render(url: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<FetchedPage> {
    await assertUrlAllowed(url, { allowPrivate: true });
    const tab = await this._instance.ensureTab();
    const response = await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30_000 });
    await tab.page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    // Give client-rendered pages a moment to populate.
    await tab.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const html = await tab.page.content();
    const headers: Record<string, string> = {};
    try {
      Object.assign(headers, await response?.allHeaders() ?? {});
    } catch {
      // A navigation served from cache may have no response object.
    }
    return {
      url: tab.page.url(),
      status: response?.status(),
      headers,
      html,
      rendered: true,
    };
  }

  async close(): Promise<void> {
    await this._instance.close().catch(() => {});
  }
}

/** Run `fn` with one shared renderer, created lazily and always closed. */
export async function withRenderer<T>(host: ServerHost, fn: (get: () => Promise<Renderer>) => Promise<T>): Promise<T> {
  let renderer: Renderer | undefined;
  try {
    return await fn(async () => (renderer ??= await Renderer.create(host)));
  } finally {
    await renderer?.close();
  }
}
