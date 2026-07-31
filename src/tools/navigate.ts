/** Bodies derived from playwright-core/src/tools/backend/navigate.ts (Apache-2.0, v1.62.1). */
import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';

const navigate = defineTabTool({
  schema: {
    name: 'browser_navigate',
    title: 'Navigate',
    description: 'Navigate to a URL, or move through history. Provide exactly one of url or action.',
    inputSchema: z.object({
      url: z.string().optional().describe('The URL to navigate to.'),
      action: z.enum(['back', 'forward', 'reload']).optional().describe('History action to perform instead of navigating to a URL.'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    if (!!params.url === !!params.action)
      throw new Error('Provide exactly one of "url" or "action".');

    response.setIncludeSnapshot();

    if (params.url) {
      const url = await tab.checkUrlAndNavigate(params.url);
      response.addCode(`await page.goto('${url}');`);
      return;
    }

    switch (params.action) {
      case 'back':
        await tab.page.goBack({ waitUntil: 'commit', ...tab.navigationTimeoutOptions });
        response.addCode('await page.goBack();');
        break;
      case 'forward':
        await tab.page.goForward({ waitUntil: 'commit', ...tab.navigationTimeoutOptions });
        response.addCode('await page.goForward();');
        break;
      case 'reload':
        await tab.page.reload(tab.navigationTimeoutOptions);
        response.addCode('await page.reload();');
        break;
    }
  },
});

export default [navigate];
