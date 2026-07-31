import { assertUrlAllowed } from '../util/ssrf';
import { eventsHelper } from '../vendor/eventsHelper';
import { isTextualMimeType } from '../vendor/mimeType';

import type * as playwright from 'playwright-core';
import type { RegisteredListener } from '../vendor/eventsHelper';
import type { Instance } from '../browser/instance';
import type { ServerHost } from '../mcp/host';

export type FetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Return the bytes the server sent rather than the rendered DOM, and skip the
   * settling waits along with them: for a document, "raw" means before scripts
   * ran.
   */
  raw?: boolean;
};

type FetchMetadata = {
  url: string;
  status: number | undefined;
  contentType: string | undefined;
};

/**
 * What a URL turned out to be. `html` is the rendered DOM; `text` and `binary`
 * are the bytes the server actually sent, because Chromium's viewers wrap
 * anything else in markup that is not the document — a 319 KB feed reads as
 * 1.79 MB of XML-viewer markup through `page.content()`.
 */
export type FetchedPage =
  | (FetchMetadata & { kind: 'html'; html: string })
  | (FetchMetadata & { kind: 'text'; text: string })
  | (FetchMetadata & { kind: 'binary'; bytes: Buffer; filename?: string });

const navigationTimeoutMs = 30_000;
const loadTimeoutMs = 10_000;
const settleTimeoutMs = 5_000;

/**
 * How long to let a Cloudflare interstitial finish. It runs Turnstile and then
 * re-navigates to the same URL by POST, which measured ~6 s on crunchbase.com.
 */
const challengeTimeoutMs = 20_000;
/**
 * Concurrent pages across every web_* call sharing this renderer. A single
 * crawl caps itself at 16, but several tool calls run at once and each page
 * costs tens of megabytes of Chromium. Deadlock-free only because nothing ever
 * acquires a second page while holding one: a crawl holds a lease, not a page.
 */
export const maxConcurrentPages = 16;

export function mediaType(header: string | undefined): string | undefined {
  const type = header?.split(';')[0].trim().toLowerCase();
  return type || undefined;
}

