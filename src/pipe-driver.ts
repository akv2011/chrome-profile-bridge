/**
 * The no-extension full-CDP driver. Stands in for the Chrome extension, in-process, for one
 * profile: it answers the bridge's tab and group commands by driving the real browser over the
 * trusted pipe, scoped to that profile's browser context. Identity (the profile's email) comes
 * from the daemon, which read it from chrome://version, so no extension has to load. The actual
 * CDP (attach/detach/commands) runs over the pipe through the bridge's CdpExecBackend, which is
 * fully trusted and reaches every DevTools domain.
 */
import { createLogger } from "./log.ts";
import type { ChromePipe, PipeTargetEvent } from "./pipe.ts";
import type { BridgeSocket, ExtensionRelayBridge } from "./relay-bridge.ts";
import type { RelayTabInfo } from "./relay-protocol.ts";

const log = createLogger("pipe-driver");

type PageTarget = { targetId: string; url: string; title: string };

/** Attach one profile to the bridge, driven by the shared pipe and scoped to `contextId`. */
export function drivePipeProfile(opts: {
  bridge: ExtensionRelayBridge;
  pipe: ChromePipe;
  contextId: string;
  email: string;
  browserVersion: string;
  /** Blank new-tab pages of a window the daemon opened for this chat. Closed once the chat has its own
   *  tab, so an idle profile's window can close instead of lingering (window space, RAM). */
  strayNewTabs?: string[];
  /** Re-resolve this profile's live context (opening the profile if needed). Called to self-heal when
   *  Chrome reports the bound context is gone, so an existing chat recovers without reconnecting. */
  reresolve?: () => Promise<{ contextId: string; strays: string[] } | null>;
}): { contextId: string; ready: Promise<void>; onTargetEvent: (e: PipeTargetEvent) => void; dispose: () => void } {
  const { bridge, pipe, email, browserVersion } = opts;
  let contextId = opts.contextId; // mutable: reresolve may rebind it to a fresh context
  const strays = [...(opts.strayNewTabs ?? [])];
  const byTab = new Map<number, string>(); // tabId -> targetId
  const group = new Map<number, number>(); // tabId -> logical groupId
  const createdAt = new Map<number, number>(); // tabId -> ms, to spare a just-created tab from pruning
  let nextTab = 1;
  let nextGroup = 1;
  const targetId = (tabId: number) => byTab.get(tabId);
  const tabIdOf = (tid: string) => [...byTab].find(([, t]) => t === tid)?.[0];

  let toBridge: { onMessage: (raw: string) => void; onClose: () => void } | null = null;
  const socket: BridgeSocket = {
    send: (raw: string) => void handleCommand(JSON.parse(raw)),
    close: () => {},
  };

  /** Create a tab in this profile's context. If Chrome says the context is gone (its window closed),
   *  re-resolve the profile's live context once and retry, so the chat recovers without reconnecting. */
  async function createInContext(url: string): Promise<string> {
    try {
      return ((await pipe.send("Target.createTarget", { url, browserContextId: contextId }, undefined, 20_000)) as { targetId: string }).targetId;
    } catch (err) {
      if (!opts.reresolve || !String(err).includes("Failed to find browser context")) throw err;
      const fresh = await opts.reresolve();
      if (!fresh) throw err;
      contextId = fresh.contextId;
      strays.push(...fresh.strays);
      log.info(`${email}: context was gone; rebound to a fresh one`);
      return ((await pipe.send("Target.createTarget", { url, browserContextId: contextId }, undefined, 20_000)) as { targetId: string }).targetId;
    }
  }

  async function pageTargets(): Promise<PageTarget[]> {
    const { targetInfos } = (await pipe.send("Target.getTargets", {}, undefined, 10_000)) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string; browserContextId?: string }>;
    };
    // Hide blank new-tab pages (the one a daemon-opened window starts with, until it is closed, and
    // any of the user's own); the agent should not see or drive them.
    return targetInfos
      .filter((t) => t.type === "page" && t.browserContextId === contextId && !/^chrome:\/\/(new-?tab|newtab)/.test(t.url))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
  }

  /** Current tabs the bridge should see: every page in this profile's context, with a stable tabId. */
  async function tabs(): Promise<RelayTabInfo[]> {
    const pages = await pageTargets();
    const live = new Set(pages.map((p) => p.targetId));
    // Target.getTargets lags Target.createTarget, so a just-created tab can be missing here; keep it
    // for a grace window, or syncTabs on the bridge would drop it while it is still being attached.
    for (const [tabId, tid] of byTab) {
      if (live.has(tid)) continue;
      if (Date.now() - (createdAt.get(tabId) ?? 0) < 10_000) continue;
      byTab.delete(tabId);
      group.delete(tabId);
      createdAt.delete(tabId);
    }
    const listed = new Set(pages.map((p) => p.targetId));
    const out = pages.map((p) => {
      let tabId = tabIdOf(p.targetId);
      if (tabId === undefined) { tabId = nextTab++; byTab.set(tabId, p.targetId); }
      return { tabId, url: p.url, title: p.title, active: false, groupId: group.get(tabId) ?? -1, targetId: p.targetId };
    });
    // Include just-created tabs that Target.getTargets has not listed yet, so the bridge keeps them.
    for (const [tabId, tid] of byTab) {
      if (listed.has(tid)) continue;
      out.push({ tabId, url: "about:blank", title: "", active: false, groupId: group.get(tabId) ?? -1, targetId: tid });
    }
    return out;
  }

  function reply(seq: number, result: unknown) {
    toBridge?.onMessage(JSON.stringify({ type: "result", seq, result }));
  }
  function fail(seq: number, message: string) {
    toBridge?.onMessage(JSON.stringify({ type: "error", seq, message }));
  }
  function pushTabs() {
    void tabs().then((t) => toBridge?.onMessage(JSON.stringify({ type: "tabs", tabs: t }))).catch(() => {});
  }

  async function handleCommand(msg: { type: string; seq?: number } & Record<string, unknown>): Promise<void> {
    const seq = msg.seq as number;
    try {
      switch (msg.type) {
        case "ping":
          toBridge?.onMessage(JSON.stringify({ type: "pong" }));
          return;
        case "createTab": {
          const tid = await createInContext(String(msg.url ?? "about:blank"));
          const tabId = nextTab++;
          byTab.set(tabId, tid);
          createdAt.set(tabId, Date.now());
          const gid = typeof msg.groupId === "number" ? msg.groupId : nextGroup++;
          group.set(tabId, gid);
          reply(seq, { tabId, groupId: gid, targetId: tid });
          // The chat now has a real tab, so the blank new-tab of a window we opened can go; the window
          // then lives exactly as long as the chat's tabs. The attach is safe from the resulting
          // targetDestroyed resync (created-tab grace here, attaching guard in the bridge).
          for (const stray of strays.splice(0)) void pipe.send("Target.closeTarget", { targetId: stray }).catch(() => {});
          return; // the reply conveys the new tab; a tabs push here would race the bridge's attach
        }
        case "groupTab": {
          const tabId = msg.tabId as number;
          if (!byTab.has(tabId)) return fail(seq, `no tab ${tabId}`);
          const gid = typeof msg.groupId === "number" ? msg.groupId : nextGroup++;
          group.set(tabId, gid);
          const tid = byTab.get(tabId) as string;
          reply(seq, { groupId: gid, tab: { tabId, url: "", title: "", active: false, groupId: gid, targetId: tid } });
          pushTabs();
          return;
        }
        case "ungroupTab":
          group.delete(msg.tabId as number);
          reply(seq, {});
          pushTabs();
          return;
        case "closeGroup": {
          const gid = msg.groupId as number;
          for (const [tabId, g] of [...group]) {
            if (g !== gid) continue;
            const tid = byTab.get(tabId);
            if (tid) await pipe.send("Target.closeTarget", { targetId: tid }).catch(() => {});
            byTab.delete(tabId);
            group.delete(tabId);
          }
          reply(seq, {});
          pushTabs();
          return;
        }
        case "closeTab": {
          const tid = targetId(msg.tabId as number);
          if (tid) await pipe.send("Target.closeTarget", { targetId: tid }).catch(() => {});
          byTab.delete(msg.tabId as number);
          group.delete(msg.tabId as number);
          reply(seq, {});
          pushTabs();
          return;
        }
        case "activateTab": {
          const tid = targetId(msg.tabId as number);
          if (tid) await pipe.send("Target.activateTarget", { targetId: tid }).catch(() => {});
          reply(seq, {});
          return;
        }
        case "listAllTabs":
          reply(seq, { tabs: await tabs() });
          return;
        case "reloadExtension":
          reply(seq, {});
          return;
        default:
          // attach/detach/cdp go to the pipe CdpExecBackend, not here; anything else is a no-op.
          if (typeof seq === "number") fail(seq, `pipe driver does not handle ${msg.type}`);
      }
    } catch (err) {
      if (typeof seq === "number") fail(seq, err instanceof Error ? err.message : String(err));
    }
  }

  // Hand the bridge a synthetic extension connection and complete the hello handshake.
  toBridge = bridge.attachExtensionSocket(socket);
  const ready = tabs()
    .then((t) =>
      toBridge?.onMessage(JSON.stringify({ type: "hello", email, userAgent: `pipe/${browserVersion}`, browserVersion, extensionVersion: "pipe", tabs: t })),
    )
    .catch((err) => log.warn(`${email}: hello failed: ${String(err)}`));

  return {
    get contextId() {
      return contextId; // reflects a reresolve rebind so the daemon compares against the live context
    },
    ready,
    onTargetEvent: (e) => {
      const ctx = (e.params.targetInfo as { browserContextId?: string } | undefined)?.browserContextId;
      // targetDestroyed carries only targetId; refresh on anything that could change this context's tabs.
      if (e.method === "Target.targetDestroyed" || ctx === contextId) pushTabs();
    },
    dispose: () => toBridge?.onClose(),
  };
}
