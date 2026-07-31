#!/usr/bin/env node
/**
 * Drive the detection suites through agent-browser itself, so what is measured
 * is the browser *as this server launches it* — window size, launch flags,
 * persistent context and all. Compare the output against the baseline table in
 * README.md; every number there was produced by this script.
 *
 * Usage
 *   node scripts/detection-check.mjs [--headed] [--binary <path>] [suite ...]
 *
 * Needs the internet. Some suites open a JavaScript dialog, which blocks the
 * renderer until answered, so browser_handle_dialog is called where needed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const extra = [];
const wanted = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--headed')
    extra.push('--headed');
  else if (args[i] === '--binary')
    extra.push('--binary', args[++i]);
  else
    wanted.push(args[i]);
}

const client = new Client({ name: 'detection-check', version: '0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, 'dist', 'index.js'), ...extra],
  // The SDK's stdio transport filters the environment to a safe default set,
  // so AGENT_BROWSER_BINARY has to be handed over explicitly.
  env: { ...process.env },
  stderr: 'inherit',
}));

const text = r => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const sectionOf = (t, name) => {
  const found = t.split(/^### /m).slice(1).find(s => s.startsWith(name + '\n'));
  return found ? found.slice(name.length + 1).trim() : undefined;
};
const call = async (name, argsObj) => {
  const r = await client.callTool({ name, arguments: argsObj });
  return { isError: !!r.isError, text: text(r), section: n => sectionOf(text(r), n) };
};

const open = await call('browser_open', { profile: null });
if (open.isError)
  throw new Error(open.text);
const instance_id = JSON.parse(open.section('Result')).instance_id;

const evaluate = async (code, timeout = 60_000) => {
  const r = await call('browser_run_javascript', { instance_id, code, timeout });
  if (r.isError)
    return { error: r.text.slice(0, 400) };
  return JSON.parse(r.section('Result'));
};

const goto = async url => {
  const r = await call('browser_navigate', { instance_id, url });
  if (r.isError)
    process.stderr.write(`  navigate warning: ${r.text.slice(0, 200)}\n`);
};

const sleep = async seconds => { await call('browser_wait_for', { instance_id, time: seconds }); };

const suites = {
  async webdriver() {
    await goto('about:blank');
    return await evaluate('({ webdriver: navigator.webdriver, ua: navigator.userAgent, headlessInUA: /Headless/.test(navigator.userAgent) })');
  },

  async sannysoft() {
    await goto('https://bot.sannysoft.com/');
    await sleep(6);
    return await evaluate(`(() => {
      const rows = [...document.querySelectorAll('table tr')];
      const failed = [];
      let counted = 0;
      for (const row of rows) {
        const name = row.children[0]?.textContent?.trim();
        const cell = row.children[1];
        if (!name || !cell) continue;
        const cls = cell.className || '';
        if (!/passed|failed|warn/.test(cls)) continue;
        counted++;
        if (/failed/.test(cls)) failed.push(name + ' = ' + cell.textContent.trim().slice(0, 60));
      }
      return { counted, failedCount: failed.length, failed };
    })()`);
  },

  async deviceandbrowserinfo() {
    // /are_you_a_bot prints its verdict as raw JSON, which beats scraping prose.
    await goto('https://deviceandbrowserinfo.com/are_you_a_bot');
    await sleep(8);
    return await evaluate(`(() => {
      const match = document.body.innerText.match(/\\{[\\s\\S]*"isBot"[\\s\\S]*?\\n\\}/);
      if (!match) return { error: 'no verdict JSON on the page' };
      const parsed = JSON.parse(match[0]);
      const details = parsed.details || {};
      return {
        isBot: parsed.isBot,
        signalCount: Object.keys(details).length,
        trueSignals: Object.entries(details).filter(([, v]) => v === true).map(([k]) => k),
      };
    })()`);
  },

  async iphey() {
    await goto('https://iphey.com/');
    await sleep(12);
    return await evaluate(`(() => {
      const body = document.body.innerText;
      // iphey marks each failed check with a "warning"/"error" class.
      const bad = [...document.querySelectorAll('.value.warning, .value.error, .warning, .error')]
        .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean).slice(0, 10);
      return {
        verdict: /(Trustworthy|Not reliable|Unreliable)/i.exec(body)?.[1],
        flaggedChecks: bad,
      };
    })()`);
  },

  async creepjs() {
    await goto('https://abrahamjuliot.github.io/creepjs/');
    await sleep(25);
    return await evaluate(`(() => {
      const body = document.body.innerText;
      // CreepJS writes the percentage *before* the label ("0% headless:"), and
      // "like headless" contains "headless", so match the longer one first.
      const pick = label => {
        const m = new RegExp('(\\\\d+(?:\\\\.\\\\d+)?)%\\\\s*' + label + '\\\\b').exec(body);
        return m ? Number(m[1]) : undefined;
      };
      return {
        likeHeadless: pick('like headless'),
        headless: pick('(?<!like )headless'),
        stealth: pick('stealth'),
        chromium: /chromium:\\s*true/.test(body),
      };
    })()`);
  },

  async nowsecure() {
    // Cloudflare's real challenge. Reaching the site's own banner with no
    // challenge text left on the page is what passing looks like.
    await goto('https://nowsecure.nl/');
    await sleep(12);
    return await evaluate(`(() => {
      const body = document.body.innerText;
      const challenged = /Just a moment|Checking your browser|Verify you are human|Enable JavaScript and cookies/i.test(body);
      return {
        passed: !challenged && /NOWSECURE/i.test(body),
        challenged,
        title: document.title,
        excerpt: body.replace(/\\s+/g, ' ').trim().slice(0, 120),
      };
    })()`);
  },

  async browserscan() {
    await goto('https://www.browserscan.net/bot-detection');
    await sleep(12);
    return await evaluate(`(() => {
      const body = document.body.innerText;
      return {
        verdict: /(Normal|Abnormal)/.exec(body)?.[1],
        abnormalCount: (body.match(/Abnormal/g) || []).length,
        normalCount: (body.match(/Normal/g) || []).length,
      };
    })()`);
  },
};

const names = wanted.length ? wanted : Object.keys(suites);
const results = {};
for (const name of names) {
  if (!suites[name]) {
    process.stderr.write(`unknown suite "${name}"; known: ${Object.keys(suites).join(', ')}\n`);
    continue;
  }
  process.stderr.write(`running ${name} ...\n`);
  try {
    results[name] = await suites[name]();
  } catch (e) {
    results[name] = { error: String(e?.message ?? e).slice(0, 300) };
  }
  // A suite may have left a dialog up, which blocks everything after it.
  await call('browser_handle_dialog', { instance_id, accept: true }).catch(() => {});
}

process.stdout.write(JSON.stringify(results, null, 2) + '\n');
await call('browser_close', { instance_id });
await client.close();
