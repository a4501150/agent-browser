import { Artifacts } from '../util/artifacts';
import { Registry } from '../browser/registry';
import { Renderer } from '../web/render';
import { defaultToolConfig } from './host';
import { paths } from '../config';

import type { Config } from '../config';
import type { ServerHost, ToolConfig } from './host';
import type { Tab } from '../browser/tab';

/**
 * How long the shared web_* browser survives with nothing using it. Long
 * enough that a burst of research reuses one browser, short enough that a
 * cookie a site set cannot follow the agent around for the session.
 */
export const rendererIdleMs = 60_000;

export class App implements ServerHost {
  readonly config: ToolConfig = defaultToolConfig;
  readonly cwd: string;
  readonly artifacts: Artifacts;
  readonly instances: Registry;

  private _renderer: Promise<Renderer> | undefined;
  private _leases = 0;
  private _idleTimer: NodeJS.Timeout | undefined;
  private _closing = false;
  private _rendererIdleMs: number;

  constructor(appConfig: Config, options: { rendererIdleMs?: number } = {}) {
    this.cwd = appConfig.cwd;
    this.artifacts = new Artifacts(paths.artifacts(appConfig));
    this.instances = new Registry(appConfig, this.artifacts);
    this._rendererIdleMs = options.rendererIdleMs ?? rendererIdleMs;
  }

  currentTab(): Tab | undefined {
    return undefined;
  }

  tabs(): Tab[] {
    return [];
  }

  /**
   * The *promise* is memoised, not the resolved renderer: two concurrent crawl
   * workers would otherwise each find it unset, each launch a browser, and all
   * but the last would leak.
   */
  async withRenderer<T>(use: (renderer: Renderer) => Promise<T>): Promise<T> {
    if (this._closing)
      throw new Error('The server is shutting down.');
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = undefined;
    }
    this._leases++;
    try {
      return await use(await this._acquire());
    } finally {
      this._leases--;
      this._armIdleClose();
    }
  }

  private async _acquire(): Promise<Renderer> {
    for (;;) {
      const pending = this._renderer ??= Renderer.create(this).catch(e => {
        this._renderer = undefined;
        throw e;
      });
      const renderer = await pending;
      if (!renderer.closed)
        return renderer;
      // Idle-closed or crashed between calls; a memoised dead renderer would
      // fail every fetch from here on. Only the caller that still sees its own
      // promise clears it, or two callers racing here would each install a
      // replacement and the one that lost would be unreachable, unreapable
      // (idleTimeout is 0) and alive until shutdown.
      if (this._renderer === pending)
        this._renderer = undefined;
      if (this._closing)
        throw new Error('The server is shutting down.');
    }
  }

  /**
   * Only once nothing holds a lease. Resetting a timer on each call would kill
   * the browser under a crawl that legitimately runs for minutes.
   */
  private _armIdleClose() {
    if (this._leases || this._closing || !this._renderer || this._idleTimer)
      return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = undefined;
      if (this._leases)
        return;
      void this._closeRenderer();
    }, this._rendererIdleMs);
    this._idleTimer.unref?.();
  }

  private async _closeRenderer(): Promise<void> {
    const pending = this._renderer;
    this._renderer = undefined;
    await pending?.then(renderer => renderer.close()).catch(() => {});
  }

  async start(): Promise<void> {
    await this.instances.reapOrphans().catch(() => {});
    this.instances.startReaper();
  }

  async close(): Promise<void> {
    this._closing = true;
    if (this._idleTimer)
      clearTimeout(this._idleTimer);
    this._idleTimer = undefined;
    this.instances.stopReaper();
    await this._closeRenderer();
    await this.instances.closeAll();
  }
}
