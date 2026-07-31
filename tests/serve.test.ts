/**
 * `agent-browser serve`: Streamable HTTP at /mcp, a health endpoint, and the
 * refusal to expose a browser-driving server on a non-loopback address without
 * a token.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { patchedChromium } from './helpers/client';

import type { ChildProcess } from 'node:child_process';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

type Served = { child: ChildProcess; port: number; stderr: string[] };

async function serve(args: string[], env: Record<string, string> = {}): Promise<Served> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-serve-'));
  const child = spawn(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--binary', await patchedChromium(), ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start:\n${stderr.join('')}`)), 20_000);
    child.stderr!.on('data', chunk => {
      const text = String(chunk);
      stderr.push(text);
      const match = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code}:\n${stderr.join('')}`));
    });
  });
  return { child, port, stderr };
}

let served: Served;

beforeAll(async () => {
  served = await serve(['--port', '0']);
});

afterAll(async () => {
  served?.child.kill('SIGTERM');
});

describe('serve', () => {
  it('answers GET /health', async () => {
    const response = await fetch(`http://127.0.0.1:${served.port}/health`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.status).toBe('ok');
    expect(body.server.name).toBe('agent-browser');
  });

  it('404s an unknown path and points at /mcp', async () => {
    const response = await fetch(`http://127.0.0.1:${served.port}/nope`);
    expect(response.status).toBe(404);
    expect((await response.json() as any).error).toMatch(/\/mcp/);
  });

  it('completes an MCP initialize and lists all 32 tools over Streamable HTTP', async () => {
    const client = new Client({ name: 'serve-test', version: '0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${served.port}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(32);
    // And a tool actually runs over this transport.
    const result = await client.callTool({ name: 'browser_list', arguments: {} });
    expect((result.content as any[])[0].text).toMatch(/No browser instances are open/);
    await client.close();
  });

  it('rejects an unknown session id rather than silently starting a new one', async () => {
    const response = await fetch(`http://127.0.0.1:${served.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-session-id': 'not-a-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a non-loopback bind without a token, naming the reason', async () => {
    await expect(serve(['--host', '0.0.0.0', '--port', '0'], { AGENT_BROWSER_TOKEN: '' }))
      .rejects.toThrow(/Refusing to listen|token/);
  });

  it('requires the bearer token when one is set', async () => {
    const tokened = await serve(['--port', '0'], { AGENT_BROWSER_TOKEN: 'sekrit' });
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${tokened.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthorized.status).toBe(401);

      const client = new Client({ name: 'serve-token-test', version: '0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${tokened.port}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer sekrit' } },
      }));
      expect((await client.listTools()).tools).toHaveLength(32);
      await client.close();
    } finally {
      tokened.child.kill('SIGTERM');
    }
  });
});