export function isHtmlType(type: string | undefined): boolean {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/**
 * Decode with the charset the server declared, then the one the document
 * declares about itself: `application/xml` routinely arrives with no charset
 * parameter, and raw HTML reaches this path too, since `raw` deliberately
 * bypasses the rendered branch. No BOM handling, because `TextDecoder` strips
 * one already.
 */
export function decodeText(bytes: Buffer, header: string | undefined): string {
  const head = bytes.subarray(0, 1024).toString('latin1');
  const declared = /charset=["']?([\w-]+)/i.exec(header ?? '')?.[1]
    ?? /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const encoding = declared?.toLowerCase() === 'utf8' ? 'utf-8' : declared ?? 'utf-8';
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return bytes.toString('utf-8');
  }
}

/** What `withPage` hands its callback: the page, and how it got there. */
export type Navigation = {
  page: playwright.Page;
  response: playwright.Response | undefined;
  download: playwright.Download | undefined;
  /**
   * Await every redirect check started so far and throw if one refused. Must be
   * called after any navigation, and before returning anything read from the
   * page: the checks are asynchronous, so a raw body could otherwise be handed
   * back before the policy that forbids it has finished resolving DNS.
   */
  settled: () => Promise<void>;
};

/**
 * The browser behind the web_* tools. One throwaway profile, so research
 * traffic never touches a logged-in one, held for as long as the host keeps
 * the renderer rather than being rebuilt per call.
 */
export class Renderer {
  private _instance: Instance;
  private _gate = new PageGate();

  private constructor(instance: Instance) {
    this._instance = instance;
  }

  static async create(host: ServerHost): Promise<Renderer> {
    // idleTimeout 0 deliberately: this instance is driven through its context
    // rather than through Registry.get(), so its lastActivity never advances
    // and a server-wide --idle-timeout would reap it mid-crawl.
    const instance = await host.instances.open({ profile: null, headless: true, internal: true, idleTimeout: 0 });
    return new Renderer(instance);
  }

  get closed(): boolean {
    return this._instance.closed;
  }

  async fetchPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    return await this.withPage(url, options, async nav => {
      if (nav.download)
        return await readDownload(nav.download, nav.response);

      const { page, response } = nav;
      if (!response)
        throw new Error(`No response from ${url}.`);

      const header = response.headers()['content-type'];
      const status = response.status();

      // A bodyless status has nothing to read, and `response.body()` rejects
      // outright for a 304. Checked first, since such a response still carries
      // whatever content-type the server felt like sending.
      if ([204, 205, 304].includes(status))
        return { url: page.url(), status, contentType: mediaType(header), kind: 'text', text: '' };

      const type = mediaType(header) ?? await page.evaluate(() => document.contentType).catch(() => undefined);
      const meta: FetchMetadata = { url: page.url(), status, contentType: type };

      if (isHtmlType(type) && !options.raw) {
        await settle(page, options.signal);
        return { ...meta, kind: 'html', html: await page.content() };
      }

      if (type === 'application/pdf')
        return { ...meta, ...await readPdf(page) };

      const bytes = await response.body();
      return isTextualMimeType(type ?? '')
        ? { ...meta, kind: 'text', text: decodeText(bytes, header) }
        : { ...meta, kind: 'binary', bytes };
    });
  }

  async printPdf(url: string, options: FetchOptions = {}): Promise<{ url: string; data: Buffer }> {
    return await this.withPage(url, options, async ({ page }) => {
      await settle(page, options.signal);
      return { url: page.url(), data: await page.pdf({ printBackground: true }) };
    });
  }

  /**
   * Navigate a fresh page and hand it to `use`. Each call gets its own page,
   * because a crawl runs several at once and a shared tab means concurrent
   * navigations cancelling each other.
   */
  async withPage<T>(url: string, options: FetchOptions, use: (nav: Navigation) => Promise<T>): Promise<T> {
    // The URL the caller named may be loopback or private — fetching your own
    // dev server is legitimate. A redirect target may not be: the caller did
    // not choose it.
    await assertUrlAllowed(url, { allowPrivate: true });

    await this._gate.acquire(options.signal);
    let page: playwright.Page;
    try {
      page = await this._instance.browserContext.newPage();
    } catch (e) {
      this._gate.release();
      throw e;
    }
    const checks = new Set<Promise<void>>();
    let refusal: Error | undefined;
    let lastResponse: playwright.Response | undefined;
    let download: playwright.Download | undefined;
    const extras = new Set<playwright.Page>();

    const onRequest = (request: playwright.Request) => {
      if (!request.isNavigationRequest() || !request.redirectedFrom())
        return;
      checks.add(assertUrlAllowed(request.url(), { allowPrivate: false }).then(() => {}).catch(e => {
        refusal ??= e instanceof Error ? e : new Error(String(e));
        void page.close().catch(() => {});
      }));
    };
    // Main-frame *document* responses only. Every subresource the main frame
    // loads also reports that frame, so a laxer test leaves `lastResponse`
    // pointing at whichever stylesheet happened to arrive last.
    const onResponse = (response: playwright.Response) => {
      const request = response.request();
      if (response.frame() === page.mainFrame() && request.isNavigationRequest() && !request.redirectedTo())
        lastResponse = response;
    };
    const onDownload = (started: playwright.Download) => {
      download ??= started;
    };
    const onPopup = (opened: playwright.Page) => {
      extras.add(opened);
    };
    const onAbort = () => {
      void page.close().catch(() => {});
    };

    const listeners: RegisteredListener[] = [
      eventsHelper.addEventListener(page, 'request', onRequest),
      eventsHelper.addEventListener(page, 'response', onResponse),
      eventsHelper.addEventListener(page, 'download', onDownload),
      eventsHelper.addEventListener(page, 'popup', onPopup),
    ];
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const settled = async () => {
      await Promise.all([...checks]);
      if (refusal)
        throw refusal;
    };

    try {
      let response: playwright.Response | null | undefined;
      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.timeoutMs ?? navigationTimeoutMs,
          signal: options.signal,
        });
      } catch (e) {
        // A refusal explains the failure better than the "page closed" it caused.
        await settled();
        if (!/Download is starting/i.test(e instanceof Error ? e.message : String(e)))
          throw e;
        download ??= await page.waitForEvent('download', { timeout: settleTimeoutMs }).catch(() => undefined);
        // An abort during that wait is the real reason we are here, not the
        // download that never came.
        options.signal?.throwIfAborted();
        if (!download)
          throw e;
        response = lastResponse;
      }
      await settled();

      let landed = response ?? lastResponse;
      if (landed?.headers()['cf-mitigated'] === 'challenge') {
        await waitOutChallenge(page);
        options.signal?.throwIfAborted();
        await settled();
        // The challenge resolves by re-navigating, so the document that matters
        // is the one the main frame ended on, not what `goto` returned.
        landed = lastResponse ?? landed;
      }

      return await use({ page, response: landed, download, settled });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      eventsHelper.removeEventListeners(listeners);
      await page.close().catch(() => {});
      // Nobody else would: an internal instance builds no Tab, so a window this
      // page opened is tracked by no one.
      await Promise.all([...extras].map(extra => extra.close().catch(() => {})));
      this._gate.release();
    }
  }

  async close(): Promise<void> {
    await this._instance.close().catch(() => {});
  }
}

