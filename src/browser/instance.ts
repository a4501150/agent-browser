import { chromium } from 'playwright-core';

import { Tab } from './tab';
import { acquireProfile } from './profiles';
import { eventsHelper } from '../vendor/eventsHelper';
import { disposeAll } from '../vendor/disposable';
import { defaultToolConfig } from '../mcp/host';

import type * as playwright from 'playwright-core';
import type { Disposable } from '../vendor/disposable';
import type { Artifacts } from '../util/artifacts';
import type { ResponseHost, ToolConfig } from '../mcp/host';
import type { ProfileChoice } from './profiles';

export type OpenOptions = {
  profile?: string | null;
  userDataDir?: string;
  headless?: boolean;
  windowSize?: { width: number; height: number };
  proxy?: string;
  timezone?: string;
  fingerprint?: number;
  idleTimeout?: number;
};

type RouteEntry = {
  pattern: string;
  block?: boolean;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  handler: (route: playwright.Route) => Promise<void>;
  dispose: () => Promise<void>;
};

export const defaultWindowSize = { width: 1280, height: 720 };

/**
 * One browser. Implements the surface the vendored Playwright tool bodies
 * expect of their `Context`, so those bodies need no edits, while the registry
 * above keeps many of these at once.
 */
export class Instance implements ResponseHost {
  readonly id: string;
  readonly config: ToolConfig = defaultToolConfig;
  readonly cwd: string;
  readonly artifacts: Artifacts;
  readonly profileName: string | null;
  readonly createdAt = Date.now();
  readonly idleTimeout: number | undefined;
  readonly headless: boolean;

  lastActivity = Date.now();

  private _browserContext: playwright.BrowserContext;
  private _profile: ProfileChoice;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _routes: RouteEntry[] = [];
  private _disposables: Disposable[] = [];
  private _closed = false;
  private _onClosed: (instance: Instance) => void;

  private constructor(args: {
    id: string;
    cwd: string;
    artifacts: Artifacts;
    browserContext: playwright.BrowserContext;
    profile: ProfileChoice;
    profileName: string | null;
    headless: boolean;
    idleTimeout: number | undefined;
    onClosed: (instance: Instance) => void;
  }) {
    this.id = args.id;
    this.cwd = args.cwd;
    this.artifacts = args.artifacts;
    this._browserContext = args.browserContext;
    this._profile = args.profile;
    this.profileName = args.profileName;
    this.headless = args.headless;
    this.idleTimeout = args.idleTimeout;
    this._onClosed = args.onClosed;
  }

  static async launch(args: {
    id: string;
    cwd: string;
    artifacts: Artifacts;
    executablePath: string;
    dataDirConfig: import('../config').Config;
    options: OpenOptions;
    onClosed: (instance: Instance) => void;
  }): Promise<Instance> {
    const { options } = args;
    const profile = await acquireProfile(args.dataDirConfig, {
      profile: options.profile,
      userDataDir: options.userDataDir,
      fingerprint: options.fingerprint,
    });

    const windowSize = options.windowSize ?? defaultWindowSize;
    const headless = options.headless ?? !args.dataDirConfig.headed;
    const browserArgs = [`--window-size=${windowSize.width},${windowSize.height}`];
    // The only two switches our patch layer implements for drivers.
    if (profile.seed !== undefined)
      browserArgs.push(`--fingerprint=${profile.seed}`);
    if (options.timezone)
      browserArgs.push(`--timezone=${options.timezone}`);

    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await chromium.launchPersistentContext(profile.userDataDir, {
        executablePath: args.executablePath,
        headless,
        // No device-metrics override ever exists, so the viewport follows the
        // real window -- for our resizes and for a human dragging the corner
        // alike -- and outerWidth/innerWidth/screen.* cannot disagree.
        viewport: null,
        // Playwright defaults this off, which passes --no-sandbox -- a flag
        // Chromium calls unsupported, so it shows an infobar no real user has
        // and shrinks the viewport under it.
        chromiumSandbox: true,
        // A no-op on playwright-core 1.62.1, which no longer passes the switch;
        // kept so a future reintroduction cannot leak into our launches.
        ignoreDefaultArgs: ['--enable-automation'],
        args: browserArgs,
        proxy: options.proxy ? { server: options.proxy } : undefined,
      });
    } catch (e) {
      await profile.release();
      throw e;
    }

    const instance = new Instance({
      id: args.id,
      cwd: args.cwd,
      artifacts: args.artifacts,
      browserContext,
      profile,
      profileName: options.userDataDir ? null : (options.profile === null ? null : (options.profile || 'default')),
      headless,
      idleTimeout: options.idleTimeout,
      onClosed: args.onClosed,
    });
    await instance._initialize();
    return instance;
  }

  private async _initialize() {
    for (const page of this._browserContext.pages())
      this._onPageCreated(page);
    this._disposables.push(eventsHelper.addEventListener(this._browserContext, 'page', page => this._onPageCreated(page)));
    this._browserContext.once('close', () => { void this.close(); });
  }

  get browserContext(): playwright.BrowserContext {
    return this._browserContext;
  }

  get userDataDir(): string {
    return this._profile.userDataDir;
  }

  /** Only a throwaway profile or a concurrency slot may ever be deleted. */
  get profileIsEphemeral(): boolean {
    return this._profile.kind === 'temp' || this._profile.kind === 'slot';
  }

  get seed(): string | undefined {
    return this._profile.seed;
  }

  get closed(): boolean {
    return this._closed;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  /** Vendored tool bodies call this; we have exactly one context per instance. */
  async ensureBrowserContext(): Promise<playwright.BrowserContext> {
    return this._browserContext;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const page = await this._browserContext.newPage();
    this._currentTab = this._tabs.find(t => t.page === page)!;
    return this._currentTab;
  }

  async selectTab(index: number): Promise<Tab> {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    const crashed = this._currentTab?.crashed;
    if (crashed) {
      await this._currentTab!.page.close().catch(() => {});
      this._currentTab = undefined;
    }
    if (!this._currentTab)
      await this.newTab();
    if (crashed)
      this._currentTab!.setNote('The page crashed and was reset to about:blank.');
    await this._currentTab!.waitForInitialized();
    return this._currentTab!;
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  private _onPageCreated(page: playwright.Page) {
    const tab = new Tab(this, page, t => this._onPageClosed(t));
    this._tabs.push(tab);
    if (!this._currentTab)
      this._currentTab = tab;
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);
    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: Omit<RouteEntry, 'dispose'>): Promise<void> {
    const disposable = await this._browserContext.route(entry.pattern, entry.handler);
    this._routes.push({ ...entry, dispose: () => disposable.dispose() });
  }

  async removeRoute(pattern?: string): Promise<number> {
    const toRemove = pattern ? this._routes.filter(r => r.pattern === pattern) : [...this._routes];
    for (const route of toRemove)
      await route.dispose();
    this._routes = this._routes.filter(r => !toRemove.includes(r));
    return toRemove.length;
  }

  /** Resize the real OS window, so the viewport follows rather than being pinned. */
  async setWindowSize(width: number, height: number): Promise<void> {
    const tab = await this.ensureTab();
    const session = await this._browserContext.newCDPSession(tab.page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height, windowState: 'normal' } });
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this._closed)
      return;
    this._closed = true;
    await disposeAll(this._disposables);
    for (const tab of this._tabs)
      await tab.dispose().catch(() => {});
    this._tabs.length = 0;
    this._currentTab = undefined;
    await this._browserContext.close().catch(() => {});
    await this._profile.release().catch(() => {});
    this._onClosed(this);
  }
}
