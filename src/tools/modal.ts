/**
 * Bodies derived from playwright-core/src/tools/backend/{wait,dialogs,files}.ts
 * (Apache-2.0, v1.62.1). browser_upload_file additionally accepts a target, so
 * it works without a file chooser having opened.
 */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { resolveClientPath } from '../util/artifacts';

const waitFor = defineTabTool({
  schema: {
    name: 'browser_wait_for',
    description: 'Wait for an element to appear, for text to appear or disappear, or for a fixed time. At least one of ' +
      'target, text, text_gone or time is required. Conditions combine: every one given must be met, awaited in the ' +
      'order time, text_gone, text, target.',
    inputSchema: z.object({
      target: z.string().optional().describe('Wait until this element is visible. A ref from the page outline, a CSS selector, or an XPath.'),
      text: z.string().optional().describe('Wait until this text is visible.'),
      text_gone: z.string().optional().describe('Wait until this text is no longer visible.'),
      time: z.number().positive().optional().describe('Sleep this many seconds, whatever the page does. Capped at 30; for an operation that takes minutes, wait on a condition with a long timeout instead of repeating this.'),
      timeout: z.number().int().positive().optional().describe('How long to wait in milliseconds for each condition before failing. Not capped. Defaults to the action timeout.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (!params.target && !params.text && !params.text_gone && !params.time)
      throw new Error('Provide at least one of "target", "text", "text_gone" or "time".');

    const timeoutOptions = params.timeout ? { timeout: params.timeout } : tab.actionTimeoutOptions;

    if (params.time) {
      const ms = Math.min(30_000, params.time * 1000);
      response.addCode(`await page.waitForTimeout(${ms});`);
      await new Promise(f => setTimeout(f, ms));
    }

    if (params.text_gone) {
      response.addCode(`await page.getByText(${JSON.stringify(params.text_gone)}).first().waitFor({ state: 'hidden' });`);
      await tab.page.getByText(params.text_gone).first().waitFor({ state: 'hidden', ...timeoutOptions });
    }

    if (params.text) {
      response.addCode(`await page.getByText(${JSON.stringify(params.text)}).first().waitFor({ state: 'visible' });`);
      await tab.page.getByText(params.text).first().waitFor({ state: 'visible', ...timeoutOptions });
    }

    if (params.target) {
      const { locator, resolved } = await tab.targetLocator({ target: params.target });
      response.addCode(`await page.${resolved}.waitFor({ state: 'visible' });`);
      await locator.waitFor({ state: 'visible', ...timeoutOptions });
    }

    response.addTextResult(`Waited for ${params.target ?? params.text ?? params.text_gone ?? `${params.time}s`}.`);
    response.setIncludeSnapshot();
  },
});

const handleDialog = defineTabTool({
  schema: {
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss the open JavaScript dialog. A dialog blocks the renderer, so no other tool works until ' +
      'it is handled.',
    inputSchema: z.object({
      accept: z.boolean().describe('Accept the dialog, rather than dismissing it.'),
      prompt_text: z.string().optional().describe('Text to enter, for a prompt() dialog.'),
    }),
    type: 'action',
  },

  clearsModalState: 'dialog',

  handle: async (tab, params, response) => {
    const dialogState = tab.modalStates().find(state => state.type === 'dialog');
    if (!dialogState)
      throw new Error('No dialog is open.');

    tab.clearModalState(dialogState);
    await tab.waitForCompletion(async () => {
      if (params.accept)
        await dialogState.dialog.accept(params.prompt_text);
      else
        await dialogState.dialog.dismiss();
    });
    response.addTextResult(`${params.accept ? 'Accepted' : 'Dismissed'} the dialog.`);
    response.setIncludeSnapshot();
  },
});

const uploadFile = defineTabTool({
  schema: {
    name: 'browser_upload_file',
    description: 'Set files on a file input. If a file chooser is open, this answers it; otherwise pass target to set the ' +
      'files directly, which also works when the real <input type=file> is hidden behind a styled button.',
    inputSchema: z.object({
      paths: z.array(z.string()).describe('Absolute paths of the files to upload. Pass an empty array to cancel an open file chooser.'),
      target: z.string().optional().describe('The file input, or any ancestor that contains it. A ref from the page outline, a CSS selector, or an XPath. Omit when a file chooser is already open.'),
    }),
    type: 'action',
  },

  clearsModalState: 'fileChooser',
  modalStateOptional: true,

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const paths = params.paths.map(p => resolveClientPath(tab.instance.cwd, p));

    const modalState = tab.modalStates().find(state => state.type === 'fileChooser');
    if (modalState) {
      tab.clearModalState(modalState);
      response.addCode(`await fileChooser.setFiles(${JSON.stringify(paths)});`);
      await tab.waitForCompletion(async () => {
        if (paths.length)
          await modalState.fileChooser.setFiles(paths);
      });
      response.addTextResult(paths.length ? `Set ${paths.length} file(s) on the open file chooser.` : 'Cancelled the file chooser.');
      return;
    }

    if (!params.target)
      throw new Error('No file chooser is open, so "target" is required to name the file input.');
    if (!paths.length)
      throw new Error('"paths" is empty and there is no file chooser to cancel.');

    const { locator, resolved } = await tab.targetLocator({ target: params.target });
    // A styled upload button usually wraps the real input; find it if the
    // target is not itself a file input.
    const isFileInput = await locator.evaluate(el => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
    const input = isFileInput ? locator : locator.locator('input[type=file]').first();
    if (!isFileInput && await input.count() === 0)
      throw new Error(`"${params.target}" is not a file input and contains none.`);

    response.addCode(`await page.${resolved}.setInputFiles(${JSON.stringify(paths)});`);
    await tab.waitForCompletion(async () => {
      await input.setInputFiles(paths, tab.actionTimeoutOptions);
    });
    response.addTextResult(`Set ${paths.length} file(s) on ${params.target}.`);
  },
});

export default [waitFor, handleDialog, uploadFile];
