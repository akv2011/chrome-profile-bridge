# chrome-profile-bridge

A local daemon and Chrome extension that let CDP clients (Playwright, Claude Code, any MCP that
speaks `--cdp-endpoint`) drive your real, signed-in Chrome profiles. No approval click per
connection, no dropped connections, and each client works in its own Chrome tab group so several
clients can share one profile without colliding. macOS.

```
Chrome profile ── extension (chrome.debugger) ──ws──▶ daemon 127.0.0.1:18765 ◀──ws (CDP)── @playwright/mcp (cbb-mcp)
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

## DevTools coverage

Through the extension's `chrome.debugger`, Chrome gives an untrusted CDP session, so it refuses
seven domains: DOMStorage, IndexedDB, ServiceWorker, Security, Profiler, Memory, HeapProfiler.
Most have a workaround (page JS for storage/IndexedDB/service workers, Tracing for CPU profiles,
Performance metrics for DOM counts, `Network.responseReceived` `securityDetails` for certs).

For the rest (heap snapshots, JS code coverage, ignoring cert errors), the daemon can run in
full-CDP mode: it launches Chrome with `--remote-debugging-pipe` on a non-default
`--user-data-dir` (required since Chrome 136), a fully trusted connection that reaches every
domain while the extension keeps doing identity, tab groups and tab lifecycle. See
[`docs/full-cdp.md`](docs/full-cdp.md).

## Setup

1. `bin/install.sh` installs the daemon under launchd (`local.chrome-profile-bridge`), the
   extension, and `cbb-mcp`. Run it again to update.
2. Map profile names to Chrome profile directories in `~/.chrome-profile-bridge/profiles.json`
   (see `profiles.json.example`; the directory is the last part of "Profile Path" at
   `chrome://version`).
3. In each profile: `chrome://extensions`, Developer mode on, Load unpacked,
   `~/.chrome-profile-bridge/extension`. The toolbar icon shows green when connected.
4. `bin/use-bridge.sh` points your `pw-*` MCP entries at the bridge for every connected profile.
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
