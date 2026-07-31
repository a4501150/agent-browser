import fs from 'node:fs';
import path from 'node:path';

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

/**
 * Results longer than this are written to a file and returned as a link instead
 * of being inlined into the tool result.
 */
export const inlineResultLimit = 24_000;

/** How often the artifact directory is actually walked. */
const sweepIntervalMs = 60_000;

export class Artifacts {
  readonly dir: string;
  private _ttlMs: number;
  private _sweeping: Promise<void> | undefined;
  private _lastSweep = 0;

  constructor(dir: string, options?: { ttlMs?: number }) {
    this.dir = dir;
    this._ttlMs = options?.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  fileName(template: FilenameTemplate): string {
    if (template.suggestedFilename)
      return sanitizeForFilePath(template.suggestedFilename);
    const stamp = (template.date ?? new Date()).toISOString().replace(/[:.]/g, '-');
    return `${template.prefix}-${stamp}${template.ext ? '.' + template.ext : ''}`;
  }

  async outputFile(template: FilenameTemplate): Promise<string> {
    const resolved = path.resolve(this.dir, this.fileName(template));
    if (!isPathInside(this.dir, resolved))
      throw new Error(`File access denied: ${resolved} is outside the artifact directory ${this.dir}`);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  async write(file: string, data: Buffer | string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    if (typeof data === 'string')
      await fs.promises.writeFile(file, data, 'utf-8');
    else
      await fs.promises.writeFile(file, data);
  }

  /**
   * Called after every tool result, so it must be nearly free in the common
   * case: a full directory walk plus a stat per file runs at most once per
   * interval, and concurrent callers share one walk.
   */
  async maybeSweep(): Promise<void> {
    if (this._sweeping)
      return this._sweeping;
    if (Date.now() - this._lastSweep < sweepIntervalMs)
      return;
    this._sweeping = this._sweep().finally(() => {
      this._lastSweep = Date.now();
      this._sweeping = undefined;
    });
    return this._sweeping;
  }

  /** Drop expired files. */
  private async _sweep(): Promise<void> {
    let entries: { path: string; mtimeMs: number }[];
    try {
      entries = await listFilesRecursive(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.mtimeMs > this._ttlMs)
        await fs.promises.unlink(entry.path).catch(() => {});
    }
  }
}

export function resolveClientPath(cwd: string, file: string): string {
  return path.resolve(cwd, file);
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sanitizeForFilePath(s: string): string {
  // Control characters are deliberately in range: a web-supplied download name
  // is untrusted, and only [-.0-9A-Za-z_] survives.
  // eslint-disable-next-line no-control-regex
  const sanitize = (v: string) => v.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = s.lastIndexOf('.');
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

async function listFilesRecursive(dir: string): Promise<{ path: string; mtimeMs: number }[]> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter(e => e.isFile());
  return Promise.all(files.map(async e => {
    const full = path.join(e.parentPath, e.name);
    const { mtimeMs } = await fs.promises.stat(full);
    return { path: full, mtimeMs };
  }));
}
