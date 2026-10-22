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
  `Bridge.adoptTab { tabId }`, `Bridge.releaseTab { tabId }`.

## Two modes

- **Full-CDP (recommended), no extension.** A tiny holder owns Chrome over
  `--remote-debugging-pipe` on a non-default `--user-data-dir` (required since Chrome 136), a
  fully trusted connection, and the daemon drives every profile through it. It tells profiles
  apart by reading each one's path from `chrome://version`, so no extension is installed and
  nothing to approve. Every DevTools domain works, including heap snapshots, CPU and JS-coverage
  profiling, `Memory`, `DOMStorage`, `IndexedDB`, `ServiceWorker` and `Security`. Switch to it
  with `bin/full-cdp.sh` (moves Chrome's data to `~/ChromeData` and symlinks the default path
  back, reversible with `--undo`). Because the holder owns Chrome separately from the daemon, a
  daemon update or crash never closes your browser. See [`docs/full-cdp.md`](docs/full-cdp.md).
- **Extension.** Each profile loads the unpacked extension, which uses `chrome.debugger`. Chrome
  gives that an untrusted CDP session and refuses seven domains (DOMStorage, IndexedDB,
  ServiceWorker, Security, Profiler, Memory, HeapProfiler); most have a workaround (page JS for
  storage, Tracing for CPU profiles, Performance metrics for DOM counts). Use this if you cannot
  move the Chrome data directory.

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
