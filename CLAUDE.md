# agent-browser

## What this repo is

An MCP server that drives the patched Chromium from
`/Users/jinyangli/src/fingerprint-chromium` (a patch store; **read its CLAUDE.md before
touching anything about detection**). 32 tools, all always on, no capability system, zero
required arguments.

Two goals, never conflated, same as the patch layer:

1. **Not detectable as automation.** Everything here must keep that true.
2. **Reaching all of the page**, cross-origin iframes included.

## Layering

| Layer | Where |
|---|---|
| Patched Chromium 148.0.7778.215 | `fingerprint-chromium` patches, built at `/Users/jinyangli/src/chromium-build/build/src/out/Default/Chromium.app` |
| Playwright, pinned exact `1.62.1` | `playwright-core` dependency **and** the vendored tool layer, same tag |
| Our tool + MCP layer | `src/` |

`playwright-core`, never `playwright`: the latter's postinstall downloads ~500 MB of
browsers we never use. Pinned **exact**, because `src/vendor/` is copied from the matching
tag and the public API must not drift out from under it.

## Vendoring from Playwright

Copied from `packages/playwright-core/src/tools/backend/` at tag `v1.62.1`
(`26a9e470a7b3c7822084b09fb7f13902c5f37b51`). `src/vendor/` holds six helper files
**byte-identical** to upstream — `rtti.ts` already imports `./stringUtils` relatively, so
no import rewriting was needed at all. That is why `tsconfig.json` uses
`moduleResolution: "bundler"`: extensionless relative imports have to resolve. Keep it
that way so a re-sync stays a straight copy.

`src/vendor/` is in the eslint ignore list. Do not reformat it.

**Deliberately not vendored:** `locatorGenerators.ts` (779 lines) and `locatorParser.ts`
(252). They exist only to parse *Playwright locator expressions* like
`getByRole('button')`. We resolve targets ourselves in `src/browser/target.ts`, so 1,031
lines of internals never enter the tree. Dropping `browser_generate_locator` is what
makes that possible; do not add it back without accepting those files.

Also not vendored: `verify.ts` `video.ts` `tracing.ts` `devtools.ts` `runCode.ts`
`config.ts` `sessionLog.ts` `logFile.ts`. `runCode.ts` in particular is server-process
RCE; `browser_run_javascript` runs in the page and is sufficient.

Upstream's `screenshot.ts` image-rescaling path was dropped, which is what keeps
`jpeg-js`, `pngjs`, `sharp` and `@utils/webp` out of the dependency tree.

## The findings that cost the most to learn

### `fNeN` does not mean "inside an iframe"

The main frame gets a frame ordinal too, once its document has been swapped across
origins. Measured on this build:

| Navigations | Main-frame refs |
|---|---|
| `data:` URL three times in a row | `e1`, `e1`, `e1` |
| `about:blank` then an http URL | **`f1e1`** |

So a test asserting `/\[ref=e\d+\]/` fails intermittently depending on what ran before
it, and any code branching on the `f` prefix to mean "this element is in an iframe" is
wrong. `refPattern` in `src/browser/snapshot.ts` accepts both, `resolveTarget` treats
them identically, and `tests/browser.test.ts` has a test pinning this behaviour.

### An element handle cannot cross a process boundary

`page.evaluate(fn, handle)` fails with *"Unable to adopt element handle from a different
document"* when the handle came from a cross-origin iframe. `browser_run_javascript`
therefore resolves the handle's **owning frame** via `ElementHandle.ownerFrame()` and
evaluates there. `Frame.evaluate` takes the same single-argument shape as
`Page.evaluate`, so one page-side function still serves both cases — which matters,
because the function is serialized into the page and cannot reference anything outside
itself.

### Two ports are not two sites

`http://127.0.0.1:3000` and `http://127.0.0.1:3001` are cross-origin but **same-site**,
so they share a renderer process and are not out-of-process iframes. The cross-frame test
would silently pass without testing anything.

