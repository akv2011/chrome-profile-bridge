/**
 * Test double for the Chrome extension: speaks the extension's wire protocol to the daemon and
 * implements chrome.debugger on top of a real headless Chromium's CDP (flat sessions), so the
 * daemon and bridge meet real Playwright and a real browser without Chrome's extension APIs.
 */
import { WebSocket } from "ws";
import type { RelayTabInfo, RelayToExtensionMessage } from "../relay-protocol.ts";

type Tab = { targetId: string; url: string; title: string; groupId: number; session?: string };

export async function startCdpExtension(opts: { daemonPort: number; origin: string; browserWs: string; email: string }) {
  const browser = new WebSocket(opts.browserWs, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => browser.once("open", resolve).once("error", reject));

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const cdp = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const tabs = new Map<number, Tab>();
  const rootSessions = new Map<string, number>();
  const childSessions = new Map<string, number>();
  let nextTab = 1;
  let nextGroup = 1;

  const ext = new WebSocket(`ws://127.0.0.1:${opts.daemonPort}/ext`, { origin: opts.origin });
  const toDaemon = (msg: unknown) => ext.readyState === ext.OPEN && ext.send(JSON.stringify(msg));
  const grouped = (): RelayTabInfo[] =>
    [...tabs]
      .filter(([, t]) => t.groupId >= 0)
      .map(([tabId, t]) => ({ tabId, url: t.url, title: t.title, active: false, groupId: t.groupId, targetId: t.targetId }));

  browser.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; sessionId?: string; method?: string; params?: { sessionId?: string } };
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(msg.error.message));
      else waiter?.resolve(msg.result);
      return;
    }
    if (!msg.sessionId) return;
    const root = rootSessions.get(msg.sessionId);
    const child = childSessions.get(msg.sessionId);
    const tabId = root ?? child;
    if (tabId === undefined) return;
    if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId) childSessions.set(msg.params.sessionId, tabId);
    toDaemon({ type: "cdpEvent", tabId, ...(child !== undefined ? { sessionId: msg.sessionId } : {}), method: msg.method, params: msg.params });
  });

  const handle = async (msg: Exclude<RelayToExtensionMessage, { type: "ping" }>): Promise<unknown> => {
    switch (msg.type) {
      case "createTab": {
        const { targetId } = (await cdp("Target.createTarget", { url: msg.url })) as { targetId: string };
        const tabId = nextTab++;
        const groupId = msg.groupId ?? nextGroup++;
        tabs.set(tabId, { targetId, url: msg.url, title: "", groupId });
        toDaemon({ type: "tabs", tabs: grouped() });
        return { tabId, groupId };
      }
      case "attach": {
        const tab = tabs.get(msg.tabId);
        if (!tab) throw new Error(`no tab ${msg.tabId}`);
        const { sessionId } = (await cdp("Target.attachToTarget", { targetId: tab.targetId, flatten: true })) as { sessionId: string };
        tab.session = sessionId;
        rootSessions.set(sessionId, msg.tabId);
        return { targetId: tab.targetId };
      }
      case "detach": {
        const tab = tabs.get(msg.tabId);
        if (tab?.session) {
          rootSessions.delete(tab.session);
          await cdp("Target.detachFromTarget", { sessionId: tab.session }).catch(() => {});
          tab.session = undefined;
        }
        return {};
      }
      case "cdp": {
        const tab = tabs.get(msg.tabId);
        if (!tab?.session) throw new Error(`tab ${msg.tabId} is not attached`);
        return await cdp(msg.method, msg.params ?? {}, msg.sessionId ?? tab.session);
      }
      case "closeTab": {
        const tab = tabs.get(msg.tabId);
        if (tab) await cdp("Target.closeTarget", { targetId: tab.targetId });
        tabs.delete(msg.tabId);
        toDaemon({ type: "tabs", tabs: grouped() });
        return {};
      }
      case "closeGroup":
        for (const [tabId, tab] of tabs) {
          if (tab.groupId !== msg.groupId) continue;
          await cdp("Target.closeTarget", { targetId: tab.targetId });
          tabs.delete(tabId);
        }
        toDaemon({ type: "tabs", tabs: grouped() });
        return {};
      case "activateTab":
        return {};
      case "groupTab": {
        const tab = tabs.get(msg.tabId);
        if (!tab) throw new Error(`no tab ${msg.tabId}`);
        tab.groupId = msg.groupId ?? nextGroup++;
        return { groupId: tab.groupId, tab: { tabId: msg.tabId, url: tab.url, title: tab.title, active: false, groupId: tab.groupId } };
      }
      case "ungroupTab": {
        const tab = tabs.get(msg.tabId);
        if (tab) tab.groupId = -1;
        return {};
      }
      case "listAllTabs":
        return { tabs: [...tabs].map(([tabId, t]) => ({ tabId, url: t.url, title: t.title, active: false, groupId: t.groupId })) };
      case "reloadExtension":
        return {};
    }
  };

  ext.on("message", async (data) => {
    const msg = JSON.parse(String(data)) as RelayToExtensionMessage;
    if (msg.type === "ping") return toDaemon({ type: "pong" });
    try {
      toDaemon({ type: "result", seq: msg.seq, result: await handle(msg) });
    } catch (err) {
      toDaemon({ type: "error", seq: msg.seq, message: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise((resolve, reject) => ext.once("open", resolve).once("error", reject));
  toDaemon({ type: "hello", email: opts.email, userAgent: "headless", browserVersion: "Chrome/156.0.8078.4", extensionVersion: "0.1.0", tabs: [] });

  return {
    tabs,
    close: () => {
      ext.close();
      browser.close();
    },
  };
}
