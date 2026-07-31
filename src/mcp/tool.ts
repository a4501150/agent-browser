/**
 * Derived from playwright-core/src/tools/backend/tool.ts (Apache-2.0, tag v1.62.1).
 * The three tool kinds and the instance_id injection are ours; the modal-state
 * contract and the defineTabTool guard are upstream's.
 */
import * as z from 'zod';

import type * as playwright from 'playwright-core';
import type { Instance } from '../browser/instance';
import type { Tab } from '../browser/tab';
import type { Response } from './response';
import type { ServerHost } from './host';

export type FileUploadModalState = {
  type: 'fileChooser';
  description: string;
  fileChooser: playwright.FileChooser;
  clearedBy: string;
};

export type DialogModalState = {
  type: 'dialog';
  description: string;
  dialog: playwright.Dialog;
  clearedBy: string;
};

export type ModalState = FileUploadModalState | DialogModalState;

export type ToolType = 'input' | 'action' | 'readOnly';

export type ToolSchema = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  type: ToolType;
};

/** What the dispatcher needs; the handler's first argument is resolved by `kind`. */
export type ToolDefinition = {
  kind: 'global' | 'instance' | 'tab';
  schema: ToolSchema;
  clearsModalState?: ModalState['type'];
  handle: (target: any, params: any, response: Response, signal?: AbortSignal) => Promise<void>;
};

const instanceIdField = {
  instance_id: z.string().describe('Browser instance id returned by browser_open.'),
};

/** A tool that needs no browser: browser_open, browser_list and the web_* tools. */
export function defineGlobalTool<Input extends z.ZodObject>(tool: {
  schema: { name: string; title: string; description: string; inputSchema: Input; type: ToolType };
  handle: (host: ServerHost, params: z.output<Input>, response: Response, signal?: AbortSignal) => Promise<void>;
}): ToolDefinition {
  return { kind: 'global', schema: tool.schema, handle: tool.handle };
}

/** A tool that operates on a whole instance rather than one tab. */
export function defineInstanceTool<Input extends z.ZodObject>(tool: {
  schema: { name: string; title: string; description: string; inputSchema: Input; type: ToolType };
  handle: (instance: Instance, params: z.output<Input>, response: Response, signal?: AbortSignal) => Promise<void>;
}): ToolDefinition {
  return {
    kind: 'instance',
    schema: { ...tool.schema, inputSchema: tool.schema.inputSchema.extend(instanceIdField) },
    handle: tool.handle,
  };
}

/**
 * A tool that operates on the instance's current tab. Refuses to run while an
 * unhandled dialog or file chooser is up, unless it is the tool that clears it.
 */
export function defineTabTool<Input extends z.ZodObject>(tool: {
  schema: { name: string; title: string; description: string; inputSchema: Input; type: ToolType };
  clearsModalState?: ModalState['type'];
  /** browser_upload_file also works without a file chooser, by targeting the input directly. */
  modalStateOptional?: boolean;
  handle: (tab: Tab, params: z.output<Input>, response: Response, signal?: AbortSignal) => Promise<void>;
}): ToolDefinition {
  return {
    kind: 'tab',
    schema: { ...tool.schema, inputSchema: tool.schema.inputSchema.extend(instanceIdField) },
    clearsModalState: tool.clearsModalState,
    handle: async (instance: Instance, params: any, response: Response, signal?: AbortSignal) => {
      const tab = await instance.ensureTab();
      const modalStates = tab.modalStates().map(state => state.type);
      const unhandled = modalStates.filter(state => state !== tool.clearsModalState);
      if (unhandled.length)
        response.addError(`Error: Tool "${tool.schema.name}" does not handle the modal state.`);
      else if (tool.clearsModalState && !tool.modalStateOptional && !modalStates.length)
        response.addError(`Error: The tool "${tool.schema.name}" can only be used when there is related modal state present.`);
      else
        return tool.handle(tab, params, response, signal);
    },
  };
}
