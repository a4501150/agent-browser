/**
 * Bodies derived from playwright-core/src/tools/backend/{snapshot,keyboard,form}.ts
 * (Apache-2.0, v1.62.1). `check`/`uncheck` fold into browser_click, and
 * `press_sequentially` into browser_type_text { slowly }.
 */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { elementSchema } from './perception';
import { escapeWithQuotes, formatObject, formatObjectOrVoid } from '../vendor/stringUtils';

const click = defineTabTool({
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Click an element. Works identically on elements inside cross-origin iframes: pass their frame-prefixed ref. ' +
      'Set checked to tick or untick a checkbox or radio instead of clicking it.',
    inputSchema: elementSchema.extend({
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Defaults to left.'),
      double: z.boolean().optional().describe('Perform a double click.'),
      modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to hold.'),
      checked: z.boolean().optional().describe('For a checkbox or radio: set it to this state rather than clicking, which is idempotent.'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const { locator, resolved } = await tab.targetLocator(params);

    if (params.checked !== undefined) {
      response.addCode(`await page.${resolved}.setChecked(${params.checked});`);
      await tab.waitForCompletion(async () => {
        await locator.setChecked(params.checked!, tab.actionTimeoutOptions);
      });
      return;
    }

    const options = { button: params.button, modifiers: params.modifiers, ...tab.actionTimeoutOptions };
    const optionsArg = formatObjectOrVoid(options);
    response.addCode(`await page.${resolved}.${params.double ? 'dblclick' : 'click'}(${optionsArg});`);

    await tab.waitForCompletion(async () => {
      if (params.double)
        await locator.dblclick(options);
      else
        await locator.click(options);
    });
  },
});

const hover = defineTabTool({
  schema: {
    name: 'browser_hover',
    title: 'Hover',
    description: 'Move the mouse over an element.',
    inputSchema: elementSchema,
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const { locator, resolved } = await tab.targetLocator(params);
    response.addCode(`await page.${resolved}.hover();`);
    await locator.hover(tab.actionTimeoutOptions);
  },
});

const drag = defineTabTool({
  schema: {
    name: 'browser_drag',
    title: 'Drag and drop',
    description: 'Drag one element onto another.',
    inputSchema: z.object({
      from: z.string().describe('Source element: a ref from the page outline, a CSS selector, or an XPath.'),
      to: z.string().describe('Target element: a ref from the page outline, a CSS selector, or an XPath.'),
      element: z.string().optional().describe('Short human-readable description of what is being dragged, used in error messages.'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const [start, end] = await tab.targetLocators([
      { target: params.from, element: params.element },
      { target: params.to },
    ]);
    await tab.waitForCompletion(async () => {
      await start.locator.dragTo(end.locator, tab.actionTimeoutOptions);
    });
    response.addCode(`await page.${start.resolved}.dragTo(page.${end.resolved});`);
  },
});

const typeText = defineTabTool({
  schema: {
    name: 'browser_type_text',
    title: 'Type text',
    description: 'Type into an editable element. Fills the whole value at once unless slowly is set.',
    inputSchema: elementSchema.extend({
      text: z.string().describe('Text to type.'),
      submit: z.boolean().optional().describe('Press Enter afterwards.'),
      slowly: z.boolean().optional().describe('Type one character at a time, which triggers the page\'s key handlers. Slower.'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    const { locator, resolved } = await tab.targetLocator(params);

    const action = async () => {
      if (params.slowly) {
        response.setIncludeSnapshot();
        // `slowly` changes only *how* the value is entered, so clear first:
        // pressSequentially types at the cursor and would otherwise append.
        response.addCode(`await page.${resolved}.fill('');`);
        response.addCode(`await page.${resolved}.pressSequentially(${escapeWithQuotes(params.text)});`);
        await locator.fill('', tab.actionTimeoutOptions);
        await locator.pressSequentially(params.text, tab.actionTimeoutOptions);
      } else {
        response.addCode(`await page.${resolved}.fill(${escapeWithQuotes(params.text)});`);
        await locator.fill(params.text, tab.actionTimeoutOptions);
      }
      if (params.submit) {
        response.setIncludeSnapshot();
        response.addCode(`await page.${resolved}.press('Enter');`);
        await locator.press('Enter', tab.actionTimeoutOptions);
      }
    };

    if (params.submit || params.slowly)
      await tab.waitForCompletion(action);
    else
      await action();
  },
});

const pressKey = defineTabTool({
  schema: {
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Press a key or key combination, e.g. "Enter", "ArrowLeft", "Control+a", "a".',
    inputSchema: z.object({
      key: z.string().describe('Key name or character, optionally with modifiers joined by "+".'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.press('${params.key}');`);
    // Enter commonly submits, so wait for the page to settle afterwards.
    if (params.key === 'Enter') {
      response.setIncludeSnapshot();
      await tab.waitForCompletion(async () => {
        await tab.page.keyboard.press('Enter');
      });
    } else {
      await tab.page.keyboard.press(params.key);
    }
  },
});

const fillForm = defineTabTool({
  schema: {
    name: 'browser_fill_form',
    title: 'Fill a form',
    description: 'Fill several form fields in one call.',
    inputSchema: z.object({
      fields: z.array(z.object({
        target: z.string().describe('A ref from the page outline, a CSS selector, or an XPath.'),
        element: z.string().optional().describe('Short human-readable field name, used in error messages.'),
        type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).describe('Kind of field.'),
        value: z.string().describe('Value to set. For checkbox and radio use "true" or "false". For combobox use the option\'s visible text.'),
      })).min(1).describe('Fields to fill, in order.'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    for (const field of params.fields) {
      const { locator, resolved } = await tab.targetLocator({ element: field.element, target: field.target });
      if (field.type === 'textbox' || field.type === 'slider') {
        await locator.fill(field.value, tab.actionTimeoutOptions);
        response.addCode(`await page.${resolved}.fill(${escapeWithQuotes(field.value)});`);
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        await locator.setChecked(field.value === 'true', tab.actionTimeoutOptions);
        response.addCode(`await page.${resolved}.setChecked(${field.value === 'true'});`);
      } else {
        await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
        response.addCode(`await page.${resolved}.selectOption(${formatObject({ label: field.value }, '  ', 'oneline')});`);
      }
    }
    response.addTextResult(`Filled ${params.fields.length} field(s).`);
  },
});

export default [click, hover, drag, typeText, pressKey, fillForm];
