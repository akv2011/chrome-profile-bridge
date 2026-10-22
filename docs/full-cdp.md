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

Set `CBB_CHROME_UDD` to a non-default Chrome data directory (a symlink to your real one is fine;
the switch value just has to differ from the default path string). The daemon then launches Chrome
with `--remote-debugging-pipe --load-extension=<extension> --user-data-dir=$CBB_CHROME_UDD`, speaks
CDP over the pipe (one trusted connection to the whole browser), and drives real page targets. The
extension still provides identity, tab groups and tab lifecycle, and reports each tab's CDP
targetId so the daemon knows which real target to drive. The `browser_*` tool surface does not
change; it only gains the domains Chrome otherwise blocks.

On macOS your logins survive a non-default data dir because the cookie-encryption key lives in the
Keychain, not the path.

## Tradeoff

This changes how your daily Chrome launches (through the daemon, with the pipe) and points it at a
non-default data directory. It is reversible: stop launching with the flag and point back at the
default directory.

Lower-touch alternative: keep the extension-only path (it covers all signed-in browsing and most
DevTools) and only reach for a debugging copy of a profile when you need heap snapshots, JS
coverage or cert bypass.
