#!/usr/bin/env node
/**
 * Package a built patched Chromium into the release asset the manifest points
 * at, and print the sha256 to paste back into src/browser/manifest.json.
 *
 * The archive is .tar.gz, not .zip, on purpose: the app bundle contains
 * symlinks (including Chromium Framework.framework/Versions/Current) and
 * executable bits, and a naive zip extractor silently breaks the bundle.
 *
 * Usage
 *   node scripts/package-binary.mjs --app <path to Chromium.app> [--out <dir>]
 *
 * The asset is never committed to git; upload it to a GitHub release.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { app: process.env.AGENT_BROWSER_APP, out: path.join(repoRoot, 'release') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app')
      args.app = argv[++i];
    else if (argv[i] === '--out')
      args.out = argv[++i];
    else if (argv[i] === '--help') {
      process.stdout.write('Usage: node scripts/package-binary.mjs --app <Chromium.app> [--out <dir>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`Unknown option "${argv[i]}"\n`);
      process.exit(2);
    }
  }
  return args;
}

/** tar | gzip -n, spawned directly so no shell quoting is involved. */
async function pipeThrough(archive, parent, name) {
  const tar = spawn('tar', ['-cf', '-', '-C', parent, name], { stdio: ['ignore', 'pipe', 'inherit'] });
  const gzip = spawn('gzip', ['-9', '-n'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = fs.createWriteStream(archive);
  const exits = [tar, gzip].map(child => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${child.spawnfile} exited with ${code}`)));
  }));
  await Promise.all([pipeline(tar.stdout, gzip.stdin), pipeline(gzip.stdout, out), ...exits]);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app)
    throw new Error('Pass --app <Chromium.app>, or set AGENT_BROWSER_APP.');
  const app = path.resolve(args.app);
  if (!fs.existsSync(app))
    throw new Error(`No app bundle at ${app}.`);

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'browser', 'manifest.json'), 'utf-8'));
  const platform = `${process.platform}-${process.arch}`;
  const entry = manifest.platforms[platform];
  if (!entry)
    throw new Error(`manifest.json has no entry for ${platform}.`);

  // Sanity-check the bundle before spending two minutes compressing it.
  const executable = path.join(app, entry.executable.replace(/^.*?\.app\//, ''));
  if (!fs.existsSync(executable))
    throw new Error(`${executable} is missing; that is not a usable app bundle.`);
  const { stdout: version } = await execFileAsync(executable, ['--version']).catch(() => ({ stdout: '' }));
  process.stdout.write(`app:        ${app}\n`);
  process.stdout.write(`version:    ${version.trim() || '(could not read)'}\n`);
  if (version && !version.includes(manifest.version))
    process.stderr.write(`warning: bundle reports "${version.trim()}" but manifest.json pins ${manifest.version}\n`);

  fs.mkdirSync(args.out, { recursive: true });
  const name = `chromium-${manifest.version}-${platform}.tar.gz`;
  const archive = path.join(args.out, name);

  process.stdout.write(`archiving:  ${archive}\n`);
  // -C the parent so the archive contains "Chromium.app/..." at its root, which
  // is what the resolver expects to find after extraction.
  //
  // `gzip -n` rather than `tar -czf`: gzip otherwise stamps the current time
  // into its header, so packaging the same bundle twice produces two different
  // checksums. That makes the hash you paste into the manifest depend on *which
  // run* produced the file you uploaded -- re-run the packager afterwards and
  // the manifest silently stops matching the published asset.
  await pipeThrough(archive, path.dirname(app), path.basename(app));

  const digest = await sha256(archive);
  const { size } = fs.statSync(archive);

  // Upload before pasting: a manifest that names a checksum for an asset that
  // does not exist yet turns a clear "nothing published" message into a 404.
  process.stdout.write('\n1. Upload it, under the tag the url below names:\n');
  process.stdout.write(`   gh release create chromium-${manifest.version}-${manifest.revision} ${archive} \\\n`);
  process.stdout.write(`     --title "Patched Chromium ${manifest.version} (revision ${manifest.revision})" --notes "..."\n`);
  process.stdout.write('\n2. Then paste this into src/browser/manifest.json:\n');
  process.stdout.write(JSON.stringify({
    url: `https://github.com/a4501150/agent-browser/releases/download/chromium-${manifest.version}-${manifest.revision}/${name}`,
    sha256: digest,
    size,
    app: entry.app,
    executable: entry.executable,
  }, null, 2) + '\n');
  process.stdout.write('\n3. Then rebuild and verify from a cold cache, with no --binary\n');
  process.stdout.write('   and no AGENT_BROWSER_BINARY set, before committing the manifest.\n');
}

main().catch(error => {
  process.stderr.write(`package-binary: ${error?.message ?? error}\n`);
  process.exit(1);
});
