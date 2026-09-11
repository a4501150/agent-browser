/**
 * Reproducible .tar.gz creation shared by the packaging scripts.
 *
 * `tar | gzip -n` worked while packaging only ever ran on macOS, but Windows
 * has `tar.exe` and no gzip CLI, so the gzip step happens in-process via zlib.
 * The gzip header's MTIME field is then zeroed by hand: the default is the
 * current time, and a hash that changes every run would make the checksum
 * pasted into the manifest depend on *which run* produced the uploaded file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/**
 * Archive `parent/name` (tree) into `archive` with `name/...` at its root.
 */
export async function createReproducibleTarGz(archive, parent, name) {
  // SOURCE_DATE_EPOCH stamps every tar header with time 0 (libarchive —
  // macOS's and Windows's tar — rewrites mtimes wholesale from it; GNU tar's
  // `--mtime` is not understood by libarchive, and the in-process gzip below
  // has its MTIME field zeroed separately, so archiving byte-identical input
  // twice yields the same checksum).
  // Caveat for freshly-compiled inputs: bun stamps the build time into the
  // executable, so a *recompile* changes the bytes and the hash regardless —
  // upload the exact file a run printed, never a later re-pack.
  const tar = spawn('tar', ['-cf', '-', '-C', parent, name], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
  });
  const tarExited = new Promise((resolve, reject) => {
    tar.once('error', reject);
    tar.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
  });
  await pipeline(tar.stdout, new zlib.Gzip(), fs.createWriteStream(archive));
  await tarExited;
  await zeroGzipMtime(archive);
}

/** Overwrite the gzip MTIME field (bytes 4..7) with zeros, in place. */
async function zeroGzipMtime(archive) {
  const handle = await fs.promises.open(archive, 'r+');
  try {
    await handle.write(Buffer.alloc(4), 0, 4, 4);
  }
  finally {
    await handle.close();
  }
}

export async function sha256File(file) {
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

export function fileSize(file) {
  return fs.statSync(path.resolve(file)).size;
}
