import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refFor, startHarness } from './helpers/client';
import { startFixtures } from './helpers/server';

import type { Harness } from './helpers/client';
import type { Fixtures } from './helpers/server';

let harness: Harness;
let fixtures: Fixtures;
let instance: string;

beforeAll(async () => {
  fixtures = await startFixtures();
  harness = await startHarness();
  instance = await harness.open();
  const nav = await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
  expect(nav.isError).toBe(false);
});

afterAll(async () => {
  await harness?.close();
  await fixtures?.close();
});

/** Read the outline and return it, failing loudly if refs went missing. */
async function outline(): Promise<string> {
  const read = await harness.call('browser_read_page', { instance_id: instance });
  expect(read.isError).toBe(false);
  const snapshot = read.section('Snapshot')!;
  // The one assertion that catches Playwright API drift: ariaSnapshot silently
  // returns a snapshot *without* refs if mode: 'ai' stops taking effect. The
  // frame prefix is optional -- see the "frame prefix" test below.
  expect(snapshot).toMatch(/\[ref=(f\d+)?e\d+\]/);
  return snapshot;
}

async function evaluate(code: string): Promise<unknown> {
  const result = await harness.call('browser_run_javascript', { instance_id: instance, code });
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.section('Result')!);
}

describe('the MCP surface', () => {
  it('advertises 32 tools with JSON schemas', async () => {
    const tools = await harness.listTools();
    expect(tools).toHaveLength(32);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.description).toBeTruthy();
    }
  });

  it('rejects an unknown instance_id with a message that says what to do', async () => {
    const result = await harness.call('browser_read_page', { instance_id: 'inst_deadbeef' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No browser instance/);
    expect(result.text).toMatch(/browser_open/);
  });

  it('rejects invalid arguments without touching the browser', async () => {
    const result = await harness.call('browser_click', { instance_id: instance });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Invalid arguments/);
  });
});

describe('perception', () => {
  it('returns an outline with refs, far smaller than the HTML', async () => {
    const snapshot = await outline();
    expect(snapshot).toContain('button "Click me"');
    const html = (await evaluate('document.documentElement.outerHTML')) as string;
    expect(snapshot.length).toBeLessThan(html.length);
  });

  it('reads only a subtree when given a target', async () => {
    const read = await harness.call('browser_read_page', { instance_id: instance, target: '#s' });
    expect(read.isError).toBe(false);
    const snapshot = read.section('Snapshot')!;
    expect(snapshot).toContain('One');
    expect(snapshot).not.toContain('Click me');
  });

  it('finds a node by role and by text', async () => {
    const byRole = await harness.call('browser_find', { instance_id: instance, role: 'button' });
    expect(byRole.section('Result')).toMatch(/button "Click me" \[ref=e\d+\]/);
    const byText = await harness.call('browser_find', { instance_id: instance, text: 'Click me' });
    expect(byText.section('Result')).toMatch(/Found 1 match/);
    const missing = await harness.call('browser_find', { instance_id: instance, text: 'no such text at all' });
    expect(missing.section('Result')).toMatch(/No matches/);
  });

  it('prefixes refs with a frame ordinal after a cross-origin document swap, main frame included', async () => {
    // fN does NOT mean "inside an iframe". Once the main frame's document is
    // replaced across origins, the main frame itself gets an ordinal, so any
    // code that reads the prefix as "this element is in an iframe" is wrong.
    await harness.call('browser_navigate', { instance_id: instance, url: 'about:blank' });
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const snapshot = (await harness.call('browser_read_page', { instance_id: instance })).section('Snapshot')!;
    expect(snapshot).toMatch(/\[ref=f\d+e\d+\]/);
    // And the ref still resolves for an action, which is all that matters.
    const ref = refFor(snapshot, 'button "Click me"')!;
    expect(ref).toMatch(/^f\d+e\d+$/);
    expect((await harness.call('browser_click', { instance_id: instance, target: ref })).isError).toBe(false);
    expect(await evaluate('window.__clicks.length')).toBe(1);
  });

  it('screenshots the viewport and attaches the image', async () => {
    const shot = await harness.call('browser_screenshot', { instance_id: instance });
    expect(shot.isError).toBe(false);
    expect(shot.images).toBe(1);
    expect(shot.text).toMatch(/Screenshot of viewport/);
  });
});

