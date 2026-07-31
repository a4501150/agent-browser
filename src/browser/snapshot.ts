import type * as playwright from 'playwright-core';

/**
 * The one place `ariaSnapshot` is called. `mode: 'ai'` is what produces the
 * `[ref=eN]` handles every action tool accepts, and what recurses into
 * `<iframe>`s — including cross-origin ones, whose refs come back prefixed
 * (`f1e3` = frame 1, element 3). If this call ever silently stops honouring
 * `mode: 'ai'` the snapshot still returns, just without refs, so the
 * cross-frame test in tests/ asserts on their presence.
 */
export async function captureAriaSnapshot(
  target: playwright.Page | playwright.Locator,
  options?: { depth?: number; signal?: AbortSignal },
): Promise<string> {
  return await target.ariaSnapshot({ mode: 'ai', depth: options?.depth, signal: options?.signal });
}

/** `e12` for a top-level element, `f1e3` for one inside a frame. */
export const refPattern = /^(f\d+)?e\d+$/;
