import * as z from 'zod';

import { defineGlobalTool, defineInstanceTool } from '../mcp/tool';
import { defaultWindowSize } from '../browser/instance';

const open = defineGlobalTool({
  schema: {
    name: 'browser_open',
    description: 'Launch a browser instance and return its instance_id, which every other browser tool takes. ' +
      'Reuses the named profile directly when it is free, so cookies and logins accumulate across sessions; ' +
      'under concurrency it clones the profile into an ephemeral slot instead.',
    inputSchema: z.object({
      profile: z.string().nullable().optional().describe('Named persistent profile. Defaults to "default". Pass null for a throwaway profile that is deleted on close.'),
      user_data_dir: z.string().optional().describe('Use this Chromium user-data directory verbatim. Never deleted. Overrides profile.'),
      headless: z.boolean().optional().describe('Run without a visible window. Defaults to true unless the server was started with --headed.'),
      window_size: z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }).optional().describe(`Initial window size in CSS pixels. Defaults to ${defaultWindowSize.width}x${defaultWindowSize.height}.`),
      proxy: z.string().optional().describe('Proxy server URL, e.g. "http://host:3128" or "socks5://host:1080".'),
      timezone: z.string().optional().describe('IANA timezone to report, e.g. "Europe/Berlin".'),
      fingerprint: z.number().int().nonnegative().optional().describe('Identity seed. Selects one whole machine\'s hardware and GPU strings. Persisted in the profile so the same profile keeps reporting the same machine; omit to behave exactly like stock Chrome.'),
      idle_timeout: z.number().int().nonnegative().optional().describe('Close this instance after this many idle seconds. 0 disables. Defaults to the server setting.'),
    }),
    type: 'action',
  },

  handle: async (host, params, response) => {
    const instance = await host.instances.open({
      profile: params.profile,
      userDataDir: params.user_data_dir,
      headless: params.headless,
      windowSize: params.window_size,
      proxy: params.proxy,
      timezone: params.timezone,
      fingerprint: params.fingerprint,
      idleTimeout: params.idle_timeout,
    });
    const summary = host.instances.summaries().find(s => s.instance_id === instance.id)!;
    response.addTextResult(JSON.stringify(summary, null, 2));
  },
});

const list = defineGlobalTool({
  schema: {
    name: 'browser_list',
    description: 'List the live browser instances with their profile, tab count and current URL.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (host, params, response) => {
    const summaries = host.instances.summaries();
    if (!summaries.length) {
      response.addTextResult('No browser instances are open. Call browser_open to start one.');
      return;
    }
    response.addTextResult(JSON.stringify(summaries, null, 2));
  },
});

const close = defineInstanceTool({
  schema: {
    name: 'browser_close',
    description: 'Close a browser instance and release its profile.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    const id = instance.id;
    await instance.close();
    response.addTextResult(`Closed browser instance ${id}.`);
    response.setClose();
  },
});

export default [open, list, close];
