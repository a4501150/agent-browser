# agent-browser

An undetectable browser MCP server. **Cross-origin iframes are ordinary DOM.**

32 tools, zero required arguments. It launches a patched Chromium that measures as
*less* automated than real Chrome does, and exposes it through the Model Context
Protocol.

```bash
npx agent-browser            # stdio, the usual MCP mode
npx agent-browser serve      # Streamable HTTP at /mcp
```

## Why

Two things are hard about driving a browser for an agent, and most tools get one of them.

**Not being detected.** The browser is built from
[fingerprint-chromium](https://github.com/a4501150/undetected-chromium) patches, so the
tells are removed in C++ rather than papered over with injected JavaScript — which is
itself the loudest tell. Measured through this server, launched exactly as it launches:

| Suite | agent-browser | Real Chrome 150 headless |
|---|---|---|
| `navigator.webdriver` | `false` | `false` |
| `Headless` in the user agent | no | **yes** |
| bot.sannysoft.com | **0 failed** | 3 failed |
| deviceandbrowserinfo.com `are_you_a_bot` | **`isBot: false`**, 0 of 22 signals | `isBot: true`, 3 signals |
| iphey.com | **Trustworthy**, nothing flagged | Unreliable |
| CreepJS `headless` | **0%** | 67% |
| CreepJS `stealth` | **0%** | 0% |
| CreepJS `like headless` | 31% | 31% |
| browserscan.net/bot-detection | **Normal**, 0 abnormal of 19 | — |
| nowsecure.nl (real Cloudflare) | **passes** | — |

Notably `isPlaywright: false` and `isAutomatedWithCDP: false`, so the driver underneath
is not visible either. Reproduce it yourself:

```bash
npm run build && node scripts/detection-check.mjs
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

```bash
npm i -g agent-browser
```

Then point your MCP client at it. For Claude Code:

```bash
claude mcp add agent-browser -- npx -y agent-browser
```

The patched Chromium is downloaded on first use into `~/.agent-browser/chromium/`,
checksum-verified before extraction. **Only macOS arm64 is published.** On any other
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

The `web_*` tools need no `instance_id`. They try a plain HTTP request first and escalate
to a real browser only when the response looks challenged or renders client-side, and
they always use a throwaway profile so research traffic never touches a logged-in one.

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
  --idle-timeout <s>    close instances idle this long; 0 disables (default 300)
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

## Credits

Built on [Playwright](https://github.com/microsoft/playwright) (Apache-2.0), whose tool
layer is vendored from tag `v1.62.1` — it already translates out-of-process iframe
coordinates and recurses the accessibility snapshot into child frames, which is the
entire reason it was chosen. The DuckDuckGo search is ported from
[stealth-browser-mcp](https://github.com/vibheksoni/stealth-browser-mcp) (MIT). See
[NOTICE](NOTICE).

Apache-2.0.