/** Give a client-rendered page its chance to populate, without hiding an abort. */
async function settle(page: playwright.Page, signal: AbortSignal | undefined): Promise<void> {
  await page.waitForLoadState('load', { timeout: loadTimeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: settleTimeoutMs }).catch(() => {});
  signal?.throwIfAborted();
}

/**
 * Cloudflare answers with 403 and `cf-mitigated: challenge`, runs Turnstile in
 * the page, then re-navigates to the same URL by POST. Waiting for that is all
 * a real browser does, so nothing here solves anything. The interactive variant
 * -- a checkbox, or an image CAPTCHA -- is deliberately not handled: that wants
 * browser_open and a click on the frame's ref, which the agent can do itself.
 */
async function waitOutChallenge(page: playwright.Page): Promise<void> {
  await page.waitForResponse(
    response => response.frame() === page.mainFrame() &&
      response.request().isNavigationRequest() &&
      response.headers()['cf-mitigated'] !== 'challenge',
    { timeout: challengeTimeoutMs },
  ).catch(() => {});
}

/**
 * Bounds concurrent pages. A queued waiter is rejected on abort rather than
 * left parked, or an aborted crawl would never settle.
 */
export class PageGate {
  private _active = 0;
  private _waiting: (() => void)[] = [];

  async acquire(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (this._active < maxConcurrentPages) {
      this._active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        this._active++;
        resolve();
      };
      const onAbort = () => {
        const index = this._waiting.indexOf(wake);
        if (index !== -1)
          this._waiting.splice(index, 1);
        reject(signal!.reason);
      };
      this._waiting.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this._active--;
    this._waiting.shift()?.();
  }
}

/**
 * Chromium's PDF viewer answers the navigation with an extension shell, so
 * `response.body()` returns that shell rather than the file. Refetching from
 * inside the page is the way to the real bytes.
 */
async function readPdf(page: playwright.Page): Promise<{ kind: 'binary'; bytes: Buffer }> {
  const fetched = await page.evaluate(async () => {
    const response = await fetch(location.href, { cache: 'force-cache' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    // 32K at a time: spreading a whole PDF into fromCharCode overflows the
    // argument stack.
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { url: response.url, base64: btoa(binary) };
  });
  // The refetch follows its own redirects, and the listener only polices
  // navigations, so the URL it actually landed on is checked here.
  if (fetched.url !== page.url())
    await assertUrlAllowed(fetched.url, { allowPrivate: false });
  return { kind: 'binary', bytes: Buffer.from(fetched.base64, 'base64') };
}

/**
 * An attachment aborts the navigation instead of producing a document. The
 * bytes must be read before the page closes, since Playwright deletes a
 * context's downloads with it.
 */
async function readDownload(
  download: playwright.Download,
  response: playwright.Response | undefined,
): Promise<FetchedPage> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk as Buffer);
  return {
    url: download.url(),
    status: response?.status(),
    contentType: mediaType(response?.headers()['content-type']),
    kind: 'binary',
    bytes: Buffer.concat(chunks),
    filename: download.suggestedFilename(),
  };
}

/**
 * Both entry points refuse the URL before taking a lease, or a typo'd scheme
 * would cost a cold browser launch and leave it running for the idle window.
 * `withPage` checks again, since it is reachable directly.
 */
export async function fetchPage(host: ServerHost, url: string, options: FetchOptions = {}): Promise<FetchedPage> {
  await assertUrlAllowed(url, { allowPrivate: true });
  return await host.withRenderer(renderer => renderer.fetchPage(url, options));
}

export async function printPdf(host: ServerHost, url: string, options: FetchOptions = {}): Promise<{ url: string; data: Buffer }> {
  await assertUrlAllowed(url, { allowPrivate: true });
  return await host.withRenderer(renderer => renderer.printPdf(url, options));
}
