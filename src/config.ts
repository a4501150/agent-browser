import os from 'node:os';
import path from 'node:path';

export type Config = {
  dataDir: string;
  binary: string | undefined;
  headed: boolean;
  /** Seconds of inactivity before an instance is closed; 0 keeps it for the
   * life of the server. */
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
    // A browser outlives long gaps between tool calls, because an agent can
    // spend many minutes elsewhere and still expect its tabs, scroll position
    // and half-finished logins to be there. Nothing leaks: a browser dies with
    // the server that launched it, which is the CLI session's own lifetime.
    idleTimeout: flags.idleTimeout ?? 0,
    cwd: process.cwd(),
  };
}

export const paths = {
  profiles: (c: Config) => path.join(c.dataDir, 'profiles'),
  slots: (c: Config) => path.join(c.dataDir, 'profiles', '.slots'),
  chromium: (c: Config) => path.join(c.dataDir, 'chromium'),
  // A directory of <server-pid>.json, not one shared file: every server on the
  // machine reads it, so a shared file both races on write and makes another
  // server's live browsers indistinguishable from a dead run's leftovers.
  processes: (c: Config) => path.join(c.dataDir, 'processes'),
  artifacts: (c: Config) => path.join(c.dataDir, 'artifacts'),
};
