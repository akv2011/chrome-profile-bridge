# chrome-profile-bridge

A local daemon that lets CDP clients (Playwright, Claude Code, any MCP that speaks
`--cdp-endpoint`) drive your real, signed-in Chrome profiles. No approval click per connection,
no dropped connections, and each client is isolated to its own tabs so several clients can share
one profile without colliding. In the recommended mode there is no extension at all: a holder
owns Chrome over the trusted debugging pipe and the daemon drives every profile through it.
macOS.

```
full-CDP:   holder ── --remote-debugging-pipe ──▶ Chrome (all profiles)
                └─ unix socket ─▶ daemon 127.0.0.1:18765 ◀──ws (CDP)── @playwright/mcp (cbb-mcp)
extension:  Chrome profile ── extension (chrome.debugger) ──ws──▶ daemon ◀──ws (CDP)── client
```

Why it exists: driving a signed-in profile usually means either copying the profile (fragile,
logs you out) or approving a debugger connection by hand every time. This keeps one always-on
daemon per machine that holds a single extension socket per profile and serves CDP clients over
`--cdp-endpoint`, so an agent connects instantly and acts as you, with your logins.

## For clients

- Use the normal `mcp__pw-<name>__browser_*` tools. Each client gets its own Chrome tab group
  named after it and sees only its own tabs. A reconnecting client gets its tabs back for 10
  minutes, then they close.
- Raw CDP for anything the tools don't cover, via `browser_run_code_unsafe`:

  ```js
  async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    return (await cdp.send("Network.getAllCookies")).cookies.length;
  }
  ```
- Adopt or release one of your own tabs through a browser session: `Bridge.listAllTabs`,
  `Bridge.adoptTab { tabId }`, `Bridge.releaseTab { tabId }`. A tab in another chat's group is refused
  unless you name that chat: `{ tabId, fromChat: "<its key>" }`.

## Agent methods (`Bridge.*`)

Call these over the page's CDP session (`page.context().newCDPSession(page).send("Bridge.x", …)`). They add the agent layer on top of raw CDP:

| Method | What it does |
|---|---|
| `Bridge.snapshot { diff? }` | Interactive-only accessibility tree (role, name, value, id). `diff` returns only what changed since the last call. Small, so a step costs fewer tokens. |
| `Bridge.act { id, action, text? }` | Scroll an element in, wait until it's actionable, click/type/hover, then poll and report `{ changed, navigated, url }`. |
| `Bridge.marks { screenshot? }` | Interactive elements with click coordinates, for visual grounding when names are thin. |
| `Bridge.extract { expression }` | Run an in-page expression and return its JSON value. |
| `Bridge.setFastLoad { groups?, urls? }` | Block images/fonts/media/ads (or custom patterns) on this chat's tabs. Faster loads, smaller snapshots. |
| `Bridge.har { clear? }` | The network requests on this chat's tabs (method, url, status, type). |
| `Bridge.setDownloadDir` / `Bridge.downloads` | Point downloads at a per-chat directory and list what landed. |
| `Bridge.timelineCapture { label }` / `Bridge.timeline` | A numbered screenshot + log per step, so a run can be reviewed. `Bridge.act` records automatically. |
| `Bridge.health` | `{ name, email, signedIn }` so an agent stops before using a logged-out profile. |
| `Bridge.requestHuman { reason, until?, timeoutMs? }` | Last resort after the agent tries a captcha/2FA/login itself: ping the user once (`CBB_NOTIFY_CMD`), poll `until` until solved, resume. |
| `Bridge.saveSecret { service, account, value? }` / `Bridge.typeSecret { id, service, account }` | Save a credential (or generate one the agent never sees) and type it into a field, for sign-up and auto-fill. The value never crosses the wire. |
| `Bridge.record { name }` / `Bridge.stopRecording` / `Bridge.replay { name }` | Capture a flow (navigations + acts by role+name) and rerun it deterministically. |

