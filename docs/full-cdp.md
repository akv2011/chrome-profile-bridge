# Full CDP: the pipe path

The extension's `chrome.debugger` gets an untrusted V8 inspector session, so Chrome refuses
Profiler, HeapProfiler, Memory, DOMStorage, IndexedDB, Security and ServiceWorker. A real
remote-debugging connection is fully trusted and reaches all of them (verified: a multi-megabyte
heap snapshot and JS precise coverage both work over the pipe).

## Why it needs a one-time setup change

Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored when the
`--user-data-dir` is the default one. From Chrome's blog: the switches "must now be accompanied by
the `--user-data-dir` switch to point to a non-standard directory." You cannot attach debugging to
an already-running Chrome, and you cannot run a second instance on the same data dir. So the real
browser must be launched, from the start, with a non-default data dir and the pipe.

A pipe is a local file descriptor, not a network port, so it is not reachable off-machine. The
daemon owns Chrome's launch, which is how it holds the pipe.

## How it works

`bin/full-cdp.sh` moves Chrome's data to `~/ChromeData` (a rename on the same disk) and symlinks
the default path back to it. The directory has to be physically non-default: Chrome 136 resolves a
symlink and refuses the pipe if it still points at the default location, so moving the data, not
just linking to it, is what satisfies the check. A holder (`src/holder.ts`) then launches Chrome
with `--remote-debugging-pipe --user-data-dir=~/ChromeData` and serves the pipe on an owner-only
unix socket; the daemon connects to that socket and drives real page targets over one trusted CDP
connection to the whole browser.

There is no extension. The daemon tells profiles apart by opening `chrome://version` in each
browser context and reading its profile path, and it opens a closed profile on demand with
`--profile-directory`. It tracks each client's own tabs for isolation. The `browser_*` tool
surface does not change; it only gains the domains Chrome otherwise blocks.

Because the holder owns Chrome and the pipe, the daemon can restart (to update itself, or after a
crash) without closing the browser: it just reconnects to the socket, and the holder detaches the
previous daemon's debug sessions so the new one starts clean. Chrome only restarts if Chrome itself
exits, and launchd brings the holder back.

On macOS your logins survive a non-default data dir because the cookie-encryption key lives in the
Keychain, not the path.

## Tradeoff

This changes how your daily Chrome launches (through the daemon, with the pipe) and points it at a
non-default data directory. It is reversible: stop launching with the flag and point back at the
default directory.

Lower-touch alternative: keep the extension-only path (it covers all signed-in browsing and most
DevTools) and only reach for a debugging copy of a profile when you need heap snapshots, JS
coverage or cert bypass.

## navigator.webdriver and Cloudflare

`--remote-debugging-pipe` turns on Blink's AutomationControlled, so `navigator.webdriver` is true in every tab
of the real Chrome. Cloudflare's managed check ("Just a moment...") then never clears, on any site, for you as
well as for agents.

- **Fix:** the holder launches Chrome with `--disable-blink-features=AutomationControlled` through
  `CBB_CHROME_EXTRA` (set in `bin/install.sh`). A pipe-launched Chromium reads `webdriver=true` without the flag,
  `false` with it. `Emulation.setAutomationOverride {enabled:false}` per tab does not override the launch
  switch. Changing the flag needs the holder reloaded while Chrome is closed (reloading it while Chrome runs
  closes the browser).
- **A tab with a CDP client attached can still be caught** with webdriver false. A challenge clears in a plain
  tab: open the URL through Chrome's singleton hand-off,
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=$HOME/ChromeData --profile-directory="Profile N" <url>`,
  wait about 25 s, then read `cf_clearance` with `context.cookies(url)` without attaching to that tab.
  Automated tabs then load the site on that cookie.
