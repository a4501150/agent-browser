import crypto from 'node:crypto';
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createServer, serverInfo } from './server';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { App } from './app';

export type ServeOptions = {
  port: number;
  host: string;
  token?: string;
};

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

export async function runHttp(app: App, options: ServeOptions): Promise<void> {
  const token = options.token ?? process.env.AGENT_BROWSER_TOKEN;
  if (!loopbackHosts.has(options.host) && !token) {
    throw new Error(
      `Refusing to listen on ${options.host} without a token: anyone who can reach that address could drive your ` +
      'browser and read your logged-in sessions. Set AGENT_BROWSER_TOKEN, or bind 127.0.0.1.');
  }

  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: serverInfo,
        instances: app.instances.list().length,
        sessions: sessions.size,
      }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is /mcp.' }));
      return;
    }

    if (token && !isAuthorized(req, token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (sessionId) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown session ${sessionId}` }));
      return;
    }

    // A request with no session id must be an initialize; give it a session.
    const server = createServer(app);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string): void => { sessions.set(id, { server, transport }); },
    });
    transport.onclose = () => {
      if (transport.sessionId)
        sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  process.stderr.write(`agent-browser: listening on http://${options.host}:${port}/mcp (health at /health)\n`);
  if (token)
    process.stderr.write('agent-browser: bearer token required\n');

  await new Promise<void>(resolve => {
    const shutdown = () => resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  for (const session of sessions.values())
    await session.server.close().catch(() => {});
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(token);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
