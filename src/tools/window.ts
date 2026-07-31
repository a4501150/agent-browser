import * as z from 'zod';

import { defineInstanceTool } from '../mcp/tool';

const setWindowSize = defineInstanceTool({
  schema: {
    name: 'browser_set_window_size',
    description: 'Resize the real browser window. The layout viewport follows it, because no device-metrics emulation ' +
      'override is ever set — so window.outerWidth, innerWidth, screen.* and devicePixelRatio stay coherent, and in ' +
      'headed mode the window you are watching actually changes.',
    inputSchema: z.object({
      width: z.number().int().positive().describe('Window width in pixels.'),
      height: z.number().int().positive().describe('Window height in pixels.'),
    }),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    await instance.setWindowSize(params.width, params.height);
    const tab = await instance.ensureTab();
    const actual = await tab.page.evaluate(() => ({
      inner: { width: window.innerWidth, height: window.innerHeight },
      outer: { width: window.outerWidth, height: window.outerHeight },
    })).catch(() => undefined);
    response.addTextResult(actual
      ? `Window is now ${actual.outer.width}x${actual.outer.height}, viewport ${actual.inner.width}x${actual.inner.height}.`
      : `Requested window size ${params.width}x${params.height}.`);
  },
});

export default [setWindowSize];
