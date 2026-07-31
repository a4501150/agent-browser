import { assertUrlAllowed } from '../util/ssrf';

const defaultUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export type HttpResult = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type HttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  retries?: number;
  signal?: AbortSignal;
};

const defaultTimeout = 30_000;
const defaultMaxBytes = 12 * 1024 * 1024;

/**
 * Redirects are followed by hand so the SSRF policy runs on every hop, not just
 * the URL the caller named.
 */
export async function httpFetch(rawUrl: string, options: HttpOptions = {}): Promise<HttpResult> {
  const maxRedirects = options.maxRedirects ?? 10;
  const retries = options.retries ?? 2;

  let current = rawUrl;
  let method = options.method ?? 'GET';
  let body = options.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertUrlAllowed(current, { allowPrivate: hop === 0 });
    const { response, dispose } = await fetchWithRetries(url, { ...options, method, body }, retries);

    const location = isRedirect(response.status) ? response.headers.get('location') : null;
    if (!location) {
      try {
        return await readResult(url.toString(), response, options);
      } finally {
        dispose();
      }
    }

    const next = new URL(location, url).toString();
    // 303, and 301/302 in practice, turn a POST into a GET.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    void response.body?.cancel().catch(() => {});
    dispose();
    current = next;
  }
  throw new Error(`Too many redirects (>${maxRedirects}) starting at ${rawUrl}`);
}

type Attempt = { response: globalThis.Response; dispose: () => void };

/**
 * The timeout and the caller's abort signal must stay armed through the body
 * read, not just until the headers arrive: a server that sends headers and then
 * stalls would otherwise hold a crawl worker forever. `dispose` is therefore
 * the caller's to call, once the body has been consumed.
 */
async function fetchWithRetries(url: URL, options: HttpOptions, retries: number): Promise<Attempt> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? defaultTimeout);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': defaultUserAgent,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...(options.body instanceof URLSearchParams ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...options.headers,
        },
        body: options.body as any,
        redirect: 'manual',
        signal: controller.signal,
      });
      // Retry only what a retry can fix.
      if (response.status >= 500 && attempt < retries) {
        void response.body?.cancel().catch(() => {});
        dispose();
        lastError = new Error(`${response.status} ${response.statusText}`);
        await backoff(attempt);
        continue;
      }
      return { response, dispose };
    } catch (e) {
      dispose();
      lastError = e;
      if (options.signal?.aborted)
        throw e;
      if (attempt >= retries)
        break;
      await backoff(attempt);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function readResult(url: string, response: globalThis.Response, options: HttpOptions): Promise<HttpResult> {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done)
          break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { url, status: response.status, headers, body: Buffer.concat(chunks) };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function backoff(attempt: number): Promise<void> {
  return new Promise(f => setTimeout(f, 250 * Math.pow(2, attempt)));
}

/** Decode a body using the charset the server declared, falling back to UTF-8. */
export function decodeBody(result: HttpResult): string {
  const contentType = result.headers['content-type'] ?? '';
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const sniffed = declared ?? sniffMetaCharset(result.body);
  const encoding = normalizeEncoding(sniffed);
  try {
    return new TextDecoder(encoding).decode(result.body);
  } catch {
    return result.body.toString('utf-8');
  }
}

function sniffMetaCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
}

function normalizeEncoding(encoding: string | undefined): string {
  if (!encoding)
    return 'utf-8';
  const lower = encoding.toLowerCase();
  return lower === 'utf8' ? 'utf-8' : lower;
}
