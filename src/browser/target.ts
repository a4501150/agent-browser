import { refPattern } from './snapshot';

import type * as playwright from 'playwright-core';

export type ResolvedTarget = {
  locator: playwright.Locator;
  /** How the locator reads in the generated code section. */
  resolved: string;
};

/**
 * One `target` field, three accepted forms:
 *   - a snapshot ref (`e12`, `f1e3`), resolved through the `aria-ref` selector
 *     engine, which is what carries frame-prefixed refs across a process
 *     boundary and does the per-boundary coordinate shift for us;
 *   - an XPath, detected by a leading `/`;
 *   - anything else, treated as CSS.
 *
 * Resolving refs ourselves rather than parsing Playwright *locator expressions*
 * is why we do not vendor locatorGenerators.ts / locatorParser.ts.
 */
export async function resolveTarget(
  page: playwright.Page,
  params: { target: string; element?: string },
): Promise<ResolvedTarget> {
  const target = params.target;

  if (refPattern.test(target)) {
    let locator = page.locator(`aria-ref=${target}`);
    if (params.element)
      locator = locator.describe(params.element);
    try {
      const normalized = await locator.normalize();
      return { locator, resolved: String(normalized) };
    } catch {
      throw new Error(`Ref "${target}" is not in the current page snapshot. Call browser_read_page for a fresh one.`);
    }
  }

  const selector = target.startsWith('/') ? `xpath=${target}` : `css=${target}`;
  const locator = page.locator(selector);
  if (await locator.count() === 0)
    throw new Error(`"${target}" does not match any element on the page.`);
  return { locator: params.element ? locator.describe(params.element) : locator, resolved: `locator(${JSON.stringify(selector)})` };
}

export async function resolveTargets(
  page: playwright.Page,
  params: { target: string; element?: string }[],
): Promise<ResolvedTarget[]> {
  return Promise.all(params.map(param => resolveTarget(page, param)));
}
