import * as z from 'zod';

import { defineTabTool } from '../mcp/tool';
import { escapeWithQuotes } from '../vendor/stringUtils';

import type * as playwright from 'playwright-core';

const defaultTimeout = 30_000;

type Payload = { element: unknown; code: string; args: unknown[]; depth: number };
type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string };

/**
 * Runs inside the page. Accepts an expression, an arrow function, or a
 * statement body with `return`, awaits whatever it produces, and serializes the
 * result to something structured-cloneable so a DOM node or a function in the
 * result does not fail the whole call.
 */
function pageRunner(payload: Payload): Promise<Outcome> {
  const { element, code, args, depth: maxDepth } = payload;

  const serialize = (value: any, seen: Set<any>, depth: number): any => {
    if (value === undefined)
      return { __type: 'undefined' };
    if (value === null)
      return null;
    const type = typeof value;
    if (type === 'string' || type === 'boolean')
      return value;
    if (type === 'number')
      return Number.isFinite(value) ? value : { __type: 'number', value: String(value) };
    if (type === 'bigint')
      return { __type: 'bigint', value: String(value) };
    if (type === 'symbol')
      return { __type: 'symbol', value: String(value) };
    if (type === 'function')
      return { __type: 'function', name: value.name || '(anonymous)' };
    if (value instanceof Date)
      return { __type: 'Date', value: value.toISOString() };
    if (value instanceof RegExp)
      return { __type: 'RegExp', value: String(value) };
    if (value instanceof Error)
      return { __type: 'Error', name: value.name, message: value.message, stack: value.stack };
    if (typeof Node !== 'undefined' && value instanceof Node) {
      const el = value as any;
      return {
        __type: 'Node',
        nodeName: el.nodeName,
        id: el.id || undefined,
        className: (typeof el.className === 'string' && el.className) || undefined,
        text: (el.textContent || '').trim() || undefined,
      };
    }
    if (depth >= maxDepth)
      return { __type: 'truncated' };
    if (seen.has(value))
      return { __type: 'circular' };
    seen.add(value);
    try {
      if (Array.isArray(value))
        return value.map(v => serialize(v, seen, depth + 1));
      if (value instanceof Map)
        return { __type: 'Map', entries: [...value.entries()].map(([k, v]) => [serialize(k, seen, depth + 1), serialize(v, seen, depth + 1)]) };
      if (value instanceof Set)
        return { __type: 'Set', values: [...value.values()].map(v => serialize(v, seen, depth + 1)) };
      if (ArrayBuffer.isView(value))
        return { __type: value.constructor.name, values: Array.from(value as any) };
      const out: Record<string, any> = {};
      for (const key of Object.keys(value)) {
        try {
          out[key] = serialize(value[key], seen, depth + 1);
        } catch (e: any) {
          out[key] = { __type: 'thrown', message: String(e && e.message || e) };
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const invoke = async (): Promise<unknown> => {
    let value: any;
    try {
      // An expression or an arrow/function literal.
      value = (0, eval)('(' + code + ')');
    } catch (e) {
      if (!(e instanceof SyntaxError))
        throw e;
      // A statement body, possibly with top-level await. A 'use strict'
      // directive is illegal in a function with a rest parameter, so the body
      // is wrapped in an arrow instead of being prefixed with one.
      value = new Function('element', '...args', 'return (async () => {' + code + '})();');
    }
    if (typeof value === 'function')
      return await value(...(element !== null && element !== undefined ? [element, ...args] : args));
    return await value;
  };

  return invoke().then(
    value => ({ ok: true as const, value: serialize(value, new Set(), 0) }),
    error => ({
      ok: false as const,
      message: String(error && error.message !== undefined ? error.message : error),
      stack: error && error.stack ? String(error.stack) : undefined,
    }),
  );
}

const runJavaScript = defineTabTool({
  schema: {
    name: 'browser_run_javascript',
    description: 'Evaluate JavaScript in the page and return the result. Accepts an expression, an arrow function, or ' +
      'statements with a return. Promises are awaited, including top-level await. When target is given the element is ' +
      'passed as the first argument.',
    inputSchema: z.object({
      code: z.string().describe('JavaScript to run, e.g. "document.title", "() => location.href", or "const r = await fetch(u); return r.status;".'),
      target: z.string().optional().describe('Pass this element to the code as its first argument. A ref from the page outline, a CSS selector, or an XPath.'),
      args: z.array(z.any()).optional().describe('JSON-serializable arguments, appended after the element argument.'),
      timeout: z.number().int().positive().optional().describe(`Milliseconds to wait for the result. Defaults to ${defaultTimeout}.`),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    let elementHandle = null;
    let resolvedName = '';
    // The element's own frame, not the page: an element handle from a
    // cross-origin iframe cannot be adopted into the main frame's context, so
    // evaluating there fails with "Unable to adopt element handle from a
    // different document". Frame.evaluate takes the same single-argument shape
    // as Page.evaluate, so one page-side function serves both.
    let scope: playwright.Frame | playwright.Page = tab.page;
    if (params.target) {
      const resolved = await tab.targetLocator({ target: params.target });
      resolvedName = resolved.resolved;
      elementHandle = await resolved.locator.elementHandle(tab.actionTimeoutOptions);
      scope = (await elementHandle?.ownerFrame()) ?? tab.page;
    }

    response.addCode(params.target
      ? `await page.${resolvedName}.evaluate(${escapeWithQuotes(params.code)});`
      : `await page.evaluate(${escapeWithQuotes(params.code)});`);

    const timeout = params.timeout ?? defaultTimeout;
    const payload = { element: elementHandle, code: params.code, args: params.args ?? [], depth: 6 };

    try {
      const evaluation = scope.evaluate(pageRunner, payload as any);
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeout);
      });
      let outcome: Outcome | 'timeout';
      try {
        outcome = await Promise.race([evaluation, expiry]);
      } finally {
        if (timer)
          clearTimeout(timer);
      }

      if (outcome === 'timeout') {
        // Distinguish this from an ordinary Playwright timeout: the usual cause
        // is an awaited promise that never settles.
        void evaluation.catch(() => {});
        response.addError(
          `The script did not finish within ${timeout}ms. An awaited promise may never settle. ` +
          'The evaluation is still running in the page; raise "timeout" or make the code resolve.');
        return;
      }

      if (!outcome.ok) {
        response.addError(`The script threw: ${outcome.message}${outcome.stack ? `\n${outcome.stack}` : ''}`);
        return;
      }

      const text = JSON.stringify(outcome.value, null, 2) ?? 'undefined';
      await response.addResult('Result', text, { prefix: 'result', ext: 'json' });
    } finally {
      await elementHandle?.dispose().catch(() => {});
    }
  },
});

export default [runJavaScript];
