#!/usr/bin/env node
/**
 * Compile the MCP server into a single-file executable and package it as the
 * release asset free-code vendors (see free-code scripts/agentBrowser.ts).
 *
 * One executable per platform: scripts/compile-server.mjs bundles node_modules
 * and the imported manifest.json via Bun.build, so end users need neither Node
 * nor Bun installed. bun cross-compiles, so all three assets can be produced
 * from one machine (`--target bun-darwin-arm64 | bun-linux-x64 | bun-windows-x64`).
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
import os from 'node:os';
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

const EXPECTED_TOOL_COUNT = 32; // src/mcp: 32 tools, all always on (see CLAUDE.md).

function runCapture(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error(`${cmd} exited with ${code} (stderr: ${stderr})`)));
  });
}

/**
 * Complete an MCP handshake over stdio with a running server child. This is
 * the only check that the compile did not silently drop something
 * playwright-core needs (dynamic requires, worker payload).
 */
async function handshake(child) {
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
  if (init.result.serverInfo.version !== version)
    throw new Error(`server reports ${init.result.serverInfo.version}, archive is ${version}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await nextMessage(2);
  if (!Array.isArray(tools.result?.tools))
    throw new Error(`bad tools/list result: ${JSON.stringify(tools).slice(0, 500)}`);
  if (tools.result.tools.length !== EXPECTED_TOOL_COUNT)
    throw new Error(`tools/list returned ${tools.result.tools.length} tools, expected ${EXPECTED_TOOL_COUNT}`);
  child.stdin.end();
  child.kill();
  return `${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${tools.result.tools.length} tools`;
}

/**
 * Smoke-test the packaged asset, not the build tree: extract the exact archive
 * into a temp dir, run it from an unrelated cwd, and keep the repo's own
 * node_modules/playwright-core moved out of the way for the duration. Without
 * the eviction the binary can still lazily read the build host's copy of
 * package.json / browsers.json and pass while being un-relocatable;
 * scripts/compile-server.mjs is what makes this pass honestly.
 */
async function smokeTestArchive(archive, exe) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-smoke-'));
  const pwDir = path.join(repoRoot, 'node_modules', 'playwright-core');
  const pwEvicted = path.join(repoRoot, 'node_modules', 'playwright-core.smoke-evicted');
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir);
  const restore = () => {
    if (fs.existsSync(pwEvicted) && !fs.existsSync(pwDir))
      fs.renameSync(pwEvicted, pwDir);
  };
  // Ctrl-C during the eviction window must not leave playwright-core renamed;
  // drop the handler first so the re-raised signal takes the default action.
  const onSignal = signal => {
    process.removeListener(signal, onSignal);
    restore();
    process.kill(process.pid, signal);
  };
  try {
    if (fs.existsSync(pwEvicted))
      throw new Error(`${pwEvicted} exists; remove it before packaging (a previous interrupted run?).`);
    if (!fs.existsSync(pwDir))
      throw new Error(`${pwDir} is missing; install dependencies before packaging.`);
    await run('tar', ['-xzf', archive, '-C', extractDir]);
    const extracted = path.join(extractDir, exe);
    if (!fs.existsSync(extracted))
      throw new Error(`archive did not contain ${exe} at its root`);

    fs.renameSync(pwDir, pwEvicted);
    process.on('exit', restore);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const printed = await runCapture(extracted, ['--version'], { cwd: tmp });
      if (printed !== `${version}\n`)
        throw new Error(`--version printed ${JSON.stringify(printed)}, expected ${JSON.stringify(`${version}\n`)}`);
      const summary = await handshake(spawnChild(extracted, tmp));
      process.stdout.write(`smoke:      ok (extracted archive, playwright-core evicted, foreign cwd; ${summary})\n`);
    }
    finally {
      process.removeListener('exit', restore);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      restore();
    }
  }
  finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function spawnChild(exe, cwd) {
  return spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { platform, exe } = TARGETS[args.target];

  const buildDir = path.join(args.out, '.server-build', platform);
  fs.mkdirSync(buildDir, { recursive: true });
  const executable = path.join(buildDir, exe);
  // Bun.build via scripts/compile-server.mjs, not `bun build --compile`: the
  // build there patches playwright-core's __dirname-derived packageRoot and
  // its dynamic package.json / browsers.json requires into static literals,
  // so the binary does not secretly depend on this machine's node_modules.
  await run('bun', [path.join(repoRoot, 'scripts', 'compile-server.mjs'),
    `--target=${args.target}`, `--outfile=${executable}`]);

  fs.mkdirSync(args.out, { recursive: true });
  const name = `agent-browser_${version}_${platform}.tar.gz`;
  const archive = path.join(args.out, name);
  await createReproducibleTarGz(archive, buildDir, exe);

  // Smoke the extracted archive, not the build tree — the build dir sits
  // inside the repo, where a stray host-path read would go unnoticed.
  if (args.smoke && args.target === defaultTarget()) {
    await smokeTestArchive(archive, exe);
  }
  else {
    process.stdout.write('smoke:      skipped (cross target or --no-smoke, run the host asset to verify)\n');
  }

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
