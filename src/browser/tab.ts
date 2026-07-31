/**
 * Derived from playwright-core/src/tools/backend/tab.ts (Apache-2.0, tag
 * v1.62.1). Upstream's LogFile console spill and SessionLog are dropped —
 * browser_read_console reads the live buffer instead — and target resolution
 * moved to target.ts so locatorGenerators/locatorParser stay unvendored.
 */
import { EventEmitter } from 'node:events';

import debug from 'debug';

import { ManualPromise } from '../vendor/manualPromise';
import { eventsHelper } from '../vendor/eventsHelper';
import { disposeAll } from '../vendor/disposable';
import { captureAriaSnapshot } from './snapshot';
import { resolveTarget, resolveTargets } from './target';
import { waitForCompletion, eventWaiter } from './wait';
import { sanitizeForFilePath } from '../util/artifacts';

import type { Disposable } from '../vendor/disposable';
import type * as playwright from 'playwright-core';
import type { Instance } from './instance';
import type { ModalState } from '../mcp/tool';
import type { ConsoleLevel } from '../mcp/host';
import type { ResolvedTarget } from './target';

const TabEvents = { modalState: 'modalState' };

type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

type Download = {
  download: playwright.Download;
  finished: boolean;
  outputFile: string;
};

export type EventEntry =
  | { type: 'console'; wallTime: number; message: ConsoleMessage }
  | { type: 'download-start'; wallTime: number; download: Download }
  | { type: 'download-finish'; wallTime: number; download: Download }
  | { type: 'request'; wallTime: number; request: playwright.Request };

export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
  crashed: boolean;
  mainDocumentStatus?: { status: number; statusText: string };
  console: { total: number; warnings: number; errors: number };
};

