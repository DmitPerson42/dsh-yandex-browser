# dsh-yandex-browser

[Русский](README.md) | **English**

A DeepSeek Harness plugin: it launches **Yandex Browser** with a persistent profile
and a debugging port, so the agent can work inside your real browser - the one you
are already signed into - and gives the model direct tools for the pages in it.

## Why it exists

An agent in a browser usually runs in a throwaway profile: every launch is a clean
browser with no tabs, no extensions and no cookies. The consequences are obvious:
it cannot open your mail, cannot reach an account page, cannot use your extensions.

This plugin fixes exactly that: the agent browser has **one persistent profile**
(`%USERPROFILE%\.dsh\browsers\yandex`). You sign into your accounts once by hand,
and the sessions stay alive for every later launch.

## How it works

Yandex Browser is Chromium, so it can open a local debugging port (the Chrome
DevTools Protocol). Through it an outside program sees tabs, opens new ones and
runs JavaScript inside a page. The plugin does three things:

```
DSH GUI -> composition
   |-- yandex_browser: launches the browser on port 9222 and supervises it
   |-- yandex_page:    reads the page (text, elements, eval, screenshot)
   |-- yandex_act:     acts on the page (navigate, click, type, tabs)
   `-- yandex MCP (optional): Playwright with the same 25 tools
```

The plugin does not depend on MCP: `yandex_page` and `yandex_act` talk to the
browser directly over that same port. That layer is exactly what you need when the
MCP client cannot attach - which it could not before, and it died on a timeout.

## Tools

### `yandex_browser` - lifecycle

| Action | What it does |
|---|---|
| `status` | Whether the browser runs, its version, the endpoint address, the profile path, the open tabs |
| `start` | Launch the browser with the agent profile and the debugging port (does nothing if it already runs) |
| `open` | Open a URL in a new tab; starts the browser first if it is not running |
| `login` | Open a sign-in page (Yandex Passport by default) so that **you** type the password |
| `tabs` | List open tabs |
| `close` | Quit the browser; the saved sign-ins stay in the profile |

### `yandex_page` - reading

| Action | What it does |
|---|---|
| `text` | The page text plus a list of interactive elements with their labels |
| `eval` | Evaluate an arbitrary JavaScript expression and return its value |
| `screenshot` | Save a PNG (the viewport by default, `fullPage` takes the whole page) |
| `tabs` | Tabs with their ids; tabs created by the plugin are marked |

`text` returns not only `innerText` but also element labels taken from
`aria-label`, `title` and `placeholder`. That is what makes a web-component UI
readable: on Google Drive, for instance, file rows live in custom elements and
never appear in the plain page text.

### `yandex_act` - acting

| Action | What it does |
|---|---|
| `navigate` | Load a URL in the current tab or in a new one |
| `click` | Click an element found by CSS selector or by its visible text |
| `type` | Fill a field (clears it first, works with React forms), optionally submit with Enter |
| `key` | Press a key (Enter, Tab, Escape, arrows, PageUp/PageDown) |
| `activate` | Bring a tab to the front for the user |
| `close` | Close one tab |
| `close_created` | Close every tab this plugin opened |
| `wait` | Wait for an element to appear, by selector or by text |

A typical flow: `status` -> `open` -> `text` (see what is on the page) ->
`click` / `type` -> `close`.

The agent never types credentials. For a sign-in it calls `login`, and you enter
the data in the visible browser window.

## The rule about tabs

A tab the agent opened is clutter if it is left behind. So the plugin remembers
the ids of every tab it opened itself (`agent-tabs.json` in the profile, which
survives a DSH restart) and can close them all in one command:

```
yandex_act action: "close_created"   # closes everything the plugin opened
```

Your own working tabs are never touched: a tab can only be closed by an explicit
id returned from `yandex_page action: "tabs"` or `yandex_act`.

## Installation

```powershell
pwsh -File .\install.ps1
```

The script copies the plugin into `~\.dsh\plugins\dsh-yandex-browser` (no
dependencies, Node built-ins only) and prints what to add to
`~\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: yandex-browser
      name: "file:///C:/Users/Druli/.dsh/plugins/dsh-yandex-browser/lib/index.js"
      config:
        autoStart: true
```

Restart the DSH GUI after editing the configuration.

### Important: fixing the MCP client

The same `cordis.patch.yml` holds the `yandex` MCP server. In the original
configuration the address was passed as a positional argument:

```yaml
args: ["-y", "@playwright/mcp@latest", "http://127.0.0.1:9222"]   # this does not work
```

The current Playwright MCP does not accept that argument and fails with
`too many arguments. Expected 0 arguments but got 1`, which left the server
permanently `disconnected`. It needs an explicit flag:

```yaml
args:
  - "-y"
  - "@playwright/mcp@latest"
  - "--cdp-endpoint"
  - "http://localhost:9222"
