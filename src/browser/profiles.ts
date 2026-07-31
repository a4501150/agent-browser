import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { paths } from '../config';
import { chromiumOwnerPid, isProcessAlive, tryLock as tryLockFile } from '../util/lockfile';

import type { Config } from '../config';

const execFileAsync = promisify(execFile);

const lockFileName = '.agent-browser.lock';
const seedFileName = '.agent-browser-seed';

export type ProfileChoice = {
  userDataDir: string;
  kind: 'explicit' | 'named' | 'slot' | 'temp';
  /** `--fingerprint` value to launch with, or undefined for stock behaviour. */
  seed: string | undefined;
  release: () => Promise<void>;
};

/**
 * Chromium's ProcessSingleton forbids two processes sharing one user-data dir,
 * and explicit instances make concurrent browsers ordinary. So a named profile
 * is used *directly* whenever it is free — no copying, no merging, cookies and
 * logins simply accumulate — and only concurrency forces a copy-on-write clone
 * into an ephemeral slot.
 */
export async function acquireProfile(
  config: Config,
  options: { profile?: string | null; userDataDir?: string; fingerprint?: number | string },
): Promise<ProfileChoice> {
  if (options.userDataDir) {
    const dir = path.resolve(options.userDataDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const lock = await tryLockProfile(dir);
    if (!lock)
      throw new Error(`user_data_dir "${dir}" is already in use by a live browser. Close it, or omit user_data_dir to get an ephemeral clone.`);
    return {
      userDataDir: dir,
      kind: 'explicit',
      seed: await resolveSeed(dir, options.fingerprint),
      release: async () => { await lock.release(); },
    };
  }

  if (options.profile === null) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-browser-'));
    return {
      userDataDir: dir,
      kind: 'temp',
      seed: options.fingerprint === undefined ? undefined : String(options.fingerprint),
      release: async () => { await fs.promises.rm(dir, { recursive: true, force: true }); },
    };
  }

  const name = sanitizeProfileName(options.profile || 'default');
  const canonicalDir = path.join(paths.profiles(config), name);
  await fs.promises.mkdir(canonicalDir, { recursive: true });
  const seed = await resolveSeed(canonicalDir, options.fingerprint);

  const directLock = await tryLockProfile(canonicalDir);
  if (directLock) {
    return {
      userDataDir: canonicalDir,
      kind: 'named',
      seed,
      release: async () => { await directLock.release(); },
    };
  }

  // Busy: clone into a free slot, reusing one before creating another.
  const slotsDir = paths.slots(config);
  await fs.promises.mkdir(slotsDir, { recursive: true });
  for (let i = 1; i <= 64; i++) {
    const slot = path.join(slotsDir, `${name}-${i}`);
    const existed = fs.existsSync(slot);
    if (existed) {
      const lock = await tryLockProfile(slot);
      if (!lock)
        continue;
      // Free slot: refresh it from the canonical profile before reuse.
      await lock.release();
      await fs.promises.rm(slot, { recursive: true, force: true });
    }
    await cloneDir(canonicalDir, slot);
    // The clone carries the origin's stale lock file; drop it before locking.
    await fs.promises.rm(path.join(slot, lockFileName), { force: true });
    await fs.promises.rm(path.join(slot, 'SingletonLock'), { force: true });
    const lock = await tryLockProfile(slot);
    if (!lock)
      continue;
    return {
      userDataDir: slot,
      kind: 'slot',
      seed,
      release: async () => {
        await lock.release();
        await fs.promises.rm(slot, { recursive: true, force: true });
      },
    };
  }
  throw new Error(`Could not find a free profile slot for "${name}" (64 in use).`);
}

/** Free only if neither we nor Chromium itself hold the directory. */
async function tryLockProfile(dir: string) {
  const chromiumOwner = chromiumOwnerPid(dir);
  if (chromiumOwner && isProcessAlive(chromiumOwner))
    return undefined;
  return await tryLockFile(path.join(dir, lockFileName));
}

/**
 * A profile's identity must be stable for its lifetime, so a seed given once is
 * persisted and reused. Absent a seed the browser gets no `--fingerprint` at
 * all, which is the only way it behaves exactly like stock Chrome.
 */
async function resolveSeed(dir: string, fingerprint: number | string | undefined): Promise<string | undefined> {
  const file = path.join(dir, seedFileName);
  if (fingerprint !== undefined) {
    const seed = String(fingerprint);
    await fs.promises.writeFile(file, seed, 'utf-8');
    return seed;
  }
  try {
    const seed = (await fs.promises.readFile(file, 'utf-8')).trim();
    return seed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy-on-write where the filesystem offers it, so cloning a several-hundred-MB
 * profile costs almost nothing: APFS `clonefile` via `cp -Rc` on macOS,
 * `--reflink=auto` on Linux. Falls back to a plain recursive copy.
 */
async function cloneDir(src: string, dst: string): Promise<void> {
  const attempts: [string, string[]][] = process.platform === 'darwin'
    ? [['cp', ['-Rc', src, dst]], ['cp', ['-R', src, dst]]]
    : [['cp', ['-a', '--reflink=auto', src, dst]], ['cp', ['-a', src, dst]]];
  let lastError: unknown;
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (e) {
      lastError = e;
      await fs.promises.rm(dst, { recursive: true, force: true });
    }
  }
  await fs.promises.cp(src, dst, { recursive: true }).catch(() => { throw lastError; });
}

function sanitizeProfileName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!clean)
    throw new Error(`Invalid profile name: "${name}"`);
  return clean;
}