describe('interaction', () => {
  it('clicks by ref and the page sees a trusted event', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const ref = refFor(await outline(), 'button "Click me"')!;
    const click = await harness.call('browser_click', { instance_id: instance, target: ref, element: 'the button' });
    expect(click.isError).toBe(false);
    expect(await evaluate('window.__clicks')).toEqual([{ isTrusted: true }]);
    expect(await evaluate('document.getElementById("log").textContent')).toBe('clicked 1');
  });

  it('clicks by CSS selector too', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const click = await harness.call('browser_click', { instance_id: instance, target: '#b' });
    expect(click.isError).toBe(false);
    expect(await evaluate('window.__clicks.length')).toBe(1);
  });

  it('clicks by XPath too', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const click = await harness.call('browser_click', { instance_id: instance, target: '//button[@id="b"]' });
    expect(click.isError).toBe(false);
    expect(await evaluate('window.__clicks.length')).toBe(1);
  });

  it('explains a stale ref rather than clicking the wrong thing', async () => {
    const result = await harness.call('browser_click', { instance_id: instance, target: 'e999' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/browser_read_page/);
  });

  it('reports a selector that matches nothing', async () => {
    const result = await harness.call('browser_click', { instance_id: instance, target: '#definitely-not-here' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not match any element/);
  });

  it('types text, and types it key by key when asked', async () => {
    await harness.call('browser_type_text', { instance_id: instance, target: '#t', text: 'hello' });
    expect(await evaluate('document.getElementById("t").value')).toBe('hello');
    await harness.call('browser_type_text', { instance_id: instance, target: '#t', text: 'slow', slowly: true });
    expect(await evaluate('document.getElementById("t").value')).toBe('slow');
  });

  it('sets a checkbox idempotently through browser_click', async () => {
    await harness.call('browser_click', { instance_id: instance, target: '#c', checked: true });
    expect(await evaluate('document.getElementById("c").checked')).toBe(true);
    await harness.call('browser_click', { instance_id: instance, target: '#c', checked: true });
    expect(await evaluate('document.getElementById("c").checked')).toBe(true);
    await harness.call('browser_click', { instance_id: instance, target: '#c', checked: false });
    expect(await evaluate('document.getElementById("c").checked')).toBe(false);
  });

  it('fills a whole form in one call', async () => {
    const result = await harness.call('browser_fill_form', {
      instance_id: instance,
      fields: [
        { target: '#t', type: 'textbox', value: 'filled' },
        { target: '#c', type: 'checkbox', value: 'true' },
        { target: '#s', type: 'combobox', value: 'Two' },
      ],
    });
    expect(result.isError, result.text).toBe(false);
    expect(await evaluate('document.getElementById("t").value')).toBe('filled');
    expect(await evaluate('document.getElementById("c").checked')).toBe(true);
    expect(await evaluate('document.getElementById("s").value')).toBe('2');
  });

  it('scrolls, and scrolls all the way back to the top', async () => {
    await harness.call('browser_scroll', { instance_id: instance, direction: 'down', amount: 400 });
    expect(await evaluate('window.scrollY > 0')).toBe(true);
    await harness.call('browser_scroll', { instance_id: instance, direction: 'top' });
    expect(await evaluate('window.scrollY')).toBe(0);
  });

  it('clicks at coordinates', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const box = await evaluate('(() => { const r = document.getElementById("b").getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()') as { x: number; y: number };
    const click = await harness.call('browser_mouse', { instance_id: instance, action: 'click', x: box.x, y: box.y });
    expect(click.isError).toBe(false);
    expect(await evaluate('window.__clicks.length')).toBe(1);
  });
});