export type TabSnapshot = {
  ariaSnapshot: string;
  modalStates: ModalState[];
};

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly instance: Instance;
  readonly page: playwright.Page;
  private _lastHeader: TabHeader = { title: 'about:blank', url: 'about:blank', current: false, crashed: false, console: { total: 0, warnings: 0, errors: 0 } };
  private _downloads: Download[] = [];
  private _requests: playwright.Request[] = [];
  private _mainDocumentStatus: { status: number; statusText: string } | undefined;
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _initializedPromise: Promise<void>;
  private _recentEventEntries: EventEntry[] = [];
  private _disposables: Disposable[];
  crashed = false;

  readonly actionTimeoutOptions: { timeout?: number };
  readonly navigationTimeoutOptions: { timeout?: number };
  readonly expectTimeoutOptions: { timeout?: number };

  constructor(instance: Instance, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.instance = instance;
    this.page = page;
    this._onPageClose = onPageClose;
    const p = page;
    this._disposables = [
      eventsHelper.addEventListener(p, 'console', event => this._handleConsoleMessage(messageToConsoleMessage(event))),
      eventsHelper.addEventListener(p, 'pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error))),
      eventsHelper.addEventListener(p, 'request', request => this._handleRequest(request)),
      eventsHelper.addEventListener(p, 'response', response => this._handleResponse(response)),
      eventsHelper.addEventListener(p, 'requestfailed', request => this._handleRequestFailed(request)),
      eventsHelper.addEventListener(p, 'close', () => this._onClose()),
      eventsHelper.addEventListener(p, 'crash', () => { this.crashed = true; }),
      eventsHelper.addEventListener(p, 'filechooser', chooser => {
        this.setModalState({
          type: 'fileChooser',
          description: 'File chooser',
          fileChooser: chooser,
          clearedBy: 'browser_upload_file',
        });
      }),
      eventsHelper.addEventListener(p, 'dialog', dialog => this._dialogShown(dialog)),
      eventsHelper.addEventListener(p, 'download', download => {
        void this._downloadStarted(download);
      }),
    ];
    (page as any)[tabSymbol] = this;
    this._initializedPromise = this._initialize();
    const timeouts = instance.config.timeouts;
    this.actionTimeoutOptions = { timeout: timeouts.action };
    this.navigationTimeoutOptions = { timeout: timeouts.navigation };
    this.expectTimeoutOptions = { timeout: timeouts.expect };
  }

  async dispose() {
    await disposeAll(this._disposables);
  }

  async waitForInitialized() {
    await this._initializedPromise;
  }

  static forPage(page: playwright.Page): Tab | undefined {
    return (page as any)[tabSymbol];
  }

  private async _initialize() {
    const requests = await this.page.requests().catch(() => []);
    for (const request of requests.filter(r => r.existingResponse() || r.failure()))
      this._requests.push(request);
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState) {
    this._modalStates.push(modalState);
    this.emit(TabEvents.modalState, modalState);
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  private _dialogShown(dialog: playwright.Dialog) {
    this.setModalState({
      type: 'dialog',
      description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
      dialog,
      clearedBy: 'browser_handle_dialog',
    });
  }

  private async _downloadStarted(download: playwright.Download) {
    // Do not trust web-supplied names.
    const outputFile = await this.instance.artifacts.outputFile({
      suggestedFilename: sanitizeForFilePath(download.suggestedFilename()),
      prefix: 'download',
      ext: 'bin',
    });
    const entry: Download = { download, finished: false, outputFile };
    this._downloads.push(entry);
    this._recentEventEntries.push({ type: 'download-start', wallTime: Date.now(), download: entry });
    await download.saveAs(entry.outputFile);
    entry.finished = true;
    this._recentEventEntries.push({ type: 'download-finish', wallTime: Date.now(), download: entry });
  }

  private _clearCollectedArtifacts() {
    this._downloads.length = 0;
    this._requests.length = 0;
    this._mainDocumentStatus = undefined;
    this._recentEventEntries.length = 0;
  }

  private _handleRequest(request: playwright.Request) {
    this._requests.push(request);
    // A fetch() has no start time until its response arrives.
    const wallTime = request.timing().startTime || Date.now();
    this._recentEventEntries.push({ type: 'request', wallTime, request });
  }

  private _handleResponse(response: playwright.Response) {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === this.page.mainFrame() && !request.redirectedTo())
      this._mainDocumentStatus = { status: response.status(), statusText: response.statusText() };
  }

  private _handleRequestFailed(_request: playwright.Request) {
    // Already recorded by _handleRequest; failure() is read at render time.
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    this._recentEventEntries.push({ type: 'console', wallTime: message.timestamp, message });
  }

  logErrorMessage(text: string) {
    this._handleConsoleMessage(pageErrorToConsoleMessage(new Error(text)));
  }

  takeRecentEvents(): EventEntry[] {
    const entries = this._recentEventEntries;
    this._recentEventEntries = [];
    return entries;
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async headerSnapshot(): Promise<TabHeader & { changed: boolean }> {
    let title: string | undefined;
    let consoleCounts = { total: 0, errors: 0, warnings: 0 };
    if (!this.crashed) {
      await this._raceAgainstModalStates(async () => {
        title = await this.page.title();
      });
      consoleCounts = await this.consoleMessageCount();
    }
    const newHeader: TabHeader = {
      title: title ?? '',
      url: this.page.url(),
      current: this.isCurrentTab(),
      crashed: this.crashed,
      mainDocumentStatus: this._mainDocumentStatus,
      console: consoleCounts,
    };
    if (!tabHeaderEquals(this._lastHeader, newHeader)) {
      this._lastHeader = newHeader;
      return { ...this._lastHeader, changed: true };
    }
    return { ...this._lastHeader, changed: false };
  }

  isCurrentTab(): boolean {
    return this === this.instance.currentTab();
  }

  async waitForLoadState(state: 'load', options?: { timeout?: number }): Promise<void> {
    await this._initializedPromise;
    await this.page.waitForLoadState(state, options).catch(e => debug('agent-browser:error')(e));
  }

  async checkUrlAndNavigate(url: string): Promise<string> {
    try {
      new URL(url);
    } catch {
      url = url.startsWith('localhost') ? 'http://' + url : 'https://' + url;
    }
    await this.navigate(url);
    return url;
  }

  async navigate(url: string) {
    await this._initializedPromise;
    this._clearCollectedArtifacts();

    const { promise: downloadEvent, abort: abortDownloadEvent } = eventWaiter<playwright.Download>(this.page, 'download', 3000);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions });
      abortDownloadEvent();
    } catch (_e: unknown) {
      const e = _e as Error;
      if (!e.message.includes('Download is starting')) {
        abortDownloadEvent();
        throw e;
      }
      const download = await downloadEvent;
      if (!download)
        throw e;
      // Let the other "download" listeners run first.
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }
    // Cap the load event; the page is already operational.
    await this.waitForLoadState('load', { timeout: 5000 });
  }

  async consoleMessageCount(): Promise<{ total: number; errors: number; warnings: number }> {
    await this._initializedPromise;
    const messages = await this.page.consoleMessages({ filter: 'since-navigation' });
    const pageErrors = await this.page.pageErrors({ filter: 'since-navigation' });
    let errors = pageErrors.length;
    let warnings = 0;
    for (const message of messages) {
      if (message.type() === 'error')
        errors++;
      else if (message.type() === 'warning')
        warnings++;
    }
    return { total: messages.length + pageErrors.length, errors, warnings };
  }

  async consoleMessages(level: ConsoleLevel, all?: boolean): Promise<ConsoleMessage[]> {
    await this._initializedPromise;
    const result: ConsoleMessage[] = [];
    const messages = await this.page.consoleMessages({ filter: all ? 'all' : 'since-navigation' });
    for (const message of messages) {
      const cm = messageToConsoleMessage(message);
      if (shouldIncludeMessage(level, cm.type))
        result.push(cm);
    }
    if (shouldIncludeMessage(level, 'error')) {
      const errors = await this.page.pageErrors({ filter: all ? 'all' : 'since-navigation' });
      for (const error of errors)
        result.push(pageErrorToConsoleMessage(error));
    }
    return result;
  }

  async clearConsoleMessages() {
    await this._initializedPromise;
    await Promise.all([this.page.clearConsoleMessages(), this.page.clearPageErrors()]);
  }

  async requests(): Promise<playwright.Request[]> {
    await this._initializedPromise;
    return this._requests;
  }

  async clearRequests() {
    await this._initializedPromise;
    this._requests.length = 0;
  }

  async captureSnapshot(root: playwright.Locator | undefined, depth: number | undefined): Promise<TabSnapshot> {
    await this._initializedPromise;
    let tabSnapshot: TabSnapshot | undefined;
    const modalStates = await this._raceAgainstModalStates(async () => {
      tabSnapshot = {
        ariaSnapshot: await captureAriaSnapshot(root ?? this.page, { depth }),
        modalStates: [],
      };
    });
    return tabSnapshot ?? { ariaSnapshot: '', modalStates };
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    return await Promise.race([
      action().then(() => {
        this.off(TabEvents.modalState, listener);
        return [];
      }),
      promise,
    ]);
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._initializedPromise;
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async targetLocator(params: { element?: string; target: string }): Promise<ResolvedTarget> {
    await this._initializedPromise;
    return resolveTarget(this.page, params);
  }

  async targetLocators(params: { element?: string; target: string }[]): Promise<ResolvedTarget[]> {
    await this._initializedPromise;
    return resolveTargets(this.page, params);
  }

  async waitForTimeout(time: number) {
    if (this._javaScriptBlocked()) {
      await new Promise(f => setTimeout(f, time));
      return;
    }
    await this.page.evaluate(ms => new Promise(f => setTimeout(f, ms)), time).catch(() => {});
  }
}

