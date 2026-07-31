import fs from 'node:fs';
import path from 'node:path';

export type Lock = { release: () => Promise<void> };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to someone else.
    return e?.code === 'EPERM';
  }
}

/**
 * A PID lockfile. A lock whose owner is dead is reclaimed rather than
 * respected, which is what makes a crashed process recoverable without manual
 * cleanup.
 */
export async function tryLock(lockPath: string): Promise<Lock | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(String(process.pid), 'utf-8');
      return { release: async () => { await fs.promises.rm(lockPath, { force: true }); } };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        // The lock file exists but we failed to write our PID into it, which
        // would leave a lock nobody can attribute or reclaim.
        if (handle)
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
        throw e;
      }
      const owner = Number((await fs.promises.readFile(lockPath, 'utf-8').catch(() => '')).trim());
      if (owner && owner !== process.pid && isProcessAlive(owner))
        return undefined;
      await fs.promises.rm(lockPath, { force: true });
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return undefined;
}

/** Wait for a lock, reclaiming it if whoever holds it has died. */
export async function waitForLock(lockPath: string, timeoutMs: number): Promise<Lock> {
  const deadline = Date.now() + timeoutMs;
  let blockedBy: number | undefined;
  while (Date.now() <= deadline) {
    const lock = await tryLock(lockPath);
    if (lock)
      return lock;
    blockedBy = Number((await fs.promises.readFile(lockPath, 'utf-8').catch(() => '')).trim()) || blockedBy;
    await new Promise(f => setTimeout(f, 1000));
  }
  throw new Error(`Timed out waiting for another agent-browser process (pid ${blockedBy}) to release ${lockPath}.`);
}

/**
 * Chromium marks ownership of a user-data directory with a `SingletonLock`
 * symlink whose target ends in `-<pid>`.
 */
export function chromiumOwnerPid(userDataDir: string): number | undefined {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
