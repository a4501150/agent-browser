/**
 * The cold-install path: download, verify the checksum *before* extracting,
 * extract with tar so symlinks and executable bits survive, strip the macOS
 * quarantine xattr, and launch. Served from a local HTTP server, so no release
 * asset is needed; the archive is built here from a small stand-in bundle
 * unless a real one is supplied.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { downloadAndExtract, manifestVersion, normalizeExecutable, platformKey, resolveBinary, sha256File } from '../src/browser/binary';
import { resolveConfig } from '../src/config';

import type { PlatformEntry } from '../src/browser/binary';

let work: string;
let server: http.Server;
let origin: string;
let archive: string;
let digest: string;

/**
 * A stand-in for the real bundle: same shape, including the symlink that a zip
 * extractor would flatten, but kilobytes rather than 150 MB.
 */
function buildStandInBundle(root: string): void {
  const app = path.join(root, 'Chromium.app');
  const versions = path.join(app, 'Contents', 'Frameworks', 'Chromium Framework.framework', 'Versions');
  fs.mkdirSync(path.join(versions, 'A'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(versions, 'A', 'marker'), 'framework payload');
  fs.symlinkSync('A', path.join(versions, 'Current'));
  const executable = path.join(app, 'Contents', 'MacOS', 'Chromium');
  fs.writeFileSync(executable, '#!/bin/sh\necho "Chromium 148.0.7778.215"\n');
  fs.chmodSync(executable, 0o755);
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-binary-'));
  const staging = path.join(work, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  buildStandInBundle(staging);

  archive = path.join(work, 'chromium.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', staging, 'Chromium.app']);
  digest = await sha256File(archive);

  server = http.createServer((req, res) => {
    if (req.url === '/chromium.tar.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      fs.createReadStream(archive).pipe(res);
      return;
    }
    if (req.url === '/redirected.tar.gz') {
      res.writeHead(302, { location: '/chromium.tar.gz' });
      res.end();
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(work, { recursive: true, force: true });
});

function entry(overrides: Partial<PlatformEntry> = {}): PlatformEntry {
  return {
    url: `${origin}/chromium.tar.gz`,
    sha256: digest,
    size: fs.statSync(archive).size,
    app: 'Chromium.app',
    executable: 'Chromium.app/Contents/MacOS/Chromium',
    ...overrides,
  };
}

describe('cold install', () => {
  it('downloads, verifies, extracts and leaves a runnable bundle', async () => {
    const cache = path.join(work, 'cache-ok');
    await downloadAndExtract(entry(), cache);

    const executable = path.join(cache, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    expect(fs.existsSync(executable)).toBe(true);
    // The executable bit must survive the round trip.
    expect(fs.statSync(executable).mode & 0o111).toBeTruthy();
    // And so must the symlink, which is why this is a tarball and not a zip.
    const current = path.join(cache, 'Chromium.app', 'Contents', 'Frameworks', 'Chromium Framework.framework', 'Versions', 'Current');
    expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(current)).toBe('A');
    // It actually runs.
    expect(execFileSync(executable, { encoding: 'utf-8' })).toContain('148.0.7778.215');
    // The archive is not left behind.
    expect(fs.existsSync(path.join(cache, 'download.tar.gz'))).toBe(false);
  });

  it('leaves no quarantine xattr behind on macOS', async () => {
    if (process.platform !== 'darwin')
      return;
    const cache = path.join(work, 'cache-quarantine');
    await downloadAndExtract(entry(), cache);
    const app = path.join(cache, 'Chromium.app');
    // Simulate Gatekeeper tagging a download, then re-run the strip.
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', app]);
    expect(execFileSync('xattr', [app], { encoding: 'utf-8' })).toContain('com.apple.quarantine');
    await fs.promises.rm(path.join(cache, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), { force: true });
    await downloadAndExtract(entry(), cache);
    expect(execFileSync('xattr', ['-r', app], { encoding: 'utf-8' })).not.toContain('com.apple.quarantine');
  });

  it('refuses a checksum mismatch and keeps nothing', async () => {
    const cache = path.join(work, 'cache-badsum');
    const wrong = crypto.createHash('sha256').update('not the archive').digest('hex');
    await expect(downloadAndExtract(entry({ sha256: wrong }), cache)).rejects.toThrow(/Checksum mismatch/);
    expect(fs.existsSync(path.join(cache, 'Chromium.app'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'download.tar.gz'))).toBe(false);
  });

  it('follows a redirect to the asset', async () => {
    const cache = path.join(work, 'cache-redirect');
    await downloadAndExtract(entry({ url: `${origin}/redirected.tar.gz` }), cache);
    expect(fs.existsSync(path.join(cache, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))).toBe(true);
  });

  it('reports a missing asset instead of extracting rubbish', async () => {
    const cache = path.join(work, 'cache-404');
    await expect(downloadAndExtract(entry({ url: `${origin}/missing.tar.gz` }), cache)).rejects.toThrow(/Download failed: 404/);
  });

  it('reuses the cache without downloading again', async () => {
    const cache = path.join(work, 'cache-reuse');
    await downloadAndExtract(entry(), cache);
    // A URL that 404s proves no second request was made.
    await downloadAndExtract(entry({ url: `${origin}/missing.tar.gz` }), cache);
    expect(fs.existsSync(path.join(cache, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))).toBe(true);
  });
});

describe('binary resolution', () => {
  it('accepts either the app bundle or the executable inside it', () => {
    expect(normalizeExecutable('/x/Chromium.app')).toBe('/x/Chromium.app/Contents/MacOS/Chromium');
    expect(normalizeExecutable('/x/Chromium.app/Contents/MacOS/Chromium')).toBe('/x/Chromium.app/Contents/MacOS/Chromium');
  });

  it('fails loudly for a binary that is not there, rather than falling back', async () => {
    const config = resolveConfig({ binary: '/nope/Chromium.app', dataDir: work });
    await expect(resolveBinary(config)).rejects.toThrow(/not found/);
  });

  it('names the platform and the override when there is nothing to install', async () => {
    // No release asset is published yet, so a bare resolve must say so and
    // point at --binary rather than silently using a stock Chromium.
    const config = resolveConfig({ dataDir: path.join(work, 'empty-cache') });
    delete process.env.AGENT_BROWSER_BINARY;
    await expect(resolveBinary({ ...config, binary: undefined })).rejects.toThrow(
      new RegExp(`(${platformKey()}|AGENT_BROWSER_BINARY)`));
  });

  it('pins a version and revision', () => {
    expect(manifestVersion()).toMatch(/^\d+\.\d+\.\d+\.\d+-\d+$/);
  });
});
