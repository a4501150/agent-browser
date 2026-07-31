import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server';

import type { App } from './app';

export async function runStdio(app: App): Promise<void> {
  const server = createServer(app);
  await server.connect(new StdioServerTransport());

  await new Promise<void>(resolve => {
    const shutdown = () => resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    server.onclose = shutdown;
  });

  await server.close().catch(() => {});
}