describe('scripting', () => {
  it('awaits a returned promise and an async IIFE', async () => {
    expect(await evaluate('(async () => { await new Promise(r => setTimeout(r, 10)); return 41 + 1; })()')).toBe(42);
    expect(await evaluate('new Promise(r => setTimeout(() => r("later"), 10))')).toBe('later');
  });

  it('accepts statements with a return, including top-level await', async () => {
    expect(await evaluate('const a = 2; const b = await Promise.resolve(3); return a * b;')).toBe(6);
  });

  it('passes the target element as the first argument', async () => {
    const result = await harness.call('browser_run_javascript', {
      instance_id: instance,
      target: '#b',
      code: 'el => el.id + ":" + el.textContent',
    });
    expect(JSON.parse(result.section('Result')!)).toBe('b:Click me');
  });

  it('passes extra args after the element', async () => {
    const result = await harness.call('browser_run_javascript', {
      instance_id: instance,
      code: '(...a) => a.join("-")',
      args: ['x', 'y'],
    });
    expect(JSON.parse(result.section('Result')!)).toBe('x-y');
  });

  it('serializes DOM nodes and functions instead of failing the call', async () => {
    const result = await evaluate('({ node: document.getElementById("b"), fn: function named() {}, when: new Date(0), re: /x/g })') as any;
    expect(result.node).toMatchObject({ __type: 'Node', nodeName: 'BUTTON', id: 'b' });
    expect(result.fn).toMatchObject({ __type: 'function', name: 'named' });
    expect(result.when).toMatchObject({ __type: 'Date', value: '1970-01-01T00:00:00.000Z' });
    expect(result.re).toMatchObject({ __type: 'RegExp', value: '/x/g' });
  });

  it('survives a circular structure', async () => {
    const result = await evaluate('(() => { const a = { name: "a" }; a.self = a; return a; })()') as any;
    expect(result.name).toBe('a');
    expect(result.self).toMatchObject({ __type: 'circular' });
  });

  it('reports a thrown error with its stack', async () => {
    const result = await harness.call('browser_run_javascript', { instance_id: instance, code: '() => { throw new Error("boom"); }' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/The script threw: boom/);
    expect(result.text).toMatch(/at /);
  });

  it('names the unsettled-promise hazard when a script never finishes', async () => {
    const result = await harness.call('browser_run_javascript', {
      instance_id: instance,
      code: 'new Promise(() => {})',
      timeout: 1000,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not finish within 1000ms/);
    expect(result.text).toMatch(/may never settle/);
  });
});

describe('navigation, tabs and window', () => {
  it('goes back, forward and reloads', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('child.html') });
    const back = await harness.call('browser_navigate', { instance_id: instance, action: 'back' });
    expect(back.section('Page')).toContain('page.html');
    const forward = await harness.call('browser_navigate', { instance_id: instance, action: 'forward' });
    expect(forward.section('Page')).toContain('child.html');
    expect((await harness.call('browser_navigate', { instance_id: instance, action: 'reload' })).isError).toBe(false);
  });

  it('insists on exactly one of url and action', async () => {
    const neither = await harness.call('browser_navigate', { instance_id: instance });
    expect(neither.isError).toBe(true);
    const both = await harness.call('browser_navigate', { instance_id: instance, url: fixtures.origin, action: 'reload' });
    expect(both.isError).toBe(true);
  });

  it('opens, lists, selects and closes tabs', async () => {
    const created = await harness.call('browser_tabs', { instance_id: instance, action: 'new', url: fixtures.url('child.html') });
    expect(created.isError).toBe(false);
    const listed = await harness.call('browser_tabs', { instance_id: instance, action: 'list' });
    expect(listed.section('Result')!.split('\n').length).toBeGreaterThanOrEqual(2);
    expect((await harness.call('browser_tabs', { instance_id: instance, action: 'select', index: 0 })).isError).toBe(false);
    expect((await harness.call('browser_tabs', { instance_id: instance, action: 'close', index: 1 })).isError).toBe(false);
  });

  it('resizes the real window, and the viewport follows it', async () => {
    const result = await harness.call('browser_set_window_size', { instance_id: instance, width: 900, height: 640 });
    expect(result.isError).toBe(false);
    const size = await evaluate('({ outer: window.outerWidth, inner: window.innerWidth })') as any;
    expect(size.outer).toBe(900);
    // No device-metrics override exists, so the viewport tracks the window
    // rather than being pinned to an emulated size.
    expect(size.inner).toBe(900);
  });
});

