/**
 * Derived from playwright-core/src/tools/backend/utils.ts (Apache-2.0, tag
 * v1.62.1).
 */
import type * as playwright from 'playwright-core';
import type { Tab } from './tab';

/**
 * Run an action, then wait for the page to settle: if it navigated, for load;
 * otherwise for the requests the action kicked off.
 */
export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const settleMs = tab.instance.config.timeouts.settle;
  const requests: playwright.Request[] = [];

  const requestListener = (request: playwright.Request) => requests.push(request);
  tab.page.on('request', requestListener);

  let result: R;
  try {
    result = await callback();
    await tab.waitForTimeout(settleMs);
  } finally {
    tab.page.off('request', requestListener);
  }

  const requestedNavigation = requests.some(request => request.isNavigationRequest());
  if (requestedNavigation) {
    await tab.page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    return result;
  }

  const promises: Promise<any>[] = [];
  for (const request of requests) {
    if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType()))
      promises.push(request.response().then(r => r?.finished()).catch(() => {}));
    else
      promises.push(request.response().catch(() => {}));
  }
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
  await Promise.race([Promise.all(promises), timeout]);
  if (requests.length)
    await tab.waitForTimeout(settleMs);

  return result;
}

export function eventWaiter<T>(page: playwright.Page, event: string, timeout: number): { promise: Promise<T | undefined>; abort: () => void } {
  const disposables: (() => void)[] = [];

  const eventPromise = new Promise<T | undefined>(resolve => {
    page.on(event as any, resolve as any);
    disposables.push(() => page.off(event as any, resolve as any));
  });

  let abort: () => void;
  const abortPromise = new Promise<T | undefined>(resolve => {
    abort = () => resolve(undefined);
  });

  const timeoutPromise = new Promise<T | undefined>(f => {
    const timeoutId = setTimeout(() => f(undefined), timeout);
    disposables.push(() => clearTimeout(timeoutId));
  });

  return {
    promise: Promise.race([eventPromise, abortPromise, timeoutPromise]).finally(() => disposables.forEach(dispose => dispose())),
    abort: abort!,
  };
}
