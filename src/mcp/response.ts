/**
 * Derived from playwright-core/src/tools/backend/response.ts (Apache-2.0, tag
 * v1.62.1). Upstream's image-rescaling path (jpeg-js / pngjs / webp) and the
 * debugger "Paused" section are dropped; artifact paths are absolute here
 * because an MCP client's cwd is not ours.
 */
import { inlineResultLimit } from '../util/artifacts';
import { renderModalStates } from '../browser/tab';

import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type * as playwright from 'playwright-core';
import type { FilenameTemplate } from '../util/artifacts';
import type { ResponseHost } from './host';
import type { TabHeader } from '../browser/tab';

type Section = {
  title: string;
  content: string[];
  isError?: boolean;
  codeframe?: 'yaml' | 'js';
};

export class Response {
  private _host: ResponseHost;
  private _results: string[] = [];
  private _errors: string[] = [];
  private _code: string[] = [];
  private _images: { data: Buffer; imageType: 'png' | 'jpeg' }[] = [];
  private _includeSnapshot: 'none' | 'full' | 'explicit' = 'none';
  private _snapshotRoot: playwright.Locator | undefined;
  private _snapshotDepth: number | undefined;
  private _snapshotToFile = false;
  private _isClose = false;

  readonly toolName: string;

  constructor(host: ResponseHost, toolName: string) {
    this._host = host;
    this.toolName = toolName;
  }

  addTextResult(text: string) {
    this._results.push(text);
  }

  addError(error: string) {
    this._errors.push(error);
  }

  addCode(code: string) {
    this._code.push(code);
  }

  setClose() {
    this._isClose = true;
  }

  /** Append the page outline after the action, so the model sees the new state. */
  setIncludeSnapshot() {
    this._includeSnapshot = 'full';
  }

  setIncludeExplicitSnapshot(options: { root?: playwright.Locator; depth?: number; toFile?: boolean }) {
    this._includeSnapshot = 'explicit';
    this._snapshotRoot = options.root;
    this._snapshotDepth = options.depth;
    this._snapshotToFile = options.toFile ?? false;
  }

  addImage(data: Buffer, imageType: 'png' | 'jpeg') {
    this._images.push({ data, imageType });
  }

  async addResult(title: string, data: Buffer | string, template: FilenameTemplate) {
    if (typeof data === 'string' && !template.suggestedFilename && data.length <= inlineResultLimit) {
      this.addTextResult(data);
      return;
    }
    const file = await this._host.artifacts.outputFile(template);
    await this._host.artifacts.write(file, data);
    this.addTextResult(`- [${title}](${file})${typeof data === 'string' ? ` (${data.length} bytes, too large to inline)` : ''}`);
  }

  async addFileResult(title: string, file: string, data: Buffer | string) {
    await this._host.artifacts.write(file, data);
    this.addTextResult(`- [${title}](${file})`);
  }

  async serialize(): Promise<CallToolResult & { isClose?: boolean }> {
    const sections = await this._build();
    await this._host.artifacts.maybeSweep();

    const text: string[] = [];
    for (const section of sections) {
      if (!section.content.length)
        continue;
      text.push(`### ${section.title}`);
      if (section.codeframe)
        text.push('```' + section.codeframe);
      text.push(...section.content);
      if (section.codeframe)
        text.push('```');
    }

    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: sanitizeUnicode(text.join('\n')) }];
    for (const image of this._images)
      content.push({ type: 'image', data: image.data.toString('base64'), mimeType: `image/${image.imageType}` });

    return {
      content,
      ...(this._isClose ? { isClose: true } : {}),
      ...(sections.some(section => section.isError) ? { isError: true } : {}),
    };
  }

  private async _build(): Promise<Section[]> {
    const sections: Section[] = [];
    const addSection = (title: string, content: string[], codeframe?: 'yaml' | 'js') => {
      sections.push({ title, content, isError: title === 'Error', codeframe });
    };

    if (this._errors.length)
      addSection('Error', this._errors);
    if (this._results.length)
      addSection('Result', this._results);
    if (this._code.length)
      addSection('Ran Playwright code', this._code, 'js');

    const currentTab = this._host.currentTab();
    const tabSnapshot = currentTab && this._includeSnapshot !== 'none'
      ? await currentTab.captureSnapshot(this._snapshotRoot, this._snapshotDepth)
      : undefined;
    const otherEvents = currentTab ? currentTab.takeRecentEvents() : [];

    const tabHeaders = await Promise.all(this._host.tabs().map(tab => tab.headerSnapshot()));
    if (this._includeSnapshot !== 'none' || tabHeaders.some(header => header.changed)) {
      if (tabHeaders.length > 1)
        addSection('Open tabs', renderTabsMarkdown(tabHeaders));
      const current = tabHeaders.find(h => h.current) ?? tabHeaders[0];
      if (current)
        addSection('Page', renderTabMarkdown(current));
    }

    if (tabSnapshot?.modalStates.length)
      addSection('Modal state', renderModalStates(tabSnapshot.modalStates));

    if (tabSnapshot && this._includeSnapshot !== 'none') {
      const outline = tabSnapshot.ariaSnapshot;
      const spill = this._snapshotToFile || outline.length > inlineResultLimit;
      if (spill && outline) {
        const file = await this._host.artifacts.outputFile({ prefix: 'page', ext: 'yml' });
        await this._host.artifacts.write(file, outline);
        addSection('Snapshot', [`- [Snapshot](${file}) (${outline.length} bytes)`]);
      } else {
        addSection('Snapshot', [outline], 'yaml');
      }
    }

    const events: string[] = [];
    for (const event of otherEvents) {
      if (event.type === 'download-start')
        events.push(`- Downloading file ${event.download.download.suggestedFilename()} ...`);
      else if (event.type === 'download-finish')
        events.push(`- Downloaded file ${event.download.download.suggestedFilename()} to "${event.download.outputFile}"`);
    }
    if (events.length)
      addSection('Events', events);

    return sections;
  }
}

export function renderTabMarkdown(tab: TabHeader): string[] {
  const lines = [`- Page URL: ${tab.url}`];
  if (tab.title)
    lines.push(`- Page Title: ${tab.title}`);
  if (tab.crashed)
    lines.push('- Page status: crashed');
  if (tab.note)
    lines.push(`- Note: ${tab.note}`);
  const status = tab.mainDocumentStatus;
  if (status && (status.status < 200 || status.status >= 300))
    lines.push(`- HTTP status: ${status.status}${status.statusText ? ' ' + status.statusText : ''}`);
  if (tab.console.errors || tab.console.warnings)
    lines.push(`- Console: ${tab.console.errors} errors, ${tab.console.warnings} warnings`);
  return lines;
}

export function renderTabsMarkdown(tabs: TabHeader[]): string[] {
  if (!tabs.length)
    return ['No open tabs. Navigate to a URL to create one.'];
  const lines: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const current = tab.current ? ' (current)' : '';
    const crashed = tab.crashed ? ' [crashed]' : '';
    lines.push(`- ${i}:${current} [${tab.title}](${tab.url})${crashed}`);
  }
  return lines;
}

/** Lone surrogates are not valid JSON-RPC payloads. */
function sanitizeUnicode(text: string): string {
  return text.toWellFormed?.() ?? text;
}
