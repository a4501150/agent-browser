/**
 * Instance lifecycle: the idle reaper, and reaping browsers orphaned by a
 * server that was killed. The second is not optional — an MCP server is
 * routinely SIGKILLed by its client, and a leaked Chromium holds a profile lock
 * and hundreds of megabytes of memory until the machine reboots.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { childEnv, patchedChromium } from './helpers/client';
import { Artifacts } from '../src/util/artifacts';
import { isProcessAlive } from '../src/browser/profiles';
import { Registry, reaperIntervalMs } from '../src/browser/registry';
import { resolveConfig } from '../src/config';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup();
});

type Session = {
  client: Client;
  dataDir: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; section: (n: string) => string | undefined }>;
};

async function connect(dataDir: string, args: string[] = []): Promise<Session> {
  const client = new Client({ name: 'lifecycle', version: '0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--binary', patchedChromium(), '--data-dir', dataDir, ...args],
    env: childEnv(),
    stderr: 'inherit',
  }));
  const call = async (name: string, callArgs: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: callArgs });
    const text = ((result.content ?? []) as { type: string; text?: string }[])
      .filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    return {
      isError: !!result.isError,
      text,
      section: (n: string) => {
        const found = text.split(/^### /m).slice(1).find(s => s.startsWith(n + '\n'));
        return found ? found.slice(n.length + 1).trim() : undefined;
      },
    };
  };
  return { client, dataDir, call };
}

function chromiumPid(userDataDir: string): number | undefined {
  try {
    const pid = Number(fs.readlinkSync(path.join(userDataDir, 'SingletonLock')).split('-').pop());
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate())
      return true;
    await new Promise(f => setTimeout(f, 250));
  }
  return predicate();
}

describe('idle reaper', () => {
  it('closes an instance left idle past its timeout', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-idle-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const session = await connect(dataDir, ['--idle-timeout', '1']);
    cleanups.push(() => void session.client.close());

    const opened = await session.call('browser_open', { profile: null });
    const summary = JSON.parse(opened.section('Result')!);
    const pid = chromiumPid(summary.user_data_dir);
    expect(pid).toBeDefined();

    const gone = await waitUntil(() => !isProcessAlive(pid!), reaperIntervalMs * 2 + 5000);
    expect(gone, 'the idle browser process should have been closed').toBe(true);
    expect((await session.call('browser_list')).section('Result')).toMatch(/No browser instances/);
  }, 90_000);

  it('leaves instances alone when the timeout is 0', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-noidle-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const session = await connect(dataDir, ['--idle-timeout', '0']);

    const opened = await session.call('browser_open', { profile: null });
    const id = JSON.parse(opened.section('Result')!).instance_id;
    await new Promise(f => setTimeout(f, reaperIntervalMs + 2000));
    expect((await session.call('browser_list')).section('Result')).toContain(id);
    await session.call('browser_close', { instance_id: id });
    await session.client.close();
  }, 90_000);
});

describe('orphan reaping', () => {
  it('does not need to reap after an ordinary kill, because the browser dies with its server', async () => {
    // Worth pinning: Playwright drives Chromium over --remote-debugging-pipe, so
    // when the server process dies the pipe closes and Chromium exits by itself.
    // A SIGKILLed server therefore leaks nothing, and reapOrphans below is
    // insurance for the cases where a browser does outlive its parent (a hung
    // renderer, a lost machine) rather than the common path.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-kill-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const client = new Client({ name: 'kill', version: '0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--binary', patchedChromium(), '--data-dir', dataDir, '--idle-timeout', '0'],
      env: childEnv(),
      stderr: 'inherit',
    });
    await client.connect(transport);
    const opened = await client.callTool({ name: 'browser_open', arguments: { profile: null } });
    const text = ((opened.content ?? []) as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n');
    const summary = JSON.parse(text.split('### Result\n')[1].split('###')[0]);
    const browserPid = chromiumPid(summary.user_data_dir)!;
    expect(isProcessAlive(browserPid)).toBe(true);

    const serverPid = (transport as any)._process?.pid as number;
    process.kill(serverPid, 'SIGKILL');
    cleanups.push(() => { try { process.kill(browserPid, 'SIGKILL'); } catch { /* already gone */ } });

    expect(await waitUntil(() => !isProcessAlive(browserPid), 15_000)).toBe(true);
  }, 120_000);

  it('kills a recorded orphan, and spares a process that no longer owns the directory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-reap-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    // Two stand-in "browsers" that will sit still until killed.
    const orphan = spawn('sleep', ['300'], { stdio: 'ignore' });
    const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
    cleanups.push(() => { orphan.kill('SIGKILL'); bystander.kill('SIGKILL'); });
    await waitUntil(() => !!orphan.pid && !!bystander.pid, 5000);

    // The orphan owns its directory, the way Chromium marks ownership.
    const orphanDir = path.join(dataDir, 'profiles', '.slots', 'reaped-1');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.symlinkSync(`host-${orphan.pid}`, path.join(orphanDir, 'SingletonLock'));

    // The bystander is recorded, but the directory names a different pid --
    // exactly the case where a pid has been reused by something unrelated.
    const bystanderDir = path.join(dataDir, 'profiles', 'not-ours');
    fs.mkdirSync(bystanderDir, { recursive: true });
    fs.symlinkSync('host-999999', path.join(bystanderDir, 'SingletonLock'));

    fs.writeFileSync(path.join(dataDir, 'processes.json'), JSON.stringify([
      { pid: orphan.pid, userDataDir: orphanDir, ephemeral: true, startedAt: Date.now() },
      { pid: bystander.pid, userDataDir: bystanderDir, ephemeral: false, startedAt: Date.now() },
    ]));

    const registry = new Registry(resolveConfig({ dataDir }), new Artifacts(path.join(dataDir, 'artifacts')));
    const killed = await registry.reapOrphans();

    expect(killed).toBe(1);
    expect(await waitUntil(() => !isProcessAlive(orphan.pid!), 10_000)).toBe(true);
    expect(isProcessAlive(bystander.pid!), 'a process that does not own the directory must be spared').toBe(true);
    // An ephemeral directory is cleaned up; a named profile is never deleted.
    expect(fs.existsSync(orphanDir)).toBe(false);
    expect(fs.existsSync(bystanderDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'processes.json'), 'utf-8'))).toEqual([]);
  }, 60_000);

  it('reclaims a profile lock whose owner is dead', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-lock-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const profileDir = path.join(dataDir, 'profiles', 'stale-lock-test');
    fs.mkdirSync(profileDir, { recursive: true });
    // A PID that cannot be running: pid 0 is never a user process.
    fs.writeFileSync(path.join(profileDir, '.agent-browser.lock'), '999999');

    const session = await connect(dataDir);
    cleanups.push(() => void session.client.close());
    const opened = await session.call('browser_open', { profile: 'stale-lock-test' });
    expect(opened.isError, opened.text).toBe(false);
    // The canonical directory was reused, not cloned into a slot.
    expect(JSON.parse(opened.section('Result')!).user_data_dir).toBe(profileDir);
    await session.call('browser_close', { instance_id: JSON.parse(opened.section('Result')!).instance_id });
  }, 90_000);
});
