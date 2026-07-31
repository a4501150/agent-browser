/** Bodies derived from playwright-core/src/tools/backend/mouse.ts (Apache-2.0, v1.62.1). */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { formatObjectOrVoid } from '../vendor/stringUtils';

const mouse = defineTabTool({
  schema: {
    name: 'browser_mouse',
    title: 'Mouse at coordinates',
    description: 'Drive the mouse by viewport coordinates, in CSS pixels. Prefer browser_click with a ref where you can: ' +
      'coordinates are brittle, and for an element inside a cross-origin iframe the ref path also does the ' +
      'frame-to-viewport translation that raw coordinates do not.',
    inputSchema: z.object({
      action: z.enum(['move', 'click', 'down', 'up', 'drag']).describe('What to do.'),
      x: z.number().describe('X coordinate, viewport-relative.'),
      y: z.number().describe('Y coordinate, viewport-relative.'),
      to_x: z.number().optional().describe('Destination X, required for "drag".'),
      to_y: z.number().optional().describe('Destination Y, required for "drag".'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Defaults to left.'),
      click_count: z.number().int().positive().optional().describe('Clicks to deliver, for "click". 2 is a double click.'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    const mouseApi = tab.page.mouse;

    switch (params.action) {
      case 'move':
        response.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
        await mouseApi.move(params.x, params.y);
        break;

      case 'down': {
        const options = { button: params.button };
        response.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
        response.addCode(`await page.mouse.down(${formatObjectOrVoid(options)});`);
        await mouseApi.move(params.x, params.y);
        await mouseApi.down(options);
        break;
      }

      case 'up': {
        const options = { button: params.button };
        response.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
        response.addCode(`await page.mouse.up(${formatObjectOrVoid(options)});`);
        await mouseApi.move(params.x, params.y);
        await mouseApi.up(options);
        break;
      }

      case 'click': {
        response.setIncludeSnapshot();
        const options = { button: params.button, clickCount: params.click_count };
        const formatted = formatObjectOrVoid(options);
        response.addCode(`await page.mouse.click(${params.x}, ${params.y}${formatted ? `, ${formatted}` : ''});`);
        await tab.waitForCompletion(async () => {
          await mouseApi.click(params.x, params.y, options);
        });
        break;
      }

      case 'drag': {
        if (params.to_x === undefined || params.to_y === undefined)
          throw new Error('"to_x" and "to_y" are required for action "drag".');
        response.setIncludeSnapshot();
        response.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
        response.addCode('await page.mouse.down();');
        response.addCode(`await page.mouse.move(${params.to_x}, ${params.to_y});`);
        response.addCode('await page.mouse.up();');
        await tab.waitForCompletion(async () => {
          await mouseApi.move(params.x, params.y);
          await mouseApi.down();
          await mouseApi.move(params.to_x!, params.to_y!);
          await mouseApi.up();
        });
        break;
      }
    }
  },
});

const defaultScrollAmount = 500;

const scroll = defineTabTool({
  schema: {
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scroll the page by an amount, or all the way to the top or bottom.',
    inputSchema: z.object({
      direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).describe('Where to scroll. "top" and "bottom" ignore amount.'),
      amount: z.number().positive().optional().describe(`Pixels to scroll. Defaults to ${defaultScrollAmount}.`),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const amount = params.amount ?? defaultScrollAmount;

    if (params.direction === 'top' || params.direction === 'bottom') {
      const top = params.direction === 'top';
      response.addCode(`await page.evaluate(() => window.scrollTo(0, ${top ? '0' : 'document.body.scrollHeight'}));`);
      await tab.waitForCompletion(async () => {
        await tab.page.evaluate(t => window.scrollTo({ left: 0, top: t ? 0 : document.documentElement.scrollHeight }), top);
      });
      return;
    }

    const deltaX = params.direction === 'right' ? amount : params.direction === 'left' ? -amount : 0;
    const deltaY = params.direction === 'down' ? amount : params.direction === 'up' ? -amount : 0;
    response.addCode(`await page.mouse.wheel(${deltaX}, ${deltaY});`);
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.wheel(deltaX, deltaY);
    });
  },
});

export default [mouse, scroll];
