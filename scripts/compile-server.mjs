#!/usr/bin/env bun
/**
 * Compile src/index.ts into a single-file executable via the Bun.build API.
 * Invoked by scripts/package-server-binary.mjs (`bun scripts/compile-server.mjs
 * --target <bun-target> --outfile <path>`); runs under bun, not node.
 *
 * Why this exists rather than `bun build --compile` directly: playwright-core
 * (lib/coreBundle.js) derives `packageRoot` from `__dirname` and dynamically
 * `require`s its own package.json and browsers.json against it. Bun cannot
 * constant-fold a dynamic require, so at runtime those reads resolve against
 * the *build host's* node_modules path — the "single-file" binary appeared to
 * work only while the build machine still had node_modules/playwright-core
 * sitting where it was compiled. Relocated to a machine without that tree, it
 * breaks.
 *
 * The onLoad plugin below neutralizes packageRoot to a placeholder path that
 * cannot exist, and replaces the two dynamic requires with the JSON literals
 * inlined from the pinned node_modules copy, so nothing is resolved at
 * runtime. Each rewrite asserts its exact expected occurrence count: when a
 * playwright-core update moves those sites, this build fails loudly instead
 * of quietly regressing to a host-path dependency.
 *
 * `chromium-bidi` stays external: playwright-core requires it lazily, but
 * only on the BiDi connection path. This server always speaks CDP to a
 * specific executable, so the module never loads and there is nothing to
 * bundle — left non-external, the compile fails to resolve it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightRoot = path.join(repoRoot, 'node_modules', 'playwright-core');

// Any path is fine as long as it cannot resolve on a target machine: every
// consumer of packageRoot (binPath, libPath, the browser registry, cli.js
// forking) sits on code paths this server never takes, because it launches an
// explicit executablePath over CDP.
const PLACEHOLDER_ROOT = '/agent-browser-bundled/playwright-core';

/**
 * `__dirname`-derived packageRoot and the two JSON reads against it. The
 * `import_path<N>` aliases are the per-module path requires in the 1.62.x
 * coreBundle; the exact per-file counts are asserted in patchPlaywrightSource.
 */
const REPLACEMENTS = [
  {
    name: 'packageRoot',
    pattern: /packageRoot = import_path\d+\.default\.join\(__dirname, "\.\."\)/g,
    substitute: () => `packageRoot = ${JSON.stringify(PLACEHOLDER_ROOT)}`,
  },
  {
    name: 'package.json require',
    pattern: /require\(import_path\d+\.default\.join\(packageRoot, "package\.json"\)\)/g,
    substitute: () => jsonLiteral('package.json'),
  },
  {
    name: 'browsers.json require',
    pattern: /require\(import_path\d+\.default\.join\(packageRoot, "browsers\.json"\)\)/g,
    substitute: () => jsonLiteral('browsers.json'),
  },
];

/** coreBundle.js is the module every entry of playwright-core funnels into. */
const EXPECTED_COUNTS = {
  'coreBundle.js': { packageRoot: 1, 'package.json require': 1, 'browsers.json require': 1 },
};

function jsonLiteral(name) {
  const file = path.join(playwrightRoot, name);
  const text = fs.readFileSync(file, 'utf-8');
  JSON.parse(text); // fail the build on anything that is not valid JSON
  return text.trim();
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

/**
 * Rewrite one playwright-core source text. Returns the patched text and the
 * per-rule replacement counts, or null when the file holds no target site.
 * Any target site that survives replacement is a hard error.
 */
function patchPlaywrightSource(text) {
  const counts = {};
  for (const rule of REPLACEMENTS) {
    counts[rule.name] = countMatches(text, rule.pattern);
    if (counts[rule.name] > 0)
      text = text.replaceAll(rule.pattern, () => rule.substitute()); // function form: JSON may contain `$`
  }
  if (!Object.values(counts).some(count => count > 0))
    return null;
  for (const rule of REPLACEMENTS) {
    const left = countMatches(text, rule.pattern);
    if (left > 0)
      throw new Error(`playwright-core patch: ${left} "${rule.name}" site(s) survived replacement (${rule.pattern})`);
  }
  return { text, counts };
}

const onLoadCounts = new Map();

const playwrightPortabilityPlugin = {
  name: 'playwright-core-portable',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]playwright-core[\\/].*\.js$/ }, async args => {
      const original = await fs.promises.readFile(args.path, 'utf-8');
      const patched = patchPlaywrightSource(original);
      const basename = path.basename(args.path);
      if (patched || basename in EXPECTED_COUNTS)
        onLoadCounts.set(basename, patched?.counts ?? {});
      if (!patched)
        return undefined;
      return { contents: patched.text, loader: 'js' };
    });
  },
};

function assertCounts() {
  for (const [file, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = onLoadCounts.get(file);
    if (!actual) {
      throw new Error(
        `playwright-core patch: ${file} was never loaded by the build — either it left the`
        + ' import graph or its path moved; refusing to ship an unpatched bundle');
    }
    for (const [name, count] of Object.entries(expected)) {
      if (actual[name] !== count) {
        throw new Error(
          `playwright-core patch: expected exactly ${count} "${name}" replacement(s) in ${file},`
          + ` got ${actual[name] ?? 0} — a playwright-core update moved the site; re-check the plugin`);
      }
    }
  }
  // Other loaded playwright files (e.g. serverRegistry.js re-inlining
  // package.js) may carry the same sites; those were replaced too — the
  // survival check inside patchPlaywrightSource makes "replaced too" total.
  for (const [file, counts] of onLoadCounts) {
    if (file in EXPECTED_COUNTS)
      continue;
    process.stdout.write(`portable:   also patched ${file} (${Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(', ')})\n`);
  }
}

async function compileServer({ target, outfile }) {
  // globalThis.Bun rather than the bare `Bun` global: this file is linted under
  // the repo's node-flavoured eslint config, and it only ever runs under bun.
  const result = await globalThis.Bun.build({
    entrypoints: [path.join(repoRoot, 'src', 'index.ts')],
    compile: { target, outfile },
    external: ['chromium-bidi'],
    plugins: [playwrightPortabilityPlugin],
  });
  if (!result.success) {
    const detail = result.logs.map(log => log.message ?? String(log)).join('\n');
    throw new Error(`Bun.build failed for target ${target}:\n${detail}`);
  }
  assertCounts();
  const summary = Object.entries(EXPECTED_COUNTS['coreBundle.js'])
    .map(([name]) => `${name} x1`)
    .join(', ');
  process.stdout.write(`portable:   playwright-core neutralized (${summary})\n`);
}

function parseArgv(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq !== -1;
    const inlineValue = inline ? argv[i].slice(eq + 1) : undefined;
    if (flag === '--target')
      args.target = inline ? inlineValue : argv[++i];
    else if (flag === '--outfile')
      args.outfile = path.resolve(inline ? inlineValue : argv[++i]);
    else
      throw new Error(`Unknown option "${argv[i]}"`);
  }
  if (!args.target || !args.outfile)
    throw new Error('usage: bun scripts/compile-server.mjs --target <bun-target> --outfile <path>');
  return args;
}

if (import.meta.main) {
  const args = parseArgv(process.argv.slice(2));
  process.stdout.write(`compiling:  Bun.build --compile --target ${args.target}\n`);
  compileServer(args).catch(error => {
    process.stderr.write(`compile-server: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
