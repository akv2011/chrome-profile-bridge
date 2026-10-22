// Claude Browser Bridge service worker: a thin transport between the local daemon and
// chrome.debugger. CDP target synthesis lives in the daemon; this worker attaches tabs, forwards
// frames, keeps one tab group per chat, and stays connected.
//
// Adapted from OpenClaw's extension (MIT, third_party/OPENCLAW-LICENSE).
import {
  CLOSE_UNKNOWN_PROFILE,
  DAEMON_URL,
  NO_GROUP,
  browserVersionFrom,
  reconnectDelayMs,
  toRelayTabInfo,
} from "./modules/relay-core.js";

const BADGE = {
  off: { text: "", color: "#000000" },
  connecting: { text: "…", color: "#F59E0B" },
  on: { text: "ON", color: "#0F9D58" },
  error: { text: "!", color: "#B91C1C" },
};

/** @type {WebSocket|null} */
let ws = null;
let state = "off";
let lastClose = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let syncTimer = null;
const attachedTabs = new Set();
const attachingTabs = new Map();

// Which tab groups belong to Claude chats, and which popup-window tabs (which Chrome cannot group)
// belong to which group. Session storage survives a service-worker restart and ends with the
// browser session, exactly as long as Chrome's group ids stay valid.
const ownership = { groups: new Set(), popups: new Map() };
const ready = chrome.storage.session.get(["claudeGroups", "popupOwners"]).then((saved) => {
  for (const id of saved.claudeGroups ?? []) ownership.groups.add(id);
  for (const [tabId, groupId] of Object.entries(saved.popupOwners ?? {})) ownership.popups.set(Number(tabId), groupId);
});

function saveOwnership() {
  return chrome.storage.session.set({
    claudeGroups: [...ownership.groups],
    popupOwners: Object.fromEntries(ownership.popups),
  });
}

function setBadge(kind) {
  state = kind;
  const cfg = BADGE[kind] ?? BADGE.off;
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Ownership: a tab belongs to a chat while it sits in that chat's Claude group
// ---------------------------------------------------------------------------

function groupOf(tab) {
  if (ownership.groups.has(tab.groupId)) return tab.groupId;
  const popupGroup = ownership.popups.get(tab.id);
  return popupGroup !== undefined && ownership.groups.has(popupGroup) ? popupGroup : NO_GROUP;
}

/** tabId -> CDP targetId for page tabs, so the daemon can drive them over the trusted pipe. */
async function targetIds() {
  try {
    const map = new Map();
    for (const t of await chrome.debugger.getTargets()) {
      if (typeof t.tabId === "number" && t.type === "page") map.set(t.tabId, t.id);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function claudeTabs() {
  await ready;
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => typeof tab.id === "number" && groupOf(tab) !== NO_GROUP);
}

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncTabs();
  }, 150);
}

async function syncTabs() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = await claudeTabs();
  const ids = new Set(tabs.map((tab) => tab.id));
  // Extension-only mode: a tab dragged out of its chat's group leaves the agent at once. In pipe
  // mode the extension never attaches, so attachedTabs is empty and this is a no-op.
  for (const tabId of attachedTabs) if (!ids.has(tabId)) void detachDebugger(tabId);
  const tmap = await targetIds();
  send({ type: "tabs", tabs: tabs.map((tab) => toRelayTabInfo(tab, groupOf(tab), tmap.get(tab.id))) });
}

/** A tab to open a chat's page in: its group's window, else the last focused normal window. */
async function openTab(url, windowId) {
  if (windowId !== undefined) return await chrome.tabs.create({ windowId, url, active: false });
  const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (last?.id !== undefined) return await chrome.tabs.create({ windowId: last.id, url, active: false });
  // The profile was opened with no window (--no-startup-window): give the chat a window of its
  // own without pulling it in front of your work.
  const win = await chrome.windows.create({ url, focused: false });
  return win.tabs[0];
}

/** The chat's group if it still exists, else null. */
async function liveGroup(groupId) {
  if (groupId === undefined || !ownership.groups.has(groupId)) return null;
  return await chrome.tabGroups.get(groupId).catch(() => null);
}

