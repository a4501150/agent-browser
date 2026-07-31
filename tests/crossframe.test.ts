/**
 * The headline feature. A cross-site out-of-process iframe must be ordinary DOM
 * at tool level: it appears in the outline with a frame-prefixed ref, actions on
 * that ref land inside the child with isTrusted: true, and the page's own JS
 * world is untouched — it still cannot reach contentDocument.
 *
 * The fixture puts the parent on `localhost` and the child on `127.0.0.1`:
 * different *sites*, so Chromium's default site isolation gives the child its
 * own process. Two ports on one host would be cross-origin but same-site, share
 * a process, and not exercise this path at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refFor, startHarness } from './helpers/client';
import { startFixtures } from './helpers/server';

import type { Harness } from './helpers/client';
import type { Fixtures } from './helpers/server';

let harness: Harness;
let fixtures: Fixtures;
let instance: string;
let outline: string;

beforeAll(async () => {
  fixtures = await startFixtures();
  harness = await startHarness();
  instance = await harness.open();
  await harness.call('browser_navigate', { instance_id: instance, url: fixtures.crossSiteUrl() });
  await harness.call('browser_wait_for', { instance_id: instance, text: 'child document' });
  outline = (await harness.call('browser_read_page', { instance_id: instance })).section('Snapshot')!;
}, 180_000);

afterAll(async () => {
  await harness?.close();
  await fixtures?.close();
});

async function evaluate(code: string, target?: string): Promise<unknown> {
  const result = await harness.call('browser_run_javascript', { instance_id: instance, code, ...(target ? { target } : {}) });
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.section('Result')!);
}

/** The child's button ref, from a freshly captured outline. */
async function childButtonRef(): Promise<string> {
  const snapshot = (await harness.call('browser_read_page', { instance_id: instance })).section('Snapshot')!;
  const ref = refFor(snapshot, 'button "click me"');
  expect(ref, `no child button in:\n${snapshot}`).toBeDefined();
  return ref!;
}

describe('cross-origin iframes', () => {
  it('is genuinely cross-site', async () => {
    // Different registrable domains, so with desktop Chromium's default full
    // site isolation the child runs in its own process. Verified out of band
    // during development: CDP Target.getTargets reports a separate
    // `type: 'iframe'` target for it, which same-process iframes never get.
    // No JS check can prove out-of-process-ness from the page, by design.
    expect(await evaluate('location.hostname')).toBe('localhost');
    expect(await evaluate('document.getElementById("f").src')).toContain('127.0.0.1');
  });

  it('appears in the page outline, nested under the iframe, with a frame-prefixed ref', () => {
    expect(outline).toContain('iframe');
    expect(outline).toContain('child document (cross-site)');
    const ref = refFor(outline, 'button "click me"');
    expect(ref).toMatch(/^f\d+e\d+$/);
  });

  it('is searchable with browser_find like any other content', async () => {
    const found = await harness.call('browser_find', { instance_id: instance, text: 'click me' });
    expect(found.section('Result')).toMatch(/button "click me" \[ref=f\d+e\d+\]/);
  });

  it('delivers a trusted click inside the child', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.crossSiteUrl() });
    await harness.call('browser_wait_for', { instance_id: instance, text: 'click me' });
    const ref = await childButtonRef();

    const click = await harness.call('browser_click', { instance_id: instance, target: ref, element: 'the child button' });
    expect(click.isError, click.text).toBe(false);

    // Read the child's own record of the event, through the child's frame.
    const record = await evaluate('el => JSON.stringify(el.ownerDocument.defaultView.__clicks)', ref) as string;
    const clicks = JSON.parse(record);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].isTrusted).toBe(true);
    // A click delivered at untranslated child-local coordinates lands nowhere
    // at all, silently, so a recorded event is also proof of the translation.
    expect(clicks[0].x).toBeGreaterThan(0);

    const after = (await harness.call('browser_read_page', { instance_id: instance })).section('Snapshot')!;
    expect(after).toContain('trusted=true count=1');
  });

  it('reads the child subtree on its own', async () => {
    const ref = await childButtonRef();
    const read = await harness.call('browser_read_page', { instance_id: instance, target: ref });
    expect(read.isError, read.text).toBe(false);
    expect(read.section('Snapshot')).toContain('click me');
  });

  it('rewrites the child DOM and types into it', async () => {
    const buttonRef = await childButtonRef();
    const hostname = await evaluate(
      'el => { const i = el.ownerDocument.createElement("input"); i.id = "typed"; el.after(i); return el.ownerDocument.location.hostname; }',
      buttonRef) as string;
    // Proof the write happened in the child document, not the parent.
    expect(hostname).toBe('127.0.0.1');

    const fresh = (await harness.call('browser_read_page', { instance_id: instance })).section('Snapshot')!;
    const inputRef = refFor(fresh, 'textbox')!;
    expect(inputRef).toMatch(/^f\d+e\d+$/);

    const typed = await harness.call('browser_type_text', { instance_id: instance, target: inputRef, text: 'from the parent' });
    expect(typed.isError, typed.text).toBe(false);
    expect(await evaluate('el => el.value', inputRef)).toBe('from the parent');
  });

  it('leaves the page walled off, as the platform guarantees', async () => {
    // Any page can run this check, so succeeding here would be a
    // one-expression positive identification of the browser. It must keep
    // failing exactly as it does in a stock browser.
    const view = await evaluate('window.__pageProbe()') as { contentDocument: unknown; contentWindowDocument: string };
    expect(view.contentDocument).toBe(false);
    expect(view.contentWindowDocument).toBe('threw');
  });
});
