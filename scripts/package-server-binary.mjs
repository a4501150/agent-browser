#!/usr/bin/env node
/**
 * Compile the MCP server into a single-file executable and package it as the
 * release asset free-code vendors (see free-code scripts/agentBrowser.ts).
 *
 * One executable per platform: `bun build --compile` bundles node_modules and
 * the imported manifest.json, so end users need neither Node nor Bun installed.
 * bun cross-compiles, so all three assets can be produced from one machine
 * (`--target bun-darwin-arm64 | bun-linux-x64 | bun-windows-x64`).
 *
 * Usage
 *   node scripts/package-server-binary.mjs [--target <bun-target>] [--out <dir>] [--no-smoke]
 *
 * The archive contains the executable at its root (agent-browser[.exe]);
 * the consumer extracts it into its own vendor layout. The asset is never
 * committed to git; upload it to a GitHub release tagged v<version>
 * (`gh release upload v<version> <archive> --clobber` for additional
 * platforms after the first `gh release create`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReproducibleTarGz, sha256File, fileSize } from './archive.mjs';

const { setTimeout, clearTimeout } = globalThis;

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;

// bun target -> release-asset platform key (same keys as src/browser/manifest.json).
const TARGETS = {
  'bun-darwin-arm64': { platform: 'darwin-arm64', exe: 'agent-browser' },
  'bun-linux-x64': { platform: 'linux-x64', exe: 'agent-browser' },
  'bun-windows-x64': { platform: 'win32-x64', exe: 'agent-browser.exe' },
};

function defaultTarget() {
  return `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
}

function parseArgs(argv) {
  const args = { target: defaultTarget(), out: path.join(repoRoot, 'release'), smoke: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target')
      args.target = argv[++i];
    else if (argv[i] === '--out')
      args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--no-smoke')
      args.smoke = false;
    else if (argv[i] === '--help') {
      process.stdout.write('Usage: node scripts/package-server-binary.mjs [--target <bun-target>] [--out <dir>] [--no-smoke]\n');
      process.exit(0);
    }
    else {
      process.stderr.write(`Unknown option "${argv[i]}"\n`);
      process.exit(2);
    }
  }
  if (!TARGETS[args.target])
    throw new Error(`Unsupported target "${args.target}". Known: ${Object.keys(TARGETS).join(', ')}`);
  return args;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
  });
}

/**
 * Spawn the freshly compiled executable and complete an MCP handshake over
 * stdio. This is the only check that `bun build --compile` did not silently
 * drop something playwright-core needs (dynamic requires, worker payload).
 */
async function smokeTest(executable) {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const waiters = [];
  child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      const index = waiters.findIndex(waiter => waiter.id === msg.id);
      if (index >= 0)
        waiters.splice(index, 1)[0].resolve(msg);
    }
  });
  const nextMessage = id => new Promise((resolve, reject) => {
    const fail = message => {
      const index = waiters.findIndex(waiter => waiter.id === id);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`${message} (stderr: ${stderr})`));
    };
    const timer = setTimeout(() => fail(`no response to id=${id}`), 30_000);
    child.once('exit', () => fail('server exited'));
    waiters.push({
      id,
      resolve: msg => { clearTimeout(timer); resolve(msg); },
      reject: fail,
    });
  });
  const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'package-server-binary', version: '0' },
    },
  });
  const init = await nextMessage(1);
  if (!init.result?.serverInfo?.name)
    throw new Error(`bad initialize result: ${JSON.stringify(init)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await nextMessage(2);
  if (!Array.isArray(tools.result?.tools) || tools.result.tools.length === 0)
    throw new Error(`bad tools/list result: ${JSON.stringify(tools).slice(0, 500)}`);
  process.stdout.write(`smoke:      ok (${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${tools.result.tools.length} tools)\n`);
  child.stdin.end();
  child.kill();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { platform, exe } = TARGETS[args.target];

  const buildDir = path.join(args.out, '.server-build', platform);
  fs.mkdirSync(buildDir, { recursive: true });
  const executable = path.join(buildDir, exe);
  process.stdout.write(`compiling:  bun build --compile --target ${args.target}\n`);
  // playwright-core lazily requires chromium-bidi, but only on the BiDi
  // connection path -- this server always speaks CDP to a specific executable,
  // so the module is never loaded and there is nothing to bundle. Left
  // non-external, the compile fails resolving it.
  await run('bun', ['build', '--compile', `--target=${args.target}`,
    '--external', 'chromium-bidi',
    '--outfile', executable, path.join(repoRoot, 'src', 'index.ts')]);

  if (args.target === defaultTarget()) {
    await smokeTest(executable);
  }
  else {
    process.stdout.write('smoke:      skipped (cross target, run the host asset to verify)\n');
  }

  fs.mkdirSync(args.out, { recursive: true });
  const name = `agent-browser_${version}_${platform}.tar.gz`;
  const archive = path.join(args.out, name);
  await createReproducibleTarGz(archive, buildDir, exe);

  const digest = await sha256File(archive);
  // The consumer (free-code scripts/agentBrowser.ts) verifies against this
  // sidecar, mirroring the search-tools release layout.
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
  process.stdout.write(`archive:    ${archive}\n`);
  process.stdout.write(`sha256:     ${digest}\n`);
  process.stdout.write(`size:       ${fileSize(archive)}\n`);
  process.stdout.write('\nUpload it under the tag v<version>:\n');
  process.stdout.write(`   gh release create v${version} ${archive} --title "agent-browser server ${version}" --notes "..."\n`);
  process.stdout.write(`   (additional platforms: gh release upload v${version} ${archive} --clobber)\n`);
}

main().catch(error => {
  process.stderr.write(`package-server-binary: ${error?.message ?? error}\n`);
  process.exit(1);
});
