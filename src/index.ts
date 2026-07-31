import { CliExit, parseCli } from './cli';
import { resolveConfig } from './config';
import { App } from './mcp/app';
import { runHttp } from './mcp/http';
import { runStdio } from './mcp/stdio';

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliExit) {
      (e.code === 0 ? process.stdout : process.stderr).write(e.output);
      process.exit(e.code);
    }
    throw e;
  }

  const app = new App(resolveConfig({
    binary: cli.binary,
    dataDir: cli.dataDir,
    headed: cli.headed,
    idleTimeout: cli.idleTimeout,
  }));
  await app.start();

  try {
    if (cli.command === 'serve')
      await runHttp(app, { port: cli.port, host: cli.host });
    else
      await runStdio(app);
  } finally {
    await app.close();
  }
}

main().catch(error => {
  process.stderr.write(`agent-browser: ${error?.stack ?? error}\n`);
  process.exit(1);
});
