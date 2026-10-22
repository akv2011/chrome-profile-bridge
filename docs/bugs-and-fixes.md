# Bugs and fixes

A running log of real bugs found driving the bridge and how they were fixed. Newest first. The
recurring theme in the full-CDP (pipe) path is Chrome's browser-context lifecycle: a context id is
not durable, it dies when a profile's last window closes, and the daemon must never treat a cached
or in-use context id as permanent.

## Full-CDP context lifecycle (2026-10-22)

Surfaced when driving several real signed-in profiles, with more than one chat per profile, over a
long-lived daemon. The unit suite (one clean throwaway profile per test, fresh daemon) never
modelled this, so it stayed green while the live fleet was flaky. Lesson: verify multi-profile,
multi-session behaviour with repeated live runs, not one lucky run.

| Symptom | Cause | Fix | Commit |
|---|---|---|---|
| Daemon reconnects to the holder every few minutes | Self-update restarting the daemon on each commit while catching up through the build's commit history | Expected during an active build; settles once VERSION == running | — |
| A connect hangs ~120s, or a chat is cut off | Self-update restarted the daemon while a connect's profile-open (~20s) was in flight but not yet counted as a client | Self-update waits for `pendingSetups()==0` and a sustained idle window (2 ticks) | daemon |
| "Failed to find browser context" on reconnect | Driver + cache held a context id that died when the profile's window closed | Resolve the profile's LIVE context on every connect; rebuild the driver if the context changed | daemon |
| "could not open its profile window" for many profiles | `chrome://version`-per-context resolution read every open context on every connect (10 x ~3s, past the timeout); slow renders returned empty and a try-count cached that as "not a profile", poisoning real profiles | Launch-correlation: a profile opened by our own `--profile-directory` is mapped from the new-context-after-launch with zero reads (launches serialized); cache warmed in the background at startup; reads cache only on a real load, never on a transient failure | daemon |
| "tab closed during attach" | `Target.getTargets` lags `Target.createTarget`, so a just-created tab was missing from the driver snapshot and `syncTabs` dropped it mid-attach; a `pushTabs` right after `createTab` also re-created the tab object mid-attach | Driver keeps a created tab for a 10s grace window and reports it before `getTargets` lists it; the bridge never drops an attaching tab; the redundant `createTab` push removed | driver + bridge |
| Context dies seconds after the driver is ready | A cache-hit on a pre-existing window had no keepalive, so the window could close between validate and first use | Ensure a hidden keepalive new-tab in every resolved context so its window stays open; validate a cached context before reuse | daemon |
| "Failed to find browser context" while another session holds the same profile | An existing chat's driver stayed bound to a context that died when another chat's window closed; `ensurePipeProfile` only runs on a new connection, so the dead context was never re-resolved for the live one | Self-heal: the driver re-resolves the profile's live context and retries once when Chrome reports the context is gone, so a chat recovers without `/mcp reconnect` | driver + daemon |

### What makes the full-CDP path robust now
- Context ids are never trusted as durable: re-resolved live per connect, validated before reuse,
  pruned when their window closes, and self-healed mid-session when Chrome says one is gone.
- Profiles are identified by launch-correlation (no per-context reads in the hot path); the cache is
  warmed once and a transient read failure is never cached.
- A just-created tab survives the `getTargets` lag; an attaching tab is never dropped by a sync.
- The self-update never restarts the daemon while a connect is setting up or a chat is connected.

## Earlier (extension path)
See the memory `claude-browser-bridge` and the git history: the Microsoft Playwright extension path
needed an approval click per connection, dropped connections, and could not reach seven DevTools
domains (untrusted `chrome.debugger`). The full-CDP path replaced it.
