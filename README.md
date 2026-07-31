# agent-browser

An undetectable browser MCP server. **Cross-origin iframes are ordinary DOM.**

32 tools, zero required arguments. It launches a patched Chromium that measures as
*less* automated than real Chrome does, and exposes it through the Model Context
Protocol.

```bash
agent-browser            # stdio, the usual MCP mode
agent-browser serve      # Streamable HTTP at /mcp
```

> Not on npm. The name `agent-browser` there belongs to an unrelated project
> ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)), so install
> from source as below — do **not** `npm i agent-browser` expecting this.

## Why

Two things are hard about driving a browser for an agent, and most tools get one of them.

**Not being detected.** The browser is built from
[undetected-chromium](https://github.com/a4501150/undetected-chromium) patches, so the
tells are removed in C++ rather than papered over with injected JavaScript — which is
itself the loudest tell. Both columns below were measured through this server on the same
machine, changing nothing but `--binary`, so the only variable is the browser:

| Suite | agent-browser | Real Chrome 150, same server |
|---|---|---|
| `navigator.webdriver` | **`false`** | `true` |
| `Headless` in the user agent | **no** | yes |
| bot.sannysoft.com | **0 failed** | 4 failed |
| deviceandbrowserinfo.com `are_you_a_bot` | **`isBot: false`**, 0 of 22 signals | `isBot: true`, 6 signals |
| iphey.com | **Trustworthy** | Unreliable |
| CreepJS `headless` | **0%** | 100% |
| CreepJS `stealth` | 0% | 0% |
| CreepJS `like headless` | 31% | 38% |
| browserscan.net/bot-detection | Normal, 0 abnormal | Normal, 0 abnormal |
| nowsecure.nl (real Cloudflare) | passes | passes |

Both builds come through Playwright and neither is identified as such (`isPlaywright:
false`). What separates them is that Chrome driven this way leaks the attachment itself —
`hasWebdriverTrue`, `hasWebdriverInFrameTrue`, `isAutomatedWithCDP`,
`isAutomatedWithCDPInWebWorker` and `hasInconsistentTimingResolution`, on top of
`hasBotUserAgent`. This build leaks none of the six, which is why its column is not simply
"Chrome headless minus the user agent".

**The last two rows do not discriminate**, and are listed so that is visible rather than
implied: plain headless Chrome passes both. Treat them as a floor, not as evidence.

`like headless` is the one row that does not reach zero, and it should not: **31% is what
real Chrome 150 _headed_ scores on this machine**, with the same five of sixteen checks
true. Three of them (`noContentIndex`, `noContactsManager`, `noDownlinkMax`) test
Android-only APIs, so they are true on every desktop Chrome ever shipped;
`hasKnownBgColor` is the CSS `ActiveText` system colour being red, which Chrome always
does; and `prefersLightColor` is the OS theme, so the same browser scores 25% in dark
mode. The check that does separate the two columns is `noTaskbar` — Chrome headless
reports an invented `screen 800x600` whose `availHeight` equals its height, where this
build reports the real screen. Driving the row to 0% would mean serving an Android API
surface under a macOS user agent, which is a far louder signal than the one it removes.

Reproduce either column yourself:

```bash
npm run build
node scripts/detection-check.mjs                                    # this browser
node scripts/detection-check.mjs --binary \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"    # the comparison
```

**Reaching everything on the page.** Cross-origin iframes are where most drivers stop.
Here they need no special handling at all: they appear in the page outline with
frame-prefixed refs, and every action tool takes those refs.

```
- generic [ref=e1]:
  - generic [ref=e2]: parent page
  - iframe [ref=e3]:
    - generic [ref=f1e1]:
      - button "click me" [ref=f1e3]      <- a different site, a different process
```

`browser_click { target: "f1e3" }` lands inside the child with `isTrusted: true`, at
correctly translated coordinates, while the page still sees `contentDocument === null`
exactly as the platform guarantees. Nothing about the page's own JavaScript world is
touched, so there is nothing for a page to detect.

## Install

From source, which is the only way today:

```bash
git clone https://github.com/a4501150/agent-browser.git
cd agent-browser
npm ci
npm run build
```

Then point your MCP client at the built entry point. For Claude Code:

```bash
claude mcp add agent-browser -- node /absolute/path/to/agent-browser/dist/index.js
```

Or by hand, in an MCP client's config:

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "node",
      "args": ["/absolute/path/to/agent-browser/dist/index.js"]
    }
  }
}
```

The patched Chromium is downloaded on first use into `~/.agent-browser/chromium/`,
checksum-verified before extraction, from the
[`chromium-148.0.7778.215-1`](https://github.com/a4501150/agent-browser/releases/tag/chromium-148.0.7778.215-1)
release. **Only macOS arm64 is published.** On any other
platform the server refuses to start rather than silently falling back to a stock
Chromium, which would lose every guarantee above without telling you. Build it yourself
and point at it:

```bash
agent-browser --binary /path/to/Chromium.app
# or
export AGENT_BROWSER_BINARY=/path/to/Chromium.app
```

## The tools

Every `browser_*` tool takes `instance_id`, returned by `browser_open`. `target` accepts
a ref from the page outline (`e12`, `f1e3`), a CSS selector, or an XPath (recognised by a
leading `/`).

**Instances** — `browser_open` `browser_list` `browser_close`

**Navigation** — `browser_navigate { url | action: back|forward|reload }`

**Perception** — `browser_read_page` `browser_find` `browser_screenshot`

`browser_read_page` is the primary way to see a page: an accessibility outline with
`[ref=eN]` handles, typically 10–50× smaller than the HTML, recursing into iframes.
Prefer it over screenshots.

**Interaction** — `browser_click` `browser_hover` `browser_drag` `browser_type_text`
`browser_press_key` `browser_fill_form`

**Modals and waiting** — `browser_wait_for` `browser_handle_dialog` `browser_upload_file`

**Scripting** — `browser_run_javascript`

**Tabs** — `browser_tabs { list|new|select|close }`

**Observation** — `browser_read_console` `browser_list_requests` `browser_get_request`

**Coordinates** — `browser_mouse { move|click|down|up|drag }` `browser_scroll`

**State** — `browser_cookies` `browser_storage` `browser_session`
`browser_intercept_requests`

**Window** — `browser_set_window_size`

**Web** — `web_search` `web_fetch` `web_crawl` `web_extract`

The `web_*` tools need no `instance_id`. They fetch through the same patched browser as
everything else — there is no separate HTTP client, because a Node one would carry
undici's TLS fingerprint into a project whose whole premise is that its traffic does not
look automated. They share one throwaway-profile browser, held for a minute of inactivity
so a search and the fetches after it are one coherent session, and thrown away with
whatever a site left in it. It never appears in `browser_list`: nothing the agent opened.

`web_fetch` returns one **self-contained markdown document** by default — the title, where
it came from, then the article, so a result written to a file still says what it is:

```markdown
# useState – React