`localhost` vs `127.0.0.1` *are* different sites, and desktop Chromium's default full
site isolation makes that iframe out-of-process with **no launch flags** — no
`--site-per-process`, no `--host-resolver-rules`. Confirmed with CDP
`Target.getTargets`, which reports a separate `type: 'iframe'` target; same-process
iframes never get one. That is what `tests/helpers/server.ts` `crossSiteUrl()` sets up,
and it is why this repo needs no escape hatch for extra Chromium arguments.

### turndown parses with its own DOM

turndown 7 uses domino internally, so a custom rule receives nodes with **no
`querySelectorAll` / `closest`**. The table rule in `src/web/markdown.ts` walks
`childNodes` for exactly this reason. A rule written with query methods throws at
conversion time, not at load time, so only a test catches it.

### linkedom has no `baseURI`

Readability leaves relative hrefs alone, so `../foo` links come out unresolved — which is
the bug stealth-browser-mcp's hand-rolled converter ships. `parseDocument` absolutizes
`href`/`src`/`poster`/`action`/`srcset` against the page URL before anything else runs.

### `new Function` cannot take `"use strict"` with a rest parameter

`new Function('element', '...args', '"use strict"; ...')` is a SyntaxError. The
statement-body fallback in `browser_run_javascript` wraps the code in an async arrow
instead.

### A SIGKILLed server does not leak a browser

Playwright drives Chromium over `--remote-debugging-pipe`, so when the server process dies
the pipe closes and Chromium exits on its own — measured, not assumed
(`tests/lifecycle.test.ts` pins it). `Registry.reapOrphans` and `processes.json` are
therefore insurance for the cases where a browser *does* outlive its parent (a hung
renderer, a lost machine), not the common path. Do not "fix" a bug report about leaked
browsers by first assuming the reaper is broken.

The reaper only ever kills a PID it recorded *and* which still owns the recorded
user-data directory, checked through Chromium's `SingletonLock` symlink. That guard is
what stops it killing an unrelated process that inherited a reused PID, and it is tested
in both directions.

### The MCP stdio transport filters the environment

`StdioClientTransport` passes only a safe default set of environment variables to the
child, so `AGENT_BROWSER_BINARY` does not reach a server spawned that way unless `env` is
passed explicitly. `scripts/detection-check.mjs` does this; it bit once already.

### `--enable-automation` is not a Playwright default any more

On 1.62.1 the string appears only in two internal `ignoreDefaultArgs` lists, never in
`chromiumSwitches()`. The `ignoreDefaultArgs: ['--enable-automation']` in
`src/browser/instance.ts` is therefore a no-op today, kept as insurance against
reintroduction. Playwright's defaults *do* already include `--use-mock-keychain` (without
which a locally built Chromium deadlocks on the macOS Keychain prompt) and, when
headless, the `primaryPointerType`/`primaryHoverType` blink settings.

### Only a temp dir or a slot may be deleted

`Registry.reapOrphans` deletes the user-data directory of an ephemeral record.
`Instance.profileIsEphemeral` derives that from `ProfileChoice.kind`, **not** from
`profileName`: an explicit `user_data_dir` also has no profile name, so the obvious
version of this deletes a directory `browser_open` documents as never deleted. Pinned by
a test.

### The web tier's SSRF policy has to cover the browser path too

`httpFetch` checks every redirect hop, but `page.goto` follows redirects itself, so
`Renderer` re-checks each navigation request that has a `redirectedFrom()`. Anything that
navigates a page for the web_* tools must go through `Renderer._withPage`; the PDF path
originally called `page.goto` directly and accepted `file://`.

The initial URL may be loopback or private (fetching your own dev server is legitimate); a
*redirect target* may not, since the caller did not choose it.

### `withRenderer` memoises the promise, not the renderer

Concurrent crawl workers would otherwise each find it unset, each launch a browser, and
all but the last would leak. Each render also gets its own page, because a shared tab
means concurrent navigations cancelling each other.

## Design rules

