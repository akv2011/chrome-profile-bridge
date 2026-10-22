/**
 * Wire protocol between the daemon and the extension. The extension stays a thin transport: it
 * attaches chrome.debugger, forwards CDP traffic and manages the Claude tab group. All CDP target
 * semantics (Target.* synthesis for Playwright) live in the bridge.
 */

/** Tab snapshot reported by the extension (Claude group tabs, or every tab for listAllTabs). */
export type RelayTabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  /** Chrome tab group id; -1 when ungrouped. Ownership follows the group. */
  groupId: number;
  /** Set for a tab a page opened (window.open, target=_blank); it joins the opener's group. */
  openerTabId?: number;
  /** The tab's CDP targetId, so the trusted pipe can drive it. The extension reads it without attaching. */
  targetId?: string;
};

/** Chrome's tab group colors. */
export const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** First message the extension sends after the WebSocket opens. */
type ExtensionHelloMessage = {
  type: "hello";
  /** chrome.identity.getProfileUserInfo email; the daemon maps it to the pw-* profile name. */
  email: string;
  userAgent: string;
  /** Full browser product string, e.g. "Chrome/144.0.7204.49". */
  browserVersion: string;
  extensionVersion: string;
  tabs: RelayTabInfo[];
};

/** Full refresh of the tabs in Claude groups; sent on any group membership or tab change. */
type ExtensionTabsMessage = {
  type: "tabs";
  tabs: RelayTabInfo[];
};

/** CDP event emitted by an attached tab (child sessions carry sessionId). */
type ExtensionCdpEventMessage = {
  type: "cdpEvent";
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
};

/** Successful response to a relay command (cdp/attach/createTab/...). */
type ExtensionResultMessage = {
  type: "result";
  seq: number;
  result?: unknown;
};

/** Failed response to a relay command. */
type ExtensionErrorMessage = {
  type: "error";
  seq: number;
  message: string;
};

/** chrome.debugger detached outside relay control (infobar cancel, tab gone). */
type ExtensionDetachedMessage = {
  type: "detached";
  tabId: number;
  reason: string;
};

/** Keepalive reply; message traffic keeps the MV3 service worker alive. */
type ExtensionPongMessage = {
  type: "pong";
};

export type ExtensionToRelayMessage =
  | ExtensionHelloMessage
  | ExtensionTabsMessage
  | ExtensionCdpEventMessage
  | ExtensionResultMessage
  | ExtensionErrorMessage
  | ExtensionDetachedMessage
  | ExtensionPongMessage;

/**
 * Command bodies sent to the extension. The bridge assigns the `seq` used to
 * correlate the extension's result/error reply.
 */
export type RelayCommandBody =
  /** Forward a CDP command into an attached tab (or one of its child sessions). */
  | { type: "cdp"; tabId: number; sessionId?: string; method: string; params?: unknown }
  /** Attach chrome.debugger to a tab in a Claude group. Result: { targetId: string }. */
  | { type: "attach"; tabId: number }
  /** Detach chrome.debugger from a tab. Result: {}. */
  | { type: "detach"; tabId: number }
  /**
   * Open a tab in a client's group: the existing group when groupId is set and still exists,
   * otherwise a new group with this title and color. Result: { tabId: number; groupId: number }.
   */
  | { type: "createTab"; url: string; groupId?: number; title: string; color: GroupColor }
  /** Move any tab into a client's group (same rule as createTab). Result: { groupId: number; tab: RelayTabInfo }. */
  | { type: "groupTab"; tabId: number; groupId?: number; title: string; color: GroupColor }
  /** Move a tab out of its group. Result: {}. */
  | { type: "ungroupTab"; tabId: number }
  /** Close every tab in a group (an ended chat's tabs). Result: {}. */
  | { type: "closeGroup"; groupId: number }
  /** Close one tab. Result: {}. */
  | { type: "closeTab"; tabId: number }
  /** Focus a tab (window + tab activation). Result: {}. */
  | { type: "activateTab"; tabId: number }
  /** Every tab in the profile, grouped or not. Result: { tabs: RelayTabInfo[] }. */
  | { type: "listAllTabs" }
  /** Reload the extension so it runs the files now on disk. Result: {}. */
  | { type: "reloadExtension" };

/** Keepalive probe; the extension answers with pong. */
type RelayPingMessage = {
  type: "ping";
};

export type RelayToExtensionMessage = (RelayCommandBody & { seq: number }) | RelayPingMessage;

/** Parse one extension frame; returns null for malformed input. */
export function parseExtensionMessage(raw: string): ExtensionToRelayMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }
  switch (type) {
    case "hello":
    case "tabs":
    case "cdpEvent":
    case "result":
    case "error":
    case "detached":
    case "pong":
      return parsed as ExtensionToRelayMessage;
    default:
      return null;
  }
}
