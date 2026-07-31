import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import debug from 'debug';

import { Instance } from './instance';
import { resolveBinary } from './binary';
import { isProcessAlive } from './profiles';
import { paths } from '../config';

import type { Config } from '../config';
import type { Artifacts } from '../util/artifacts';
import type { OpenOptions } from './instance';

const log = debug('agent-browser:registry');

export const reaperIntervalMs = 10_000;

type ProcessRecord = {
  pid: number;
  userDataDir: string;
  ephemeral: boolean;
  startedAt: number;
};

export type InstanceSummary = {
  instance_id: string;
  profile: string | null;
  user_data_dir: string;
  headless: boolean;
  fingerprint: string | null;
  tabs: number;
  current_url: string | null;
  created_at: string;
  last_activity: string;
};

export class Registry {
  private _config: Config;
  private _artifacts: Artifacts;
  private _instances = new Map<string, Instance>();
  private _reaper: NodeJS.Timeout | undefined;
  private _binary: Promise<string> | undefined;

  constructor(config: Config, artifacts: Artifacts) {
    this._config = config;
    this._artifacts = artifacts;
  }

  get config(): Config {
    return this._config;
  }

  async open(options: OpenOptions): Promise<Instance> {
    this._binary ??= resolveBinary(this._config);
    let executablePath: string;
    try {
      executablePath = await this._binary;
    } catch (e) {
      // A failed resolution must not be cached; the user may fix it and retry.
      this._binary = undefined;
      throw e;
    }

    const id = `inst_${crypto.randomBytes(4).toString('hex')}`;
    const instance = await Instance.launch({
      id,
      cwd: this._config.cwd,
      artifacts: this._artifacts,
      executablePath,
      dataDirConfig: this._config,
      options,
      onClosed: closed => {
        this._instances.delete(closed.id);
        void this._forgetProcess(closed.userDataDir);
      },
    });
    this._instances.set(id, instance);
    await this._rememberProcess(instance);
    return instance;
  }

  get(id: string): Instance {
    const instance = this._instances.get(id);
    if (!instance)
      throw new Error(`No browser instance "${id}". Open one with browser_open, or list the live ones with browser_list.`);
    if (instance.closed)
      throw new Error(`Browser instance "${id}" has closed.`);
    instance.touch();
    return instance;
  }

  list(): Instance[] {
    return [...this._instances.values()];
  }

  summaries(): InstanceSummary[] {
    return this.list().map(instance => ({
      instance_id: instance.id,
      profile: instance.profileName,
      user_data_dir: instance.userDataDir,
      headless: instance.headless,
      fingerprint: instance.seed ?? null,
      tabs: instance.tabs().length,
      current_url: instance.currentTab()?.page.url() ?? null,
      created_at: new Date(instance.createdAt).toISOString(),
      last_activity: new Date(instance.lastActivity).toISOString(),
    }));
  }

  async close(id: string): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance)
      throw new Error(`No browser instance "${id}".`);
    await instance.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map(instance => instance.close().catch(() => {})));
  }

  startReaper() {
    if (this._reaper || !this._config.idleTimeout)
      return;
    // Sweeping is a few timestamp comparisons over a small map, so it can be
    // frequent enough that a short --idle-timeout means roughly what it says.
    this._reaper = setInterval(() => { void this._reap(); }, reaperIntervalMs);
    this._reaper.unref?.();
  }

  stopReaper() {
    if (this._reaper)
      clearInterval(this._reaper);
    this._reaper = undefined;
  }

  private async _reap() {
    const now = Date.now();
    for (const instance of this.list()) {
      const timeout = instance.idleTimeout ?? this._config.idleTimeout;
      if (!timeout)
        continue;
      if (now - instance.lastActivity > timeout * 1000) {
        log('reaping idle instance %s', instance.id);
        await instance.close().catch(() => {});
      }
    }
  }

  // --- orphan tracking -------------------------------------------------
  // An MCP server is frequently SIGKILLed by its client, which leaves the
  // browser running with no one to close it. Record enough to reap those at
  // the next startup.

  private async _readProcesses(): Promise<ProcessRecord[]> {
    try {
      return JSON.parse(await fs.promises.readFile(paths.processes(this._config), 'utf-8'));
    } catch {
      return [];
    }
  }

  private async _writeProcesses(records: ProcessRecord[]): Promise<void> {
    const file = paths.processes(this._config);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(records, null, 2), 'utf-8');
  }

  private async _rememberProcess(instance: Instance): Promise<void> {
    const pid = chromiumPid(instance.userDataDir);
    if (!pid)
      return;
    const records = (await this._readProcesses()).filter(r => r.userDataDir !== instance.userDataDir);
    records.push({
      pid,
      userDataDir: instance.userDataDir,
      ephemeral: instance.userDataDir.includes(`${path.sep}.slots${path.sep}`) || instance.profileName === null,
      startedAt: Date.now(),
    });
    await this._writeProcesses(records).catch(() => {});
  }

  private async _forgetProcess(userDataDir: string): Promise<void> {
    const records = (await this._readProcesses()).filter(r => r.userDataDir !== userDataDir);
    await this._writeProcesses(records).catch(() => {});
  }

  /**
   * Kill browsers a previous run left behind. Only PIDs we recorded, and only
   * when the process still owns the user-data dir we recorded it against, so
   * an unrelated process that inherited the PID is never touched.
   */
  async reapOrphans(): Promise<number> {
    const records = await this._readProcesses();
    if (!records.length)
      return 0;
    let killed = 0;
    for (const record of records) {
      if (!isProcessAlive(record.pid))
        continue;
      if (chromiumPid(record.userDataDir) !== record.pid)
        continue;
      try {
        process.kill(record.pid, 'SIGTERM');
        killed++;
        log('reaped orphan chromium pid %d (%s)', record.pid, record.userDataDir);
      } catch {
        continue;
      }
      if (record.ephemeral)
        await fs.promises.rm(record.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    await this._writeProcesses([]).catch(() => {});
    return killed;
  }
}

/** Chromium's SingletonLock is a symlink whose target ends in `-<pid>`. */
function chromiumPid(userDataDir: string): number | undefined {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
