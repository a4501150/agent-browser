/**
 * Bodies derived from playwright-core/src/tools/backend/{cookies,webstorage,storage,route}.ts
 * (Apache-2.0, v1.62.1), merged into one tool per subject since the argument
 * shapes were identical.
 */
import * as z from 'zod';

import { defineInstanceTool, defineTabTool } from '../mcp/tool';
import { resolveClientPath } from '../util/artifacts';

import type * as playwright from 'playwright-core';

const cookies = defineInstanceTool({
  schema: {
    name: 'browser_cookies',
    title: 'Cookies',
    description: 'List, read, set, delete or clear cookies.',
    inputSchema: z.object({
      action: z.enum(['list', 'get', 'set', 'delete', 'clear']).describe('What to do.'),
      name: z.string().optional().describe('Cookie name, for "get", "set" and "delete".'),
      value: z.string().optional().describe('Cookie value, for "set".'),
      domain: z.string().optional().describe('For "set", the cookie domain; defaults to the current page\'s host. For "list", filters by substring.'),
      path: z.string().optional().describe('For "set", the cookie path; defaults to "/". For "list", filters by prefix.'),
      url: z.string().optional().describe('For "set", associate the cookie with this URL instead of naming a domain and path.'),
      expires: z.number().optional().describe('Expiry as a Unix timestamp in seconds, for "set". Omit for a session cookie.'),
      secure: z.boolean().optional().describe('Secure flag, for "set".'),
      http_only: z.boolean().optional().describe('HttpOnly flag, for "set".'),
      same_site: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite attribute, for "set".'),
    }),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    const browserContext = await instance.ensureBrowserContext();

    switch (params.action) {
      case 'list': {
        let all = await browserContext.cookies();
        if (params.domain)
          all = all.filter(c => c.domain.includes(params.domain!));
        if (params.path)
          all = all.filter(c => c.path.startsWith(params.path!));
        response.addTextResult(all.length
          ? all.map(c => `${c.name}=${c.value} (domain: ${c.domain}, path: ${c.path}, secure: ${c.secure}, httpOnly: ${c.httpOnly}, sameSite: ${c.sameSite})`).join('\n')
          : 'No cookies found.');
        response.addCode('await page.context().cookies();');
        break;
      }

      case 'get': {
        if (!params.name)
          throw new Error('"name" is required for action "get".');
        const cookie = (await browserContext.cookies()).find(c => c.name === params.name);
        response.addTextResult(cookie
          ? `${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path}, secure: ${cookie.secure}, httpOnly: ${cookie.httpOnly}, sameSite: ${cookie.sameSite})`
          : `Cookie "${params.name}" not found.`);
        break;
      }

      case 'set': {
        if (!params.name || params.value === undefined)
          throw new Error('"name" and "value" are required for action "set".');
        const cookie: any = { name: params.name, value: params.value };
        if (params.url) {
          cookie.url = params.url;
        } else {
          const tab = await instance.ensureTab();
          const current = tab.page.url();
          let host: string | undefined;
          try {
            host = new URL(current).hostname;
          } catch {
            host = undefined;
          }
          if (!params.domain && !host)
            throw new Error('Cannot infer a cookie domain from about:blank. Pass "domain" or "url".');
          cookie.domain = params.domain || host;
          cookie.path = params.path || '/';
        }
        if (params.expires !== undefined)
          cookie.expires = params.expires;
        if (params.secure !== undefined)
          cookie.secure = params.secure;
        if (params.http_only !== undefined)
          cookie.httpOnly = params.http_only;
        if (params.same_site !== undefined)
          cookie.sameSite = params.same_site;
        await browserContext.addCookies([cookie]);
        response.addCode(`await page.context().addCookies([${JSON.stringify(cookie)}]);`);
        response.addTextResult(`Set cookie "${params.name}".`);
        break;
      }

      case 'delete': {
        if (!params.name)
          throw new Error('"name" is required for action "delete".');
        await browserContext.clearCookies({ name: params.name });
        response.addTextResult(`Deleted cookie "${params.name}".`);
        break;
      }

      case 'clear':
        await browserContext.clearCookies();
        response.addTextResult('Cleared all cookies.');
        break;
    }
  },
});

