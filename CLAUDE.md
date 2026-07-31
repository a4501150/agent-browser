# agent-browser

## What this repo is

An MCP server that drives the patched Chromium from
`/Users/jinyangli/src/undetected-chromium` (a patch store; **read its CLAUDE.md before
touching anything about detection**). 32 tools, all always on, no capability system, zero
required arguments.

Two goals, never conflated, same as the patch layer:

1. **Not detectable as automation.** Everything here must keep that true.
2. **Reaching all of the page**, cross-origin iframes included.

## The npm name is taken

`agent-browser` on npm is [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser),
an unrelated "browser automation CLI for AI agents" (0.33.1 at the time of writing). So:

- **This is not publishable under that name**, and `npm i -g agent-browser` installs
  someone else's code. The README said to do exactly that for a while; it now documents
  installing from source.
- **Decision: not published to npm.** `package.json` is `private: true` so an accidental
  `npm publish` cannot happen. Source install only; `bin.agent-browser` matters only for a
  local `npm link`.
- If that is ever revisited, note `agent-browser-mcp` is taken too, and by
  [minhlucvan/agent-browser-mcp](https://github.com/minhlucvan/agent-browser-mcp) —
  "MCP server integrating with Vercel's agent-browser", i.e. the one name that would
  actively assert the association this note exists to deny. A scope
  (`@a4501150/agent-browser`) is the cheap way out.

## Layering

| Layer | Where |
|---|---|
| Patched Chromium 148.0.7778.215 | `undetected-chromium` patches, built at `/Users/jinyangli/src/chromium-build/build/src/out/Default/Chromium.app` |
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

### A strict-schema client cannot omit an optional field

A client that converts these tools into OpenAI's strict function-calling subset has to list
**every** property in `required`, and can only express "unset" as a nullable union
(`"type": ["boolean", "null"]`). So an optional field arrives either as `null` or, if the
bridge marks it required without widening the type, as a value the model had to invent.
Both were reported from the field: `browser_click` doing `setChecked` on a Gmail button
because `checked: false` was forced in, and `browser_navigate` rejecting every call because
`url` and `action` were both filled. Our emitted schema was correct throughout
(`required: ["target", "instance_id"]`), so this is worth recognising rather than
re-diagnosing as a schema bug.

`callTool` therefore drops null-valued keys whose field does not itself accept null
(`withoutNulls` in `src/mcp/dispatch.ts`), which is what makes "optional" mean absent
again. A field that *is* nullable keeps the null, because there it carries meaning:
`browser_open`'s `profile` means "throwaway profile".

**Do not answer a mutual-exclusion report with a root-level `oneOf`.** The same subset
forbids it — "the root level object of a schema must be an object, and not use `anyOf`" —
so it would break precisely the clients that hit this. Mutual exclusion stays in the
description plus a runtime check, and the error says to send the unused field as null.


### `--enable-automation` is not a Playwright default any more

On 1.62.1 the string appears only in two internal `ignoreDefaultArgs` lists, never in
`chromiumSwitches()`. The `ignoreDefaultArgs: ['--enable-automation']` in
`src/browser/instance.ts` is therefore a no-op today, kept as insurance against
reintroduction. Playwright's defaults *do* already include `--use-mock-keychain` (without
which a locally built Chromium deadlocks on the macOS Keychain prompt) and, when
headless, the `primaryPointerType`/`primaryHoverType` blink settings.

### `--no-sandbox` is a Playwright default, and it shows

`chromiumSandbox` defaults to **false** on `launchPersistentContext`, so Playwright passes
`--no-sandbox`. Chromium lists that switch as unsupported and answers with the *"You are
using an unsupported command-line flag"* infobar — visible to anyone watching a headed
session, and 52px of `innerHeight` gone under it (measured: 547 vs 599 at a 720px window)
while `outerHeight` stays put, which is exactly the sort of mismatch the no-viewport-
emulation rule exists to avoid. `chromiumSandbox: true` in `src/browser/instance.ts` turns
it off at the source. The patched build sandboxes fine both as a local `out/Default` build
and as the extracted release asset; confirmed by the renderer carrying `--seatbelt-client`.
Playwright's default is for Linux CI containers running as root, which this is not.