- URL: https://react.dev/reference/react/useState
- Status: 200
- Content type: text/html

---

`useState` is a React Hook that lets you add a state variable to your component.
```

The other three formats answer different questions: `html` is the DOM after scripts have
run, `raw` is the bytes the server sent before them, `pdf` prints the page. Anything that
is not a web page — JSON, a feed, a sitemap, a PDF, an attachment — comes back as itself,
from the response body rather than from `page.content()`, which would return Chromium's
viewer markup instead of the document. On a 319 KB feed that difference is 1.79 MB.

`web_search` drives the same SERP a human sees, rather than DuckDuckGo's HTML-only endpoint,
which has no ranked answer for a `site:` query at all. Ads are excluded structurally, by the
layout DuckDuckGo marks them with. Asking for more results than fit on one screen clicks its
own "More results" until the engine stops giving them.

A Cloudflare interstitial is waited out rather than returned: the response says
`cf-mitigated: challenge`, Turnstile runs, and the real page arrives a few seconds later. An
interactive checkbox or an image CAPTCHA is not solved for you — open an instance and click
it, which works even though the widget is in a cross-origin iframe.

## Profiles

`browser_open { profile: "name" }` uses `~/.agent-browser/profiles/<name>` **directly**
whenever it is free, so cookies, history and logins accumulate across sessions with no
copying and no merging.

Chromium forbids two processes sharing one user-data directory, so a second concurrent
instance of the same profile gets a copy-on-write clone in an ephemeral slot, discarded
on close. There is never a merge step, and therefore never a lost-cookie race.

`browser_open { profile: null }` gives a throwaway profile. `browser_open { user_data_dir }`
uses a directory verbatim and never deletes it.

**Identity is stable per profile.** `fingerprint: N` selects one whole machine's hardware
and GPU strings, and the seed is persisted in the profile, so reopening it reports the
same machine. With no `fingerprint` the browser behaves exactly like stock Chrome —
which is usually what you want.

## Window size, not viewport emulation

`browser_set_window_size` resizes the real OS window. Contexts launch with no
device-metrics override at all, so the layout viewport follows the window — for our
resizes and for a human dragging the corner alike — and `outerWidth`, `innerWidth`,
`screen.*` and `devicePixelRatio` cannot contradict each other. There is deliberately no
mobile emulation and no device-scale-factor override: both require that override, and an
emulated phone on a desktop OS is a contradiction a detector can find.

## Options

```
agent-browser [serve] [options]

  --port <n>            HTTP port for serve (default 3000)
  --host <addr>         HTTP bind address for serve (default 127.0.0.1)
  --headed              launch browsers with a visible window
  --binary <path>       patched Chromium (.app bundle or executable)
  --data-dir <path>     profiles, browser cache and artifacts (default ~/.agent-browser)
  --idle-timeout <s>    close instances idle this long (default 0: keep them for
                        as long as the server runs)
  --version  --help
```

Environment: `AGENT_BROWSER_BINARY`, `AGENT_BROWSER_DATA_DIR`, `AGENT_BROWSER_TOKEN`.

Binding a non-loopback address requires `AGENT_BROWSER_TOKEN` and refuses to start
otherwise: anyone who can reach that port could drive your browser and read your
logged-in sessions.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test                       # 122 tests; needs the patched Chromium
AGENT_BROWSER_LIVE=1 npm test  # also runs the live DuckDuckGo test
```

The tests resolve the browser exactly the way the server does, so they work
against the downloaded release, or against a local build via
`AGENT_BROWSER_BINARY=/path/to/Chromium.app npm test`.

`tests/crossframe.test.ts` is the one to keep passing: it asserts the child frame's
button appears with an `fNeN` ref, that clicking it records `isTrusted: true` inside the
child, and that the page still cannot reach `contentDocument`.

Publishing a new browser build is an ordering-sensitive four steps (the asset has to exist
before the manifest names its checksum, or first use fails with a 404 instead of a useful
message). See "Releasing the browser binary" in [CLAUDE.md](CLAUDE.md).

## Credits

Built on [Playwright](https://github.com/microsoft/playwright) (Apache-2.0), whose tool
layer is vendored from tag `v1.62.1` — it already translates out-of-process iframe
coordinates and recurses the accessibility snapshot into child frames, which is the
entire reason it was chosen. The shape of `web_search` and `web_fetch` owes ideas to
[stealth-browser-mcp](https://github.com/vibheksoni/stealth-browser-mcp) (MIT), though no
implementation remains. See [NOTICE](NOTICE).

Apache-2.0.
