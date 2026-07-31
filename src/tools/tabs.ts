/** Body derived from playwright-core/src/tools/backend/tabs.ts (Apache-2.0, v1.62.1). */
import * as z from 'zod';

import { defineInstanceTool } from '../mcp/tool';
import { renderTabsMarkdown } from '../mcp/response';

const tabs = defineInstanceTool({
  schema: {
    name: 'browser_tabs',
    description: 'List, open, select or close tabs.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'select', 'close']).describe('What to do.'),
      url: z.string().optional().describe('URL to open, for action "new".'),
      index: z.number().int().nonnegative().optional().describe('Tab index, for "select" and "close". Closing with no index closes the current tab.'),
    }),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    switch (params.action) {
      case 'list':
        await instance.ensureTab();
        break;
      case 'new': {
        const tab = await instance.newTab();
        if (params.url) {
          const url = await tab.checkUrlAndNavigate(params.url);
          response.setIncludeSnapshot();
          response.addCode(`await page.goto('${url}');`);
        }
        break;
      }
      case 'close':
        await instance.closeTab(params.index);
        break;
      case 'select':
        if (params.index === undefined)
          throw new Error('"index" is required for action "select".');
        await instance.selectTab(params.index);
        response.setIncludeSnapshot();
        break;
    }
    const headers = await Promise.all(instance.tabs().map(tab => tab.headerSnapshot()));
    response.addTextResult(renderTabsMarkdown(headers).join('\n'));
  },
});

export default [tabs];
