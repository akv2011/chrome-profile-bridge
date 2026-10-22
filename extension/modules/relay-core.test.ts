import { describe, expect, it } from "vitest";
import { browserVersionFrom, reconnectDelayMs, toRelayTabInfo } from "./relay-core.js";

describe("reconnectDelayMs", () => {
  it("retries fast and caps at 5 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelayMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("browserVersionFrom", () => {
  it("pulls the Chrome product string out of a user agent", () => {
    expect(browserVersionFrom("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/155.0.8059.85 Safari/537.36")).toBe("Chrome/155.0.8059.85");
    expect(browserVersionFrom("")).toBe("Chrome/unknown");
  });
});

describe("toRelayTabInfo", () => {
  it("carries the owning group and the opener", () => {
    expect(toRelayTabInfo({ id: 5, url: "https://a.test", title: "A", active: true, openerTabId: 3 }, 12)).toEqual({
      tabId: 5,
      url: "https://a.test",
      title: "A",
      active: true,
      groupId: 12,
      openerTabId: 3,
    });
  });

  it("falls back to the pending url while a tab is still loading", () => {
    expect(toRelayTabInfo({ id: 6, pendingUrl: "https://b.test" }, -1)).toMatchObject({ url: "https://b.test", title: "", active: false });
  });
});
