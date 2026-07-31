import type { Artifacts } from '../util/artifacts';
import type { Tab } from '../browser/tab';
import type { Registry } from '../browser/registry';

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export type ToolConfig = {
  timeouts: { action: number; navigation: number; settle: number };
  consoleLevel: ConsoleLevel;
};

export const defaultToolConfig: ToolConfig = {
  timeouts: { action: 15_000, navigation: 30_000, settle: 500 },
  consoleLevel: 'info',
};

/**
 * The surface `Response` renders from. An `Instance` implements it with real
 * tabs; the server implements it with none, for the web_* tools.
 */
export interface ResponseHost {
  readonly config: ToolConfig;
  readonly cwd: string;
  readonly artifacts: Artifacts;
  currentTab(): Tab | undefined;
  tabs(): Tab[];
}

/** What a global tool (browser_open, browser_list, web_*) receives. */
export interface ServerHost extends ResponseHost {
  readonly instances: Registry;
}
