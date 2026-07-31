import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The patched Chromium under test. There is no fallback to a stock browser: the
 * whole point is the patches, so a missing binary must fail loudly.
 */
export function patchedChromium(): string {
  const fromEnv = process.env.AGENT_BROWSER_BINARY;
  if (fromEnv)
    return fromEnv;
  return '/Users/jinyangli/src/chromium-build/build/src/out/Default/Chromium.app/Contents/MacOS/Chromium';
}

export type ToolResult = {
  isError: boolean;
  text: string;
  images: number;
  /** The `### <name>` sections of the rendered result. */
  section: (name: string) => string | undefined;
};

export type Harness = {
  listTools: () => Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Open an ephemeral-profile instance and remember it for cleanup. */
  open: (args?: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
};

export async function startHarness(options?: { extraArgs?: string[] }): Promise<Harness> {
  const binary = patchedChromium();
  if (!fs.existsSync(binary))
    throw new Error(`Patched Chromium not found at ${binary}. Set AGENT_BROWSER_BINARY.`);

  const entry = path.join(repoRoot, 'dist', 'index.js');
  if (!fs.existsSync(entry))
    throw new Error(`${entry} is missing. Run "npm run build" first.`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-test-'));
  const client = new Client({ name: 'agent-browser-tests', version: '0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--binary', binary, '--data-dir', dataDir, ...(options?.extraArgs ?? [])],
    stderr: 'inherit',
  }));

  const opened: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    return {
      isError: !!result.isError,
      text,
      images: content.filter(c => c.type === 'image').length,
      section: (sectionName: string) => {
        const found = text.split(/^### /m).slice(1).find(s => s.startsWith(sectionName + '\n'));
        return found ? found.slice(sectionName.length + 1).trim() : undefined;
      },
    };
  };

  return {
    listTools: async () => (await client.listTools()).tools as any,
    call,
    open: async (args = {}) => {
      const result = await call('browser_open', { profile: null, ...args });
      if (result.isError)
        throw new Error(`browser_open failed: ${result.text}`);
      const id = JSON.parse(result.section('Result')!).instance_id as string;
      opened.push(id);
      return id;
    },
    close: async () => {
      for (const id of opened)
        await call('browser_close', { instance_id: id }).catch(() => {});
      await client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * The MCP stdio transport filters the environment to a safe default set, so
 * anything the server needs has to be handed over explicitly -- and its type
 * rejects the undefined values `process.env` is declared to hold.
 */
export function childEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** The ref on the outline line that mentions `needle`, e.g. `e3` or `f1e3`. */
export function refFor(outline: string, needle: string): string | undefined {
  const line = outline.split('\n').find(l => l.includes(needle));
  return line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
}
