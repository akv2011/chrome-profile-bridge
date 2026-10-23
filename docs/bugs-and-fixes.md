# Bugs and fixes

A running log of real bugs found driving the bridge and how they were fixed. Newest first. The
recurring theme in the full-CDP (pipe) path is Chrome's browser-context lifecycle: a context id is
not durable, it dies when a profile's last window closes, and the daemon must never treat a cached
or in-use context id as permanent.

## Only the last-used profile takes new tabs (2026-10-23)

| Symptom | Cause | Fix | Commit |
|---|---|---|---|
| Connects return 500 "could not find or open its profile window" while the profile has open tabs; most connects take 8-10 s and pop a new window | Chrome resolves a `browserContextId` for `Target.createTarget` only for the last-used profile (the one whose window was active last) or a CDP-made context (`DevToolsBrowserContextManager::GetProfileById`). Any other profile's window opening or being clicked makes every other profile's createTarget fail "Failed to find browser context", which the daemon read as a dead context: validate failed, it relaunched `--profile-directory`, waited 8 s for a new context that never came, then re-read; when the launch did not make the profile last-used (another window took focus first) the re-read failed too. Reproduced under Xvfb: a fresh launch of Profile 2 makes createTarget into Default fail, and back | Validate a cached context by attaching to one of its pages, which works for any profile. Open tabs that createTarget refuses through Chrome's command line with a unique `data:` marker URL (`--profile-directory=X data:text/html,<title>cbb-<uuid></title>`): the tab lands in that profile whatever window is active, and its context is known exactly from the marker, so launch-correlation and the 8 s wait are gone. The marker tab becomes the chat's first tab. `src/profiles.e2e.test.ts` (headful, Xvfb): the second Default chat took 9.0 s on the old code and fails its 5 s bound; the whole test passes in 4.3 s now | daemon + driver |

| Two live chats lost their tabs mid-task | A debug probe looped over `Bridge.listAllTabs` calling `Bridge.adoptTab` on each; adopt moves any tab, including one in another connected chat's group, and that chat's page silently detaches | `Bridge.adoptTab` refuses a tab in another chat's group unless the caller names it (`fromChat: "<key>"`), so a hand-off stays possible but never happens by accident. `pipe.e2e`: on the old code chat B took chat A's tab | bridge |

Earlier rows that blamed "Failed to find browser context" on a closed window were probably this in part:
the profile was alive, just not the last-used one.

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
| 64 idle blank windows piled up (window space, RAM) | The keepalive new-tab held every used profile's window open forever | Keepalive removed. The daemon closes the blank new-tab of a window it opened itself once the chat has a real tab, so a window lives exactly as long as the chat's tabs; a later connect reopens the profile (self-heal covers a mid-session close). Windows the daemon did not open are never touched | daemon + driver |
| After removing the keepalive, one blank window per already-open profile per run (10 -> 34 windows) | With a cold cache right after a daemon restart, the daemon launched `--profile-directory` for profiles already open in the user's windows; that opens a second window in the same context, correlation times out, and the read fallback found the context without recording the blank tab the launch made | Read already-open windows before launching (cached once each), and a launch records every `chrome://newtab` tab that appeared since the spawn whether or not correlation found a new context, so the driver closes it | daemon |
| A resolve stalled 9 minutes; every profile queued behind it failed at 90s | `pipe.send` had no timeout and Chrome can leave a command unanswered (a `chrome://version` page stuck loading); launches are serialized, so one hung read blocked all of them | Optional per-call timeout in `pipe.send`; the daemon's identity calls (read, validate, target listing) and the driver's createTarget/getTargets are bounded, each read capped at a 10s deadline; client-forwarded commands stay unbounded (heap snapshots can be long) | pipe + daemon + driver |
| `Target.getTargets` unanswered for minutes after a few verify runs; every profile lookup timed out at 10s | Both pipe readers (daemon and holder) appended each 64 KB chunk to a growing buffer and rescanned it from the start: one 40 MB heap snapshot cost gigabytes of copying, so the pipe backed up and every other answer waited. (This, not a Chrome crash, was the earlier "9-minute stall"; Chrome's exits that day were code 0, clean quits.) | `NulFramer`: linear framing, each byte scanned and copied once; the holder decodes only small frames. Live: a 168 MB heap snapshot streams in 2.7s and the next `getTargets` answers in 1 ms | pipe + holder |
| Open profiles mis-resolved via a needless launch | An empty `chrome://version` read (slow render under load) was cached as 'not a profile', hiding that context from the next read | Cache only a real profile path; an empty read is retried | daemon |

### What makes the full-CDP path robust now
- Context ids are never trusted as durable: re-resolved live per connect, validated before reuse,
  pruned when their window closes, and self-healed mid-session when Chrome says one is gone.
- No idle windows: a profile's window stays open only while a chat has tabs in it (plus the
  reconnect grace), so unused profiles cost no window space or RAM. An already-open profile is
  never launched again, so it never gets a second window.
- No hangs: every CDP call the daemon makes for its own bookkeeping has a timeout, so a stuck page
  can slow one resolve by seconds, never stall the rest.
- Profiles are identified by a marker tab opened by launch (no per-context reads in the hot path, no
  correlation); the cache is warmed once and a transient read failure is never cached.
- A just-created tab survives the `getTargets` lag; an attaching tab is never dropped by a sync.
- The self-update never restarts the daemon while a connect is setting up or a chat is connected.

## Earlier (extension path)
See the memory `claude-browser-bridge` and the git history: the Microsoft Playwright extension path
needed an approval click per connection, dropped connections, and could not reach seven DevTools
domains (untrusted `chrome.debugger`). The full-CDP path replaced it.