### Only a temp dir or a slot may be deleted

`Registry.reapOrphans` deletes the user-data directory of an ephemeral record.
`Instance.profileIsEphemeral` derives that from `ProfileChoice.kind`, **not** from
`profileName`: an explicit `user_data_dir` also has no profile name, so the obvious
version of this deletes a directory `browser_open` documents as never deleted. Pinned by
a test.

### Several CLI sessions run at once, and each has its own server

This is the normal case, not an edge case: every agent CLI session spawns its own stdio
server process, so a machine routinely has four or five, each with its own in-memory
instance registry. Two consequences that are easy to get wrong, and one was shipped wrong:

- **Reaping must be scoped by owning server.** The launched-browser records live in
  `<dataDir>/processes/<server-pid>.json`, one file per server, and `reapOrphans` skips any
  file whose pid is still alive. A single shared `processes.json` was both a lost-update
  race between servers and, much worse, indistinguishable from ownership: every record held
  a live browser that passed the "alive and still owns its directory" test, so **starting
  any new session SIGTERMed every browser every other session had open**, then cleared the
  file so the survivors could never be reaped. Reproduced by hand and pinned by
  `tests/lifecycle.test.ts` ("spares the browsers of a server that is still running"),
  which also checks the record file survives, since deleting it leaks the browser later.
- **An `instance_id` is scoped to one server.** It is not a machine-wide handle, so an id
  from another session is correctly "no such instance". Profiles are the shared thing, and
  the second session to ask for a name gets a copy-on-write clone under `profiles/.slots/`,
  which is why two sessions can both use `default` without merging cookies. **A slot is
  one-way**: it is deleted on close, so anything the second session wrote — a login
  included — is silently discarded, while the canonical profile keeps only what the session
  holding it directly did. Merging is not an option (two live Chromium profiles cannot be
  reconciled), so concurrent sessions that both need to persist want distinct profile names.
  Verified by writing a marker in each and reopening.

### An instance lives as long as its session, not five minutes

`idleTimeout` defaults to **0** (no idle reaping). An agent can spend many minutes on other
tools between browser calls and still expect its tabs, scroll position and half-finished
logins to be there; a five-minute default silently destroyed all of it. Nothing leaks,
because Playwright drives Chromium over a pipe, so the browser dies with the server, and
the server dies with the CLI session. `--idle-timeout <s>` still opts back in, which is
what a long-lived `serve` deployment should do.

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

### `like headless` is expected to be non-zero

`detection-check.mjs` reports CreepJS's three ratings. `headless` and `stealth` must be
0%; `like headless` must not, and reads ~31% on macOS. Every one of the five checks that
fires is also true on real Chrome *headed* — three of them probe Android-only APIs, one is
the CSS `ActiveText` colour, and one is the OS light/dark setting, so the number moves
with the theme rather than with headlessness. README has the full four-way measurement.
Do not open a patch against it; the patch repo's CLAUDE.md explains why doing so would
make the browser more identifiable, not less.

### The comparison column has to be measured, not borrowed

README's Chrome column is `detection-check.mjs --binary "/Applications/Google
Chrome.app/..."` — the same server, the same flags, only the binary swapped. It is *not*
the table in the patch repo's CLAUDE.md, which launches Chrome standalone with
`--headless=new` and no driver. Borrowing those numbers put three wrong values in the
README at once: it claimed Chrome reports `navigator.webdriver: false` (it reports `true`
here, because the driver is attached), `headless: 67%` (100%) and 3 sannysoft failures
(4), plus 3 deviceandbrowserinfo signals where the real count is 6.

Both baselines are valid and they answer different questions — "how good is the browser"
versus "how good is this browser *plus this driver*". The README promises the latter, so
it must use the latter.