describe('state', () => {
  it('round-trips cookies', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    expect((await harness.call('browser_cookies', { instance_id: instance, action: 'set', name: 'k', value: 'v' })).isError).toBe(false);
    expect((await harness.call('browser_cookies', { instance_id: instance, action: 'get', name: 'k' })).section('Result')).toContain('k=v');
    await harness.call('browser_cookies', { instance_id: instance, action: 'delete', name: 'k' });
    expect((await harness.call('browser_cookies', { instance_id: instance, action: 'list' })).section('Result')).toMatch(/No cookies/);
  });

  it('round-trips local and session storage', async () => {
    for (const area of ['local', 'session'] as const) {
      await harness.call('browser_storage', { instance_id: instance, area, action: 'set', key: 'k', value: 'v' });
      expect((await harness.call('browser_storage', { instance_id: instance, area, action: 'get', key: 'k' })).section('Result')).toBe('k=v');
      const code = (await harness.call('browser_storage', { instance_id: instance, area, action: 'clear' })).section('Ran Playwright code')!;
      // The generated code must be runnable, not a mangled method name.
      expect(code).toContain('.clear();');
      expect((await harness.call('browser_storage', { instance_id: instance, area, action: 'list' })).section('Result')).toMatch(/No .*Storage items/);
    }
  });

  it('saves and restores a session file', async () => {
    const file = `${process.env.TMPDIR ?? '/tmp'}/agent-browser-session-${Date.now()}.json`;
    await harness.call('browser_cookies', { instance_id: instance, action: 'set', name: 'persisted', value: '1' });
    expect((await harness.call('browser_session', { instance_id: instance, action: 'save', path: file })).isError).toBe(false);
    await harness.call('browser_cookies', { instance_id: instance, action: 'clear' });
    expect((await harness.call('browser_session', { instance_id: instance, action: 'load', path: file })).isError).toBe(false);
    expect((await harness.call('browser_cookies', { instance_id: instance, action: 'list' })).section('Result')).toContain('persisted=1');
  });

  it('blocks requests and lists the rule', async () => {
    const added = await harness.call('browser_intercept_requests', { instance_id: instance, action: 'add', pattern: '**/child.html', block: true });
    expect(added.isError).toBe(false);
    expect((await harness.call('browser_intercept_requests', { instance_id: instance, action: 'list' })).section('Result')).toContain('child.html');
    const blocked = await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('child.html') });
    expect(blocked.isError).toBe(true);
    const removed = await harness.call('browser_intercept_requests', { instance_id: instance, action: 'remove' });
    expect(removed.section('Result')).toMatch(/Removed all 1/);
  });

  it('serves a canned response', async () => {
    await harness.call('browser_intercept_requests', {
      instance_id: instance,
      action: 'add',
      pattern: '**/mocked.html',
      status: 200,
      body: '<h1>Mocked body</h1>',
      content_type: 'text/html',
    });
    const nav = await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('mocked.html') });
    expect(nav.section('Snapshot')).toContain('Mocked body');
    await harness.call('browser_intercept_requests', { instance_id: instance, action: 'remove' });
  });
});

describe('observation', () => {
  it('lists requests and reads one in full', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    const list = await harness.call('browser_list_requests', { instance_id: instance, resource_type: 'document' });
    const result = list.section('Result')!;
    expect(result).toMatch(/#\d+\. \[GET\] .*page\.html => \[200\] OK/);
    const id = /#(\d+)\./.exec(result)![1];
    const detail = await harness.call('browser_get_request', { instance_id: instance, request_id: `#${id}` });
    const body = detail.section('Result')!;
    expect(body).toContain('Request headers');
    expect(body).toContain('Response headers');
    expect(body).toContain('Response body');
  });

  it('says so when a request id does not exist', async () => {
    const result = await harness.call('browser_get_request', { instance_id: instance, request_id: '#9999' });
    expect(result.text).toMatch(/not found/);
  });

  it('reads and clears console messages', async () => {
    await evaluate('(() => { console.warn("a warning"); console.error("an error"); return 1; })()');
    const read = await harness.call('browser_read_console', { instance_id: instance, level: 'warning' });
    const result = read.section('Result')!;
    expect(result).toContain('a warning');
    expect(result).toContain('an error');
    await harness.call('browser_read_console', { instance_id: instance, clear: true });
    expect((await harness.call('browser_read_console', { instance_id: instance })).section('Result')).toMatch(/Total messages: 0/);
  });
});