Across profiles: `bin/cbb-fanout <name…> [--url <url>] -- "<expression>"` runs one snippet on several profiles at once and prints one result each.

## Two modes

- **Full-CDP (recommended), no extension.** A tiny holder owns Chrome over
  `--remote-debugging-pipe` on a non-default `--user-data-dir` (required since Chrome 136), a
  fully trusted connection, and the daemon drives every profile through it. It tells profiles
  apart by reading each one's path from `chrome://version`, so no extension is installed and
  nothing to approve. Every DevTools domain works, including heap snapshots, CPU and JS-coverage
  profiling, `Memory`, `DOMStorage`, `IndexedDB`, `ServiceWorker` and `Security`. Switch to it
  with `bin/full-cdp.sh` (moves Chrome's data to `~/ChromeData` and symlinks the default path
  back, reversible with `--undo`). Because the holder owns Chrome separately from the daemon, a
  daemon update or crash never closes your browser. Quitting Chrome leaves it closed; the next
  client that needs a profile starts it again. Open it any way you like (Dock, Spotlight, a link):
  a Chrome started without the pipe while the holder's is closed is quit cleanly within a second
  and reopened through the holder with its tabs restored. See
  [`docs/full-cdp.md`](docs/full-cdp.md).
- **Extension.** Each profile loads the unpacked extension, which uses `chrome.debugger`. Chrome
  gives that an untrusted CDP session and refuses seven domains (DOMStorage, IndexedDB,
  ServiceWorker, Security, Profiler, Memory, HeapProfiler); most have a workaround (page JS for
  storage, Tracing for CPU profiles, Performance metrics for DOM counts). Use this if you cannot
  move the Chrome data directory.
  Chrome launches with `--disable-blink-features=AutomationControlled` (`CBB_CHROME_EXTRA`, set by
  `bin/install.sh`): the pipe alone makes `navigator.webdriver` true and Cloudflare checks never clear.
  Keep it; see `docs/full-cdp.md`.

## Setup

1. `bin/install.sh` installs the daemon under launchd (`local.chrome-profile-bridge`) and
   `cbb-mcp`. It picks full-CDP or extension mode from disk and is safe to run again. A
   post-commit hook ships every later commit into the running install, which restarts itself on
   the new code once no client is connected (the holder, and so your browser, is left alone).
2. For full-CDP mode (recommended): `bin/full-cdp.sh`. It restarts Chrome once; your tabs come
   back. Undo any time with `bin/full-cdp.sh --undo`.
3. Map profile names to Chrome profile directories in `~/.chrome-profile-bridge/profiles.json`
   (see `profiles.json.example`; the directory is the last part of "Profile Path" at
   `chrome://version`), or run `bin/sync-profiles.sh` to add a `pw-*` entry for every signed-in
   profile automatically. In extension mode only, also Load unpacked
   `~/.chrome-profile-bridge/extension` in each profile.
4. `bin/use-bridge.sh` points your `pw-*` MCP entries at the bridge.
   Clients already running keep their old command; with a global `@playwright/mcp`, install.sh
   puts a shim at its `playwright-mcp` path that sends `--extension --profile-dir-name X` calls to
   the bridge, so a `/mcp reconnect` fixes them without a restart.
5. Status: `curl -s http://127.0.0.1:18765/status`. Log: `~/.chrome-profile-bridge/daemon.log`.

## Limits

- Chrome shows "started debugging this browser" while a client drives a tab. Every extension
  debugger does; only the `--silent-debugger-extension-api` launch flag hides it.
- `chrome://` pages and the Chrome Web Store cannot be driven by any extension.
- A profile not signed in to Chrome cannot be identified by email; the popup says so.

## Tests

`npm install && npx vitest run`: the bridge unit tests, plus end-to-end runs of real
`playwright-core` and `@playwright/mcp` against a headless Chromium behind a CDP-backed stand-in
for the extension (`src/testing/`).

The CDP extension relay is adapted from [OpenClaw](https://github.com/) (MIT); see
`third_party/OPENCLAW-LICENSE`.
