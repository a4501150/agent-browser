import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import manifest from './manifest.json';
import { paths } from '../config';
import { waitForLock } from '../util/lockfile';

import type { Config } from '../config';

const execFileAsync = promisify(execFile);

export type PlatformEntry = {
  url: string;
  sha256: string | null;
  size: number | null;
  app: string;
  executable: string;
};

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function manifestVersion(): string {
  return `${manifest.version}-${manifest.revision}`;
}

function entryForPlatform(): PlatformEntry | undefined {
  return (manifest.platforms as Record<string, PlatformEntry>)[platformKey()];
}

/**
 * Never fall back to a stock Chromium. Every guarantee this server makes comes
 * from the browser patches, so a silent downgrade would lose them invisibly —
 * the browser would still work, just be detectable.
 */
export async function resolveBinary(config: Config): Promise<string> {
  if (config.binary)
    return normalizeExecutable(config.binary, { mustExist: true });

  const entry = entryForPlatform();
  const cacheDir = path.join(paths.chromium(config), `${manifestVersion()}`, platformKey());
  if (entry) {
    const cached = path.join(cacheDir, entry.executable);
    if (fs.existsSync(cached))
      return cached;
  }

  if (!entry) {
    throw new Error(
      `No patched Chromium build exists for ${platformKey()}. ` +
      'Only darwin-arm64 is published. Build it yourself and point at it with ' +
      '--binary <path> or AGENT_BROWSER_BINARY.');
  }
  if (!entry.sha256) {
    throw new Error(
      `No published Chromium ${manifestVersion()} asset for ${platformKey()} yet, ` +
      'so there is nothing to verify a download against. Point at a local build with ' +
      '--binary <path> or AGENT_BROWSER_BINARY.');
  }

  await downloadAndExtract(entry, cacheDir);
  const executable = path.join(cacheDir, entry.executable);
  if (!fs.existsSync(executable))
    throw new Error(`Downloaded archive did not contain ${entry.executable}.`);
  return executable;
}

/** Accept either the .app bundle or the executable inside it. */
export function normalizeExecutable(p: string, options?: { mustExist?: boolean }): string {
  let resolved = path.resolve(p);
  if (resolved.endsWith('.app'))
    resolved = path.join(resolved, 'Contents', 'MacOS', path.basename(resolved).replace(/\.app$/, ''));
  if (options?.mustExist && !fs.existsSync(resolved))
    throw new Error(`Chromium binary not found at ${resolved}.`);
  return resolved;
}

export async function downloadAndExtract(entry: PlatformEntry, cacheDir: string): Promise<void> {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  // Two concurrent MCP sessions must not download into the same directory.
  const lock = await waitForLock(path.join(cacheDir, '.download.lock'), 10 * 60 * 1000);
  try {
    // Another session may have finished while we waited for the lock.
    if (fs.existsSync(path.join(cacheDir, entry.executable)))
      return;

    const archive = path.join(cacheDir, 'download.tar.gz');
    process.stderr.write(`agent-browser: downloading patched Chromium ${manifestVersion()} for ${platformKey()} ...\n`);
    const response = await fetch(entry.url, { redirect: 'follow' });
    if (!response.ok || !response.body)
      throw new Error(`Download failed: ${response.status} ${response.statusText} for ${entry.url}`);
    await pipeline(response.body as any, fs.createWriteStream(archive));

    const actual = await sha256File(archive);
    if (actual !== entry.sha256) {
      await fs.promises.rm(archive, { force: true });
      throw new Error(`Checksum mismatch for ${entry.url}: expected ${entry.sha256}, got ${actual}.`);
    }

    await extractArchive(archive, cacheDir);
    await fs.promises.rm(archive, { force: true });
    await stripQuarantine(path.join(cacheDir, entry.app));
  } finally {
    await lock.release();
  }
}

/**
 * `tar`, not a zip reader: the app bundle contains 5 symlinks (including
 * `Chromium Framework.framework/Versions/Current`) plus executable bits, and a
 * naive zip extractor silently breaks the bundle. `tar` ships with macOS, Linux
 * and Windows 10+, so this costs no dependency.
 */
async function extractArchive(archive: string, dir: string): Promise<void> {
  await execFileAsync('tar', ['-xzf', archive, '-C', dir]);
}

/**
 * The build is `adhoc, linker-signed` with `Sealed Resources=none` and no Team
 * ID, so once it carries `com.apple.quarantine` Gatekeeper refuses to run it.
 */
async function stripQuarantine(app: string): Promise<void> {
  if (process.platform !== 'darwin' || !fs.existsSync(app))
    return;
  await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}