const storage = defineTabTool({
  schema: {
    name: 'browser_storage',
    title: 'Web storage',
    description: 'Read or write the current page\'s localStorage or sessionStorage.',
    inputSchema: z.object({
      area: z.enum(['local', 'session']).describe('Which storage area.'),
      action: z.enum(['list', 'get', 'set', 'delete', 'clear']).describe('What to do.'),
      key: z.string().optional().describe('Key, for "get", "set" and "delete".'),
      value: z.string().optional().describe('Value, for "set".'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const area = params.area === 'local' ? tab.page.localStorage : tab.page.sessionStorage;
    const label = params.area === 'local' ? 'localStorage' : 'sessionStorage';

    switch (params.action) {
      case 'list': {
        const items = await area.items();
        response.addTextResult(items.length ? items.map(i => `${i.name}=${i.value}`).join('\n') : `No ${label} items.`);
        response.addCode(`await page.${label}.items();`);
        break;
      }
      case 'get': {
        if (!params.key)
          throw new Error('"key" is required for action "get".');
        const value = await area.getItem(params.key);
        response.addTextResult(value === null ? `${label} key "${params.key}" not found.` : `${params.key}=${value}`);
        response.addCode(`await page.${label}.getItem(${JSON.stringify(params.key)});`);
        break;
      }
      case 'set':
        if (!params.key || params.value === undefined)
          throw new Error('"key" and "value" are required for action "set".');
        await area.setItem(params.key, params.value);
        response.addTextResult(`Set ${label} "${params.key}".`);
        response.addCode(`await page.${label}.setItem(${JSON.stringify(params.key)}, ${JSON.stringify(params.value)});`);
        break;
      case 'delete':
        if (!params.key)
          throw new Error('"key" is required for action "delete".');
        await area.removeItem(params.key);
        response.addTextResult(`Deleted ${label} "${params.key}".`);
        response.addCode(`await page.${label}.removeItem(${JSON.stringify(params.key)});`);
        break;
      case 'clear':
        await area.clear();
        response.addTextResult(`Cleared ${label}.`);
        response.addCode(`await page.${label}.clear();`);
        break;
    }
  },
});

const session = defineInstanceTool({
  schema: {
    name: 'browser_session',
    title: 'Save or load a session',
    description: 'Save cookies and local storage to a JSON file, or restore them from one. Loading clears the existing ' +
      'cookies and local storage first.',
    inputSchema: z.object({
      action: z.enum(['save', 'load']).describe('What to do.'),
      path: z.string().describe('Path to the JSON file.'),
    }),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    const browserContext = await instance.ensureBrowserContext();
    const file = resolveClientPath(instance.cwd, params.path);

    if (params.action === 'save') {
      const state = await browserContext.storageState();
      await instance.artifacts.write(file, JSON.stringify(state, null, 2));
      response.addCode(`await page.context().storageState({ path: '${file}' });`);
      response.addTextResult(`Saved session state to ${file}.`);
      return;
    }

    await browserContext.setStorageState(file);
    response.addCode(`await page.context().setStorageState('${file}');`);
    response.addTextResult(`Restored session state from ${file}.`);
  },
});

const interceptRequests = defineInstanceTool({
  schema: {
    name: 'browser_intercept_requests',
    title: 'Intercept requests',
    description: 'Block requests, serve a canned response, or rewrite request headers, for URLs matching a glob pattern.',
    inputSchema: z.object({
      action: z.enum(['add', 'remove', 'list']).describe('What to do.'),
      pattern: z.string().optional().describe('URL glob, e.g. "**/api/users" or "**/*.{png,jpg}". Required for "add"; for "remove" omit it to remove every rule.'),
      block: z.boolean().optional().describe('Abort matching requests instead of responding. Cannot be combined with status or body.'),
      status: z.number().int().optional().describe('Status code to respond with. Defaults to 200 when body is given.'),
      body: z.string().optional().describe('Response body to serve.'),
      content_type: z.string().optional().describe('Content-Type of the served body, e.g. "application/json".'),
      headers: z.record(z.string(), z.string()).optional().describe('Request headers to add or overwrite when the request is allowed through. Set a value to the empty string to remove the header.'),
    }),
    type: 'action',
  },

  handle: async (instance, params, response) => {
    switch (params.action) {
      case 'add': {
        if (!params.pattern)
          throw new Error('"pattern" is required for action "add".');
        if (params.block && (params.status !== undefined || params.body !== undefined))
          throw new Error('"block" cannot be combined with "status" or "body".');

        const handler = async (route: playwright.Route) => {
          if (params.block) {
            await route.abort('blockedbyclient');
            return;
          }
          if (params.body !== undefined || params.status !== undefined) {
            await route.fulfill({
              status: params.status ?? 200,
              contentType: params.content_type,
              body: params.body,
            });
            return;
          }
          const headers = { ...route.request().headers() };
          for (const [key, value] of Object.entries(params.headers ?? {})) {
            if (value === '')
              delete headers[key.toLowerCase()];
            else
              headers[key] = value;
          }
          await route.continue({ headers });
        };

        await instance.addRoute({
          pattern: params.pattern,
          block: params.block,
          status: params.status,
          body: params.body,
          contentType: params.content_type,
          headers: params.headers,
          handler,
        });
        response.addCode(`await page.context().route('${params.pattern}', handler);`);
        response.addTextResult(`Intercepting "${params.pattern}".`);
        break;
      }

      case 'remove': {
        const removed = await instance.removeRoute(params.pattern);
        response.addTextResult(params.pattern
          ? `Removed ${removed} rule(s) for "${params.pattern}".`
          : `Removed all ${removed} rule(s).`);
        break;
      }

      case 'list': {
        const rules = instance.routes();
        if (!rules.length) {
          response.addTextResult('No interception rules are active.');
          break;
        }
        response.addTextResult(rules.map((rule, i) => {
          const details: string[] = [];
          if (rule.block)
            details.push('block');
          if (rule.status !== undefined)
            details.push(`status=${rule.status}`);
          if (rule.body !== undefined)
            details.push(`body=${rule.body.length > 50 ? rule.body.slice(0, 50) + '...' : rule.body}`);
          if (rule.contentType)
            details.push(`content_type=${rule.contentType}`);
          if (rule.headers)
            details.push(`headers=${JSON.stringify(rule.headers)}`);
          return `${i + 1}. ${rule.pattern}${details.length ? ` (${details.join(', ')})` : ''}`;
        }).join('\n'));
        break;
      }
    }
  },
});

export default [cookies, storage, session, interceptRequests];