describe('modal state', () => {
  it('blocks other tools until a dialog is handled, then handles it', async () => {
    await harness.call('browser_navigate', { instance_id: instance, url: fixtures.url('page.html') });
    // Do not await: alert() blocks the renderer until the dialog is answered.
    void harness.call('browser_run_javascript', { instance_id: instance, code: 'alert("hi")', timeout: 2000 });
    await new Promise(f => setTimeout(f, 1000));

    const refused = await harness.call('browser_click', { instance_id: instance, target: '#b' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/does not handle the modal state/);

    const handled = await harness.call('browser_handle_dialog', { instance_id: instance, accept: true });
    expect(handled.isError, handled.text).toBe(false);
    expect((await harness.call('browser_click', { instance_id: instance, target: '#b' })).isError).toBe(false);
  });

  it('refuses to handle a dialog that is not there', async () => {
    const result = await harness.call('browser_handle_dialog', { instance_id: instance, accept: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/related modal state/);
  });

  it('uploads to a hidden input behind a wrapper', async () => {
    await harness.call('browser_navigate', {
      instance_id: instance,
      url: 'data:text/html,' + encodeURIComponent('<div id=w style="display:inline-block"><input id=f type=file style="display:none"></div>'),
    });
    const file = new URL('./fixtures/page.html', import.meta.url).pathname;
    const upload = await harness.call('browser_upload_file', { instance_id: instance, target: '#w', paths: [file] });
    expect(upload.isError, upload.text).toBe(false);
    expect(await evaluate('document.getElementById("f").files[0].name')).toBe('page.html');
  });
});

describe('waiting', () => {
  it('waits for text to appear and for an element', async () => {
    await harness.call('browser_navigate', {
      instance_id: instance,
      url: 'data:text/html,' + encodeURIComponent('<div id=x>waiting</div><script>setTimeout(()=>{const d=document.createElement("p");d.id="late";d.textContent="appeared";document.body.append(d);},700)</script>'),
    });
    expect((await harness.call('browser_wait_for', { instance_id: instance, text: 'appeared' })).isError).toBe(false);
    expect((await harness.call('browser_wait_for', { instance_id: instance, target: '#late' })).isError).toBe(false);
  });

  it('requires at least one condition', async () => {
    const result = await harness.call('browser_wait_for', { instance_id: instance });
    expect(result.isError).toBe(true);
  });
});

describe('instances', () => {
  it('lists what is open and closes on request', async () => {
    const second = await harness.open();
    const listed = JSON.parse((await harness.call('browser_list', {})).section('Result')!);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.map((i: any) => i.instance_id)).toContain(second);
    expect((await harness.call('browser_close', { instance_id: second })).section('Result')).toContain(second);
    const after = await harness.call('browser_read_page', { instance_id: second });
    expect(after.isError).toBe(true);
  });

  it('gives concurrent instances of one named profile separate directories', async () => {
    const first = await harness.open({ profile: 'concurrency-test' });
    const second = await harness.open({ profile: 'concurrency-test' });
    const listed = JSON.parse((await harness.call('browser_list', {})).section('Result')!);
    const dirs = listed.filter((i: any) => [first, second].includes(i.instance_id)).map((i: any) => i.user_data_dir);
    expect(new Set(dirs).size).toBe(2);
    // The canonical directory is used directly; only the second needs a clone.
    expect(dirs.some((d: string) => d.endsWith('/profiles/concurrency-test'))).toBe(true);
    expect(dirs.some((d: string) => d.includes('/.slots/concurrency-test-'))).toBe(true);
    await harness.call('browser_close', { instance_id: first });
    await harness.call('browser_close', { instance_id: second });
  });

  it('persists a fingerprint seed so a profile keeps reporting one machine', async () => {
    const first = await harness.open({ profile: 'seeded-test', fingerprint: 4242 });
    expect(JSON.parse((await harness.call('browser_list', {})).section('Result')!)
      .find((i: any) => i.instance_id === first).fingerprint).toBe('4242');
    await harness.call('browser_close', { instance_id: first });

    // Reopened with no seed argument, it must still be the same machine.
    const second = await harness.open({ profile: 'seeded-test' });
    expect(JSON.parse((await harness.call('browser_list', {})).section('Result')!)
      .find((i: any) => i.instance_id === second).fingerprint).toBe('4242');
    await harness.call('browser_close', { instance_id: second });
  });
});