Also worth knowing before citing them: **`nowsecure.nl` and `browserscan.net` do not
discriminate.** Headless Chrome with `navigator.webdriver === true` passes both. They are
a floor check. The suites that actually separate the two builds are sannysoft,
deviceandbrowserinfo, iphey and CreepJS `headless`.

## Releasing the browser binary

The browser is shipped as a GitHub release asset, never committed to git (`release/` is
gitignored). Currently published: tag `chromium-148.0.7778.215-1`, darwin-arm64 only.

### The ordering is not optional

`src/browser/manifest.json` pins `version`, `revision` and a per-platform `{url, sha256,
size}`. **`sha256: null` means "no asset published for this platform yet"**, and the
resolver says exactly that, pointing at `--binary` / `AGENT_BROWSER_BINARY`. Fill it in
and the resolver starts trusting the URL — so filling it in before the asset is uploaded
turns a clear message into `Download failed: 404`.

So, in this order:

```bash
# 1. Bump `version` (and reset `revision` to "1") in src/browser/manifest.json,
#    leaving sha256 and size null. Same Chromium version, rebuilt patches?
#    Bump `revision` instead. Note `url` embeds both, and step 2 prints the
#    correct one, so there is no need to hand-edit it.

# 2. Package. Prints the manifest entry, including the sha256.
node scripts/package-binary.mjs --app /path/to/out/Default/Chromium.app --out ./release

# 3. Publish the asset FIRST, under the tag the manifest URL names:
#    chromium-<version>-<revision>
gh release create chromium-<version>-<revision> ./release/chromium-<version>-<platform>.tar.gz \
  --title "Patched Chromium <version> (revision <revision>)" --notes "..."

# 4. Only now paste the entry step 2 printed (url, sha256, size) into the
#    manifest, rebuild, and verify from a genuinely cold cache:
npm run build && rm -rf /tmp/cold
#    then open a browser with --data-dir /tmp/cold, no --binary, and no
#    AGENT_BROWSER_BINARY in the environment.

# 5. Commit the manifest and push.
```

Step 4 must actually be run. It is the only thing that exercises download → checksum →
`tar` extract → de-quarantine → launch together, and each of those has silently broken
once already.

### The archive is reproducible, and has to be

`gzip` stamps the current time into its header, so `tar -czf` produces a different
checksum every run from byte-identical input. That is a trap in the procedure above: run
the packager again after uploading — to check a hash, say — and you get a hash that does
not match the published asset, with nothing to indicate why. The packager therefore pipes
`tar -cf -` into `gzip -9 -n`. Two runs over an unchanged bundle now produce the same
sha256, which is what makes the published asset independently verifiable.

### Publishing couples the test suite to the release

`tests/helpers/client.ts` resolves the browser through the product's own `resolveBinary`,
so with no `AGENT_BROWSER_BINARY` the tests download the published asset. Two consequences:

- **The refusal paths become untestable on a published platform.** Two tests in
  `tests/binary.test.ts` asserted "no manifest entry for this platform" and "null sha256";
  both are unreachable once an asset exists for the platform you are testing on, and they
  failed the moment the release went up. They are now one test that seeds the cache and
  asserts resolution only ever returns a path inside the version-pinned cache — never a
  stock Chromium found elsewhere. That invariant holds either way.
- **A test run on a cold cache pulls 154 MB.** Set `AGENT_BROWSER_BINARY` to a local build
  while iterating.

### Why `.tar.gz` and why the xattr

The bundle contains 5 symlinks — including
`Chromium Framework.framework/Versions/Current` — plus executable bits. `tar` preserves
both; a naive zip extractor breaks the bundle silently, so this is not a packaging
preference. Extraction shells out to `tar`, which ships with macOS, Linux and Windows 10+.

macOS additionally needs `xattr -dr com.apple.quarantine` after extracting, because the
build is `adhoc, linker-signed` with `Sealed Resources=none` and no Team ID: downloaded
from the internet it gets quarantined and Gatekeeper refuses to run it.