export type ConsoleMessage = {
  type: ReturnType<playwright.ConsoleMessage['type']>;
  timestamp: number;
  text: string;
  toString(): string;
};

function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  return {
    type: message.type(),
    timestamp: message.timestamp(),
    text: message.text(),
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`,
  };
}

function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
  if (errorOrValue instanceof Error) {
    return {
      type: 'error',
      timestamp: Date.now(),
      text: errorOrValue.message,
      toString: () => errorOrValue.stack || errorOrValue.message,
    };
  }
  return {
    type: 'error',
    timestamp: Date.now(),
    text: String(errorOrValue),
    toString: () => String(errorOrValue),
  };
}

export function renderModalStates(modalStates: ModalState[]): string[] {
  const result: string[] = [];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates)
    result.push(`- [${state.description}]: can be handled by ${state.clearedBy}`);
  return result;
}

type ConsoleMessageType = ReturnType<playwright.ConsoleMessage['type']>;
const consoleMessageLevels: ConsoleLevel[] = ['error', 'warning', 'info', 'debug'];

export function shouldIncludeMessage(thresholdLevel: ConsoleLevel | undefined, type: ConsoleMessageType): boolean {
  const messageLevel = consoleLevelForMessageType(type);
  return consoleMessageLevels.indexOf(messageLevel) <= consoleMessageLevels.indexOf(thresholdLevel || 'info');
}

function consoleLevelForMessageType(type: ConsoleMessageType): ConsoleLevel {
  switch (type) {
    case 'assert':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'clear':
    case 'debug':
    case 'endGroup':
    case 'profile':
    case 'profileEnd':
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

const tabSymbol = Symbol('tabSymbol');

function tabHeaderEquals(a: TabHeader, b: TabHeader): boolean {
  return a.title === b.title &&
      a.url === b.url &&
      a.current === b.current &&
      a.crashed === b.crashed &&
      a.mainDocumentStatus?.status === b.mainDocumentStatus?.status &&
      a.mainDocumentStatus?.statusText === b.mainDocumentStatus?.statusText &&
      a.console.errors === b.console.errors &&
      a.console.warnings === b.console.warnings &&
      a.console.total === b.console.total;
}
