import { httpFetch, decodeBody } from './httpFetch';
import { assertUrlAllowed, BlockedUrlError } from '../util/ssrf';

import type * as playwright from 'playwright-core';
import type { Instance } from '../browser/instance';
import type { ServerHost } from '../mcp/host';

export type RenderMode = 'auto' | 'always' | 'never';

export type FetchedPage = {
  url: string;
  status: number | undefined;
  html: string;
  rendered: boolean;
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

  async render(url: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<FetchedPage> {
    return await this._withPage(url, options, async (page, status) => ({
      url: page.url(),
      status,
      html: await page.content(),
      rendered: true,
    }));
  }

  async pdf(url: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ url: string; data: Buffer }> {
    return await this._withPage(url, options, async page => ({
      url: page.url(),
      data: await page.pdf({ printBackground: true }),
    }));
  }

  /**
   * Each render gets its own page, because a crawl runs several at once and a
   * shared tab would have concurrent navigations cancelling each other. The
   * SSRF policy is applied to the initial URL *and* to every redirect the
   * browser follows, which `page.goto` would otherwise do unchecked.
   */
  private async _withPage<T>(
    url: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
    read: (page: playwright.Page, status: number | undefined) => Promise<T>,
  ): Promise<T> {
    await assertUrlAllowed(url, { allowPrivate: true });
    const page = await this._instance.browserContext.newPage();
    const blocked: string[] = [];
    const onRequest = (request: playwright.Request) => {
      if (!request.isNavigationRequest() || !request.redirectedFrom())
        return;
      void assertUrlAllowed(request.url(), { allowPrivate: false }).catch(e => {
        blocked.push(e instanceof Error ? e.message : String(e));
        void page.close().catch(() => {});
      });
    };
    page.on('request', onRequest);
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30_000 });
      await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
      // Give client-rendered pages a moment to populate.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      if (blocked.length)
        throw new BlockedUrlError(blocked[0]);
      return await read(page, response?.status());
    } finally {
      page.off('request', onRequest);
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this._instance.close().catch(() => {});
  }
}

/**
 * Run `fn` with one shared renderer. The *promise* is memoised, not the
 * resolved renderer: concurrent crawl workers would otherwise each see it
 * unset, each launch a browser, and all but the last would leak.
 */
export async function withRenderer<T>(host: ServerHost, fn: (get: () => Promise<Renderer>) => Promise<T>): Promise<T> {
  let pending: Promise<Renderer> | undefined;
  try {
    return await fn(() => (pending ??= Renderer.create(host)));
  } finally {
    await pending?.then(renderer => renderer.close()).catch(() => {});
  }
}