- **Never fall back to a stock Chromium.** Every guarantee comes from the patches; a
  silent downgrade loses them invisibly. Missing binary or unsupported platform is a hard
  error naming the platform and the override.
- **Never set `channel`** on launch: Playwright would look the browser up in its own
  registry and fail.
- **No viewport emulation.** Launch with `viewport: null` and resize the real window via
  CDP `Browser.setWindowBounds`. `setViewportSize` issues
  `Emulation.setDeviceMetricsOverride`, which pins the viewport, leaves the real window
  alone in headed mode, and creates a whole class of `outerWidth`/`innerWidth`/`screen.*`
  mismatches. Corollary: no mobile emulation, no `device_scale_factor`.
- **Always pass an explicit window size.** Patch `120`'s headless-screen fix only
  *matters* once one is set; at the default window size the 800x600 contradiction is
  invisible. Default is 1280x720.
- **Only two switches from the patch layer are real**: `--fingerprint=<uint64>` and
  `--timezone=<IANA>`. `--fingerprint-platform`, `--fingerprint-noise` and
  `--fingerprint-storage-quota` were deleted upstream and are silently ignored;
  stealth-browser-mcp still passes all three.
- **A profile's fingerprint seed must be stable for its lifetime.** It is persisted in
  the profile directory on first use. stealth-browser-mcp passes a *random* seed on every
  launch, which defeats the trust accumulation its profile pool exists to build.
- **Never merge profile state.** stealth-browser-mcp's pool copies Cookies/History/Login
  Data back into a master profile, so with several slots open whichever releases last
  silently overwrites the others. The canonical directory is used *directly* when free,
  and clones are ephemeral, so no merge is ever needed.

## Licensing

Apache-2.0. Playwright is Apache-2.0 and stealth-browser-mcp is MIT, so both can be
copied with attribution — see `NOTICE`, which records the exact tag and commit so a
re-sync is mechanical.

**wigolo is AGPL-3.0-only. Do not copy any of its code.** Doing so would force this
project to be AGPL *and* to offer source to users of any network service built on it. Its
ideas (HTTP-first with browser escalation) are reimplemented from scratch.

## Verification

```bash
npm run typecheck && npm run lint && npm test
node scripts/detection-check.mjs      # needs the internet
```

The tests need the patched Chromium; set `AGENT_BROWSER_BINARY` if it is not at the
default path in `tests/helpers/client.ts`.

`vitest.config.ts` sets `fileParallelism: false`. Test files each launch browsers, and
the profile lock serialises them anyway.

### Two bugs the test suite exists to catch

- **Snapshot refs disappearing.** `ariaSnapshot` silently returns a snapshot *without*
  refs if `mode: 'ai'` ever stops taking effect, and every action tool would then fail
  with "not in the current page snapshot". `src/browser/snapshot.ts` is the single call
  site so there is one place to fix.
- **The cross-frame path regressing.** `tests/crossframe.test.ts` asserts the child's ref
  is frame-prefixed, that the click records `isTrusted: true` *and* non-zero coordinates
  inside the child, and that `contentDocument` is still unreachable. A click at
  untranslated child-local coordinates lands nowhere at all — silently, with no error —
  so the recorded coordinates are the real assertion.

## Releasing the browser binary

`node scripts/package-binary.mjs` tars `Chromium.app` (367 MB → ~154 MB gzipped) and
prints the manifest entry. **The archive is never committed to git** — release assets
only, and `release/` is gitignored.

`sha256: null` in `src/browser/manifest.json` means "no asset published for this platform
yet", and the resolver says exactly that instead of trying to download something it
cannot verify. Fill it in only when the release actually exists, or first use will fail
with a 404 instead of a useful message.

The archive must be `.tar.gz`, not `.zip`: the bundle contains 5 symlinks (including
`Chromium Framework.framework/Versions/Current`) plus executable bits, and a naive zip
extractor breaks it silently. Extraction shells out to `tar`, and macOS additionally
needs `xattr -dr com.apple.quarantine` because the build is `adhoc, linker-signed` with
no Team ID.
