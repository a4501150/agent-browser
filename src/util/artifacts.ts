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

export class Artifacts {
  readonly dir: string;
  private _maxBytes: number;
  private _ttlMs: number;
  /** Files this process wrote; never evicted by the budget sweep. */
  private _written = new Set<string>();

  constructor(dir: string, options?: { maxBytes?: number; ttlMs?: number }) {
    this.dir = dir;
    this._maxBytes = options?.maxBytes ?? 256 * 1024 * 1024;
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
    this._written.add(path.resolve(file));
  }

  /** Drop expired files, then oldest-first until the directory fits the quota. */
  async sweep(): Promise<void> {
    let entries: { path: string; size: number; mtimeMs: number }[];
    try {
      entries = await listFilesRecursive(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    const survivors: typeof entries = [];
    let total = 0;
    for (const entry of entries) {
      if (!this._written.has(entry.path) && now - entry.mtimeMs > this._ttlMs) {
        await fs.promises.unlink(entry.path).catch(() => {});
        continue;
      }
      survivors.push(entry);
      total += entry.size;
    }
    if (total <= this._maxBytes)
      return;
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of survivors) {
      if (total <= this._maxBytes)
        break;
      if (this._written.has(entry.path))
        continue;
      try {
        await fs.promises.unlink(entry.path);
        total -= entry.size;
      } catch {
        // Racing another sweep is fine.
      }
    }
  }
}

/**
 * A client-supplied path, for tools that read from disk (upload, session load)
 * or write where the client asked. Relative paths resolve against `cwd`.
 */
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

async function listFilesRecursive(dir: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter(e => e.isFile());
  return Promise.all(files.map(async e => {
    const full = path.join(e.parentPath, e.name);
    const { size, mtimeMs } = await fs.promises.stat(full);
    return { path: full, size, mtimeMs };
  }));
}
