import { defaultDataDir } from './config';

export type Cli = {
  command: 'stdio' | 'serve';
  port: number;
  host: string;
  headed: boolean;
  binary?: string;
  dataDir?: string;
  idleTimeout?: number;
};

export const version = '0.1.0';

const usage = `agent-browser ${version} — an undetectable browser MCP server

Usage
  agent-browser                     serve over stdio (the usual MCP mode)
  agent-browser serve [options]     serve Streamable HTTP at /mcp

Options
  --port <n>            HTTP port for serve. Default 3000.
  --host <addr>         HTTP bind address for serve. Default 127.0.0.1.
                        A non-loopback address requires AGENT_BROWSER_TOKEN.
  --headed              launch browsers with a visible window.
  --binary <path>       patched Chromium to use (the .app bundle or the executable).
  --data-dir <path>     profiles, browser cache and artifacts. Default ${defaultDataDir()}.
  --idle-timeout <s>    close instances idle this long. 0 disables. Default 300.
  --version             print the version and exit.
  --help                print this help and exit.

Environment
  AGENT_BROWSER_BINARY    same as --binary
  AGENT_BROWSER_DATA_DIR  same as --data-dir
  AGENT_BROWSER_TOKEN     bearer token required by serve
`;

export class CliExit extends Error {
  readonly code: number;
  readonly output: string;
  constructor(output: string, code: number) {
    super(output);
    this.output = output;
    this.code = code;
  }
}

export function parseCli(argv: string[]): Cli {
  const cli: Cli = { command: 'stdio', port: 3000, host: '127.0.0.1', headed: false };
  let index = 0;

  if (argv[0] === 'serve') {
    cli.command = 'serve';
    index = 1;
  }

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--'))
      throw new CliExit(`${flag} needs a value.\n\n${usage}`, 2);
    return value;
  };

  for (; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        throw new CliExit(usage, 0);
      case '--version':
      case '-v':
        throw new CliExit(`${version}\n`, 0);
      case '--headed':
        cli.headed = true;
        break;
      case '--port':
        cli.port = parsePort(requireValue(arg, argv[++index]));
        break;
      case '--host':
        cli.host = requireValue(arg, argv[++index]);
        break;
      case '--binary':
        cli.binary = requireValue(arg, argv[++index]);
        break;
      case '--data-dir':
        cli.dataDir = requireValue(arg, argv[++index]);
        break;
      case '--idle-timeout':
        cli.idleTimeout = parseSeconds(requireValue(arg, argv[++index]));
        break;
      default:
        throw new CliExit(`Unknown option "${arg}".\n\n${usage}`, 2);
    }
  }

  return cli;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new CliExit(`--port must be an integer between 0 and 65535, got "${value}".\n`, 2);
  return port;
}

function parseSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0)
    throw new CliExit(`--idle-timeout must be a non-negative integer number of seconds, got "${value}".\n`, 2);
  return seconds;
}
