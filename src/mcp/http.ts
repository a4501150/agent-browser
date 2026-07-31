import crypto from 'node:crypto';
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createServer, serverInfo } from './server';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { App } from './app';

type ServeOptions = {
  port: number;
  host: string;
  token?: string;
};

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

/** How long an HTTP session may sit unused before it is closed. */
const sessionIdleMs = 30 * 60 * 1000;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function runHttp(app: App, options: ServeOptions): Promise<void> {
  const token = options.token ?? process.env.AGENT_BROWSER_TOKEN;
  if (!loopbackHosts.has(options.host) && !token) {
    throw new Error(
      `Refusing to listen on ${options.host} without a token: anyone who can reach that address could drive your ` +
      'browser and read your logged-in sessions. Set AGENT_BROWSER_TOKEN, or bind 127.0.0.1.');
  }

  type Session = { server: Server; transport: StreamableHTTPServerTransport; lastActivity: number };
  const sessions = new Map<string, Session>();

  // A client that vanishes without sending DELETE would otherwise leave its
  // Server and transport retained for the life of the process.
  const expiry = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity < sessionIdleMs)
        continue;
      sessions.delete(id);
      void session.server.close().catch(() => {});
    }
  }, 60_000);
  expiry.unref?.();

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent)
        sendJson(res, 500, { error: String(error?.message ?? error) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        server: serverInfo,
        instances: app.instances.list().length,
        sessions: sessions.size,
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
      return;
    }

    if (token && !isAuthorized(req, token)) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastActivity = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (sessionId) {
      sendJson(res, 404, { error: `Unknown session ${sessionId}` });
      return;
    }

    // A request with no session id must be an initialize; give it a session.
    const server = createServer(app);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string): void => { sessions.set(id, { server, transport, lastActivity: Date.now() }); },
    });
    transport.onclose = () => {
      if (transport.sessionId)
        sessions.delete(transport.sessionId);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      // A session that never initialised has nothing to close it later.
      if (transport.sessionId)
        sessions.delete(transport.sessionId);
      await server.close().catch(() => {});
      throw e;
    }
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

  clearInterval(expiry);
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