```

Two details here, both verified in practice.

**The address is a literal.** The `!!js` syntax is not evaluated in patch entries:
the MCP server received the string
`process.env.YANDEX_CDP ?? 'http://localhost:9222'` and died with `Invalid URL`.
When you change the port, fix that string and the plugin `port` at the same time.

**Use `localhost`, not `127.0.0.1`.** The browser binds its debugging socket to
IPv4 sometimes and to IPv6 only other times - on this machine it once listened on
`[::1]`, where a request to `127.0.0.1` cannot see it. `localhost` in Node walks
both stacks. The plugin does the same: it probes both addresses and reports the
one that actually answers.

## Signing in - once

1. Start DSH with the plugin: the browser comes up on its own (`autoStart: true`).
2. Ask the agent to open the Yandex sign-in page, or call `yandex_browser` with
   `action: "login"`.
3. Sign into your accounts **by hand** in the browser window. Tick "Remember me",
   and if it offers "Sign out of all devices", do not tick it - the password is
   stored in the profile anyway.
4. Done. The sessions live in the agent profile and work on every later launch.

It is also worth visiting the extensions page once, to install the extensions you
want the agent browser to have: they are installed into the profile and survive
restarts.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `autoStart` | `true` | Launch the browser when the plugin loads, so the MCP client finds a live endpoint right away |
| `cdpEndpoint` | `YANDEX_CDP` or `http://localhost:9222` | DevTools address |
| `profileDir` | `YANDEX_BROWSER_PROFILE` or `~\.dsh\browsers\yandex` | Persistent profile |
| `executable` | `YANDEX_BROWSER_PATH` or auto-discovery | Path to `browser.exe` |
| `port` | `YANDEX_BROWSER_PORT` or the port from the endpoint | Debugging port |
| `screenshotDir` | `~\.dsh\browser-shots` | Where screenshots go when no explicit `file` is given |
| `tabStateFile` | `<profileDir>\agent-tabs.json` | Memory of the tabs the plugin created |

The port and the profile are tied to the MCP client: change `YANDEX_CDP` and both
move.

## Verifying

```powershell
node .\test\smoke.mjs                 # status only, does not launch the browser
node .\test\smoke.mjs --launch        # start + open + tabs
node .\test\check-login.mjs           # is the user signed in
node .\test\mcp-check.mjs             # brings MCP up over the live browser and prints its tools
node .\test\page-tools.mjs            # low-level CDP run: tab, text, eval, screenshot
node .\test\tools.mjs                 # all three tools against a local fixture page
node .\test\close-test-browsers.mjs   # close test instances: ports are given as arguments
```

`tools.mjs` is the main test: it loads the plugin with a fake tool registry,
opens `test/fixtures/page.html` in a new tab, reads the page, types text, clicks
buttons by label and by `aria-label`, takes a screenshot and closes the tab. It
needs no DSH of its own - only the agent browser running.

`check-login` does not rely on redirects: it reads the account name from the
`yandex_login` cookie, looks for `Session_id` and opens
`passport.yandex.ru/profile` - if no sign-in form appears, the session is alive.
The values of other cookies are not read.

## When something goes wrong

**A page in the background does not answer.** Chromium freezes background tabs,
and a frozen tab answers no `Runtime.evaluate` at all, which looks exactly like a
dead page. The plugin handles this itself: every session starts with
`Page.bringToFront`. The side effect is that the tab the agent is working on comes
to the front. It is visible, but there is no other way to read background pages.

**Port 9222 is taken by another browser** - the plugin will say by whom. Close it,
or move the port through `YANDEX_CDP` (and remember `YANDEX_BROWSER_PORT`, so the
plugin and MCP keep looking at the same address).

**The first launch takes longer than a minute** - a cold profile creates its
components once (`AsrSubtitles`, `component_crx_cache` and the rest) and shows a
welcome page. The plugin waits up to 60 seconds; later launches take a couple of
seconds.

**MCP `server is disconnected`** - the client did not wait for the browser and ran
out of reconnection attempts. Start the browser with `yandex_browser action:
"start"` and restart the DSH session. This does not affect `yandex_page` and
`yandex_act` - they reconnect on every call.

**The browser does not start and the profile stays empty** - since Chromium 136
the `--remote-debugging-port` switch is ignored for the main profile. The plugin
always launches the browser with a separate `--user-data-dir`; do not change that,
or the port will not open.

**A second instance does not come up** - if Yandex Browser is already open with
your normal profile, the agent still starts its own instance with its own profile.
Both can run at the same time; the port belongs to the agent instance only.

**Sandbox** - under `workspace-write` the plugin cannot create a profile outside
the working directory. In DSH the plugin runs in the host process, so this is not
a problem in normal use; the limitation only affects running the tests from a
sandbox (in that case `tools.mjs` writes screenshots to a temp directory and warns
that the tab list could not be saved - the test result is unaffected).

## Code layout

| File | What it holds |
|---|---|
| `lib/index.js` | The three tools, the browser lifecycle, the tab bookkeeping |
| `lib/cdp.js` | The low-level CDP client: HTTP endpoint, per-tab WebSocket session, page reading scripts |
| `test/*.mjs` | Runs without DSH: smoke, login, MCP, CDP, all tools |
| `install.ps1` | Copies the plugin into the profile and prints the `cordis.patch.yml` entry |

CDP sessions are short-lived: one operation is one WebSocket, closed immediately
afterwards. There is nothing to leak, and such a session survives a tab that was
closed or reloaded halfway through the work.

## License

MIT.