async function newGroup(tabId, windowId, title, color) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, color });
  ownership.groups.add(groupId);
  await saveOwnership();
  return groupId;
}

async function createTab({ url, groupId, title, color }) {
  await ready;
  const group = await liveGroup(groupId);
  const tab = await openTab(url, group?.windowId);
  const owner = group
    ? await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id })
    : await newGroup(tab.id, tab.windowId, title, color);
  scheduleSync();
  return { tabId: tab.id, groupId: owner };
}

async function groupTab({ tabId, groupId, title, color }) {
  await ready;
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const group = await liveGroup(groupId);
  let owner;
  if (win.type !== "normal") {
    // Popup windows cannot hold tab groups; record the claim instead.
    if (!group) throw new Error(`tab ${tabId} is in a popup window; open a page first so the chat has a group`);
    ownership.popups.set(tabId, group.id);
    await saveOwnership();
    owner = group.id;
  } else if (group) {
    if (group.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    owner = await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
  } else {
    owner = await newGroup(tabId, tab.windowId, title, color);
  }
  scheduleSync();
  return { groupId: owner, tab: toRelayTabInfo(await chrome.tabs.get(tabId), owner) };
}

async function ungroupTab(tabId) {
  await detachDebugger(tabId);
  if (ownership.popups.delete(tabId)) await saveOwnership();
  else await chrome.tabs.ungroup([tabId]).catch(() => {});
  scheduleSync();
}

async function closeGroup(groupId) {
  await ready;
  const tabs = (await chrome.tabs.query({})).filter((tab) => groupOf(tab) === groupId);
  for (const tab of tabs) await detachDebugger(tab.id);
  if (tabs.length) await chrome.tabs.remove(tabs.map((tab) => tab.id)).catch(() => {});
  ownership.groups.delete(groupId);
  for (const [tabId, owner] of ownership.popups) if (owner === groupId) ownership.popups.delete(tabId);
  await saveOwnership();
  scheduleSync();
}

// A page's popup (window.open, target=_blank, a middle-click) joins its opener's chat.
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (typeof tab.openerTabId !== "number" || typeof tab.id !== "number") return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  const owner = opener ? groupOf(opener) : NO_GROUP;
  if (owner === NO_GROUP) return;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: owner });
  } catch {
    ownership.popups.set(tab.id, owner);
    await saveOwnership();
  }
  scheduleSync();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attachedTabs.delete(tabId);
  await ready;
  if (ownership.popups.delete(tabId)) await saveOwnership();
  scheduleSync();
});
chrome.tabs.onUpdated.addListener(() => scheduleSync());
chrome.tabGroups.onUpdated.addListener(() => scheduleSync());
chrome.tabGroups.onRemoved.addListener(async (group) => {
  await ready;
  if (ownership.groups.delete(group.id)) await saveOwnership();
  scheduleSync();
});

// ---------------------------------------------------------------------------
// chrome.debugger transport
// ---------------------------------------------------------------------------

async function attachDebugger(tabId) {
  await ready;
  const tab = await chrome.tabs.get(tabId);
  if (groupOf(tab) === NO_GROUP) throw new Error(`tab ${tabId} is not in a Claude tab group`);
  // Coalesce concurrent attaches: a second chrome.debugger.attach throws "Another debugger is
  // already attached", and the daemon and this worker can disagree after a worker restart.
  const inFlight = attachingTabs.get(tabId);
  if (inFlight) return await inFlight;
  const attach = (async () => {
    if (!attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        if (!String(err?.message ?? err).includes("Another debugger is already attached")) throw err;
      }
      attachedTabs.add(tabId);
    }
    const targets = await chrome.debugger.getTargets();
    const target = targets.find((candidate) => candidate.tabId === tabId && candidate.attached);
    return { targetId: target?.id ?? `tab-${tabId}` };
  })();
  attachingTabs.set(tabId, attach);
  try {
    return await attach;
  } finally {
    attachingTabs.delete(tabId);
  }
}

