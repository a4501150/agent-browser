import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export type Fixtures = {
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  url: (file: string) => string;
  /**
   * A parent page on `localhost` whose iframe is on `127.0.0.1`. Those are
   * different *sites*, so desktop Chromium's default site isolation puts the
   * iframe in its own process — a real out-of-process iframe, with no launch
   * flags needed. Two *ports* on one host would not do: they are cross-origin
   * but same-site, so they share a process.
   */
  crossSiteUrl: () => string;
  close: () => Promise<void>;
};

/** Serves tests/fixtures over HTTP. The Host header is ignored. */
export async function startFixtures(): Promise<Fixtures> {
  let port = 0;
  const server = http.createServer((req, res) => {
    const requested = (req.url ?? '/').split('?')[0];
    const name = requested === '/' ? 'page.html' : requested.replace(/^\/+/, '');
    const file = path.join(fixtures, name);
    if (!file.startsWith(fixtures)) {
      res.writeHead(403).end('no');
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
      return;
    }
    // The sitemap has to name the port it is being served on.
    if (file.endsWith('.xml'))
      body = Buffer.from(body.toString('utf-8').replaceAll('PORT', String(port)));
    res.writeHead(200, { 'content-type': contentType(file) });
    res.end(body);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    url: (file: string) => `http://127.0.0.1:${port}/${file.replace(/^\/+/, '')}`,
    crossSiteUrl: () => {
      const child = encodeURIComponent(`http://127.0.0.1:${port}/child.html`);
      return `http://localhost:${port}/parent.html?child=${child}`;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function contentType(file: string): string {
  if (file.endsWith('.xml'))
    return 'application/xml';
  if (file.endsWith('.json'))
    return 'application/json';
  return 'text/html';
}
