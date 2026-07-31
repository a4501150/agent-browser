import os from 'node:os';
import path from 'node:path';

export type Config = {
  dataDir: string;
  binary: string | undefined;
  headed: boolean;
  /** Seconds; 0 disables. */
  idleTimeout: number;
  cwd: string;
};

export function defaultDataDir(): string {
  return process.env.AGENT_BROWSER_DATA_DIR || path.join(os.homedir(), '.agent-browser');
}

export function resolveConfig(flags: {
  binary?: string;
  dataDir?: string;
  headed?: boolean;
  idleTimeout?: number;
}): Config {
  return {
    dataDir: path.resolve(flags.dataDir || defaultDataDir()),
    binary: flags.binary || process.env.AGENT_BROWSER_BINARY || undefined,
    headed: flags.headed ?? false,
    idleTimeout: flags.idleTimeout ?? 300,
    cwd: process.cwd(),
  };
}

export const paths = {
  profiles: (c: Config) => path.join(c.dataDir, 'profiles'),
  slots: (c: Config) => path.join(c.dataDir, 'profiles', '.slots'),
  chromium: (c: Config) => path.join(c.dataDir, 'chromium'),
  processes: (c: Config) => path.join(c.dataDir, 'processes.json'),
  artifacts: (c: Config) => path.join(c.dataDir, 'artifacts'),
};