async function detachDebugger(tabId) {
  attachedTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  send({ type: "cdpEvent", tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}), method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") return;
  attachedTabs.delete(source.tabId);
  send({ type: "detached", tabId: source.tabId, reason });
  // "Cancel" on Chrome's debugging infobar revokes the tab: take it out of the chat's group so
  // the agent does not re-attach at once.
  if (reason === "canceled_by_user") void ungroupTab(source.tabId);
});

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

async function handle(msg) {
  if (msg.type === "ping") return send({ type: "pong" });
  const { seq } = msg;
  try {
    let result = {};
    switch (msg.type) {
      case "attach":
        result = await attachDebugger(msg.tabId);
        break;
      case "detach":
        await detachDebugger(msg.tabId);
        break;
      case "cdp": {
        const target = msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId };
        result = (await chrome.debugger.sendCommand(target, msg.method, msg.params ?? {})) ?? {};
        break;
      }
      case "createTab":
        result = await createTab(msg);
        break;
      case "groupTab":
        result = await groupTab(msg);
        break;
      case "ungroupTab":
        await ungroupTab(msg.tabId);
        break;
      case "closeGroup":
        await closeGroup(msg.groupId);
        break;
      case "closeTab":
        await detachDebugger(msg.tabId);
        await chrome.tabs.remove(msg.tabId);
        break;
      case "activateTab": {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        break;
      }
      case "listAllTabs": {
        await ready;
        const tabs = await chrome.tabs.query({});
        const tmap = await targetIds();
        result = { tabs: tabs.filter((tab) => typeof tab.id === "number").map((tab) => toRelayTabInfo(tab, groupOf(tab), tmap.get(tab.id))) };
        break;
      }
      case "reloadExtension":
        send({ type: "result", seq, result: {} });
        // Unpacked: a reload runs the files now on disk. The daemon asks only while no chat is connected.
        setTimeout(() => chrome.runtime.reload(), 100);
        return;
      default:
        throw new Error(`unknown command: ${msg.type}`);
    }
    send({ type: "result", seq, result });
  } catch (err) {
    if (typeof seq === "number") send({ type: "error", seq, message: err instanceof Error ? err.message : String(err) });
  }
}

async function sendHello() {
  const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
  const tabs = await claudeTabs();
  const tmap = await targetIds();
  send({
    type: "hello",
    email: email ?? "",
    userAgent: navigator.userAgent,
    browserVersion: browserVersionFrom(navigator.userAgent),
    extensionVersion: chrome.runtime.getManifest().version,
    tabs: tabs.map((tab) => toRelayTabInfo(tab, groupOf(tab), tmap.get(tab.id))),
  });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setBadge("connecting");
  let socket;
  try {
    socket = new WebSocket(DAEMON_URL);
  } catch {
    setBadge("error");
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    lastClose = null;
    setBadge("on");
    void sendHello();
  });
  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    void handle(msg);
  });
  socket.addEventListener("close", (event) => {
    if (ws !== socket) return;
    ws = null;
    lastClose = { code: event.code, reason: event.reason, at: Date.now() };
    setBadge(event.code === CLOSE_UNKNOWN_PROFILE ? "error" : "connecting");
    scheduleReconnect(event.code === CLOSE_UNKNOWN_PROFILE ? 60_000 : undefined);
  });
}

function scheduleReconnect(delay) {
  if (reconnectTimer) return;
  const wait = delay ?? reconnectDelayMs(reconnectAttempt++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "getStatus") return false;
  void (async () => {
    const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    const tabs = await claudeTabs();
    sendResponse({
      state,
      email: email ?? "",
      version: chrome.runtime.getManifest().version,
      chats: new Set(tabs.map(groupOf)).size,
      tabs: tabs.length,
      attached: attachedTabs.size,
      lastClose,
    });
  })();
  return true;
});

// The daemon's 20 s pings keep this worker alive; the alarm revives it if Chrome stopped it anyway.
chrome.alarms.create("bridge-watchdog", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-watchdog") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
