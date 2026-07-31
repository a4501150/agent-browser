import { Artifacts } from '../util/artifacts';
import { Registry } from '../browser/registry';
import { defaultToolConfig } from './host';
import { paths } from '../config';

import type { Config } from '../config';
import type { ServerHost, ToolConfig } from './host';
import type { Tab } from '../browser/tab';

/** The process-wide host: one artifact directory, one instance registry. */
export class App implements ServerHost {
  readonly config: ToolConfig = defaultToolConfig;
  readonly cwd: string;
  readonly artifacts: Artifacts;
  readonly appConfig: Config;
  readonly instances: Registry;

  constructor(appConfig: Config) {
    this.appConfig = appConfig;
    this.cwd = appConfig.cwd;
    this.artifacts = new Artifacts(paths.artifacts(appConfig));
    this.instances = new Registry(appConfig, this.artifacts);
  }

  /** A global tool has no tab of its own; the web_* tools render text only. */
  currentTab(): Tab | undefined {
    return undefined;
  }

  tabs(): Tab[] {
    return [];
  }

  async start(): Promise<void> {
    await this.instances.reapOrphans().catch(() => {});
    this.instances.startReaper();
  }

  async close(): Promise<void> {
    this.instances.stopReaper();
    await this.instances.closeAll();
  }
}
