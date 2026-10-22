// Pure helpers for the extension. No chrome.* here, so vitest can run them directly.

/** The daemon on this Mac. Fixed port, no pairing: the daemon trusts this extension's origin. */
export const DAEMON_URL = "ws://127.0.0.1:18765/ext";

/** Chrome's "no group" id (chrome.tabGroups.TAB_GROUP_ID_NONE). */
export const NO_GROUP = -1;

/** Daemon close code for a profile that is not signed in to Chrome with any email. */
export const CLOSE_UNKNOWN_PROFILE = 4004;

/** Reconnect quickly (the daemon restarts in about a second): 0.5 s doubling, capped at 5 s. */
export function reconnectDelayMs(attempt) {
  return Math.min(500 * 2 ** Math.min(Math.max(0, attempt), 4), 5_000);
}

/** "Chrome/155.0.8059.85" out of a user agent string. */
export function browserVersionFrom(userAgent) {
  const match = /Chrom(?:e|ium)\/[\d.]+/.exec(String(userAgent ?? ""));
  return match ? match[0] : "Chrome/unknown";
}

/** A chrome.tabs.Tab as the daemon sees it; groupId is the owning Claude group (or NO_GROUP). */
export function toRelayTabInfo(tab, groupId, targetId) {
  return {
    tabId: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active === true,
    groupId,
    ...(typeof tab.openerTabId === "number" ? { openerTabId: tab.openerTabId } : {}),
    ...(targetId ? { targetId } : {}),
  };
}
