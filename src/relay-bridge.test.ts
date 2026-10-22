import { describe, expect, it } from "vitest";
import { ExtensionRelayBridge, isSignedIn, type BridgeOptions, type BridgeSocket } from "./relay-bridge.ts";
import type { ExtensionToRelayMessage, RelayTabInfo, RelayToExtensionMessage } from "./relay-protocol.ts";

type Frame = Record<string, unknown>;

class FakeSocket implements BridgeSocket {
  readonly sent: Frame[] = [];
  closed = false;
  closeCode?: number;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  byId(id: number): Frame | undefined {
    return this.sent.find((frame) => frame.id === id);
  }
  events(method: string): Frame[] {
    return this.sent.filter((frame) => frame.method === method);
  }
}

/** A scripted extension holding real tab and group state, so ownership flows end to end. */
function fakeExtension(bridge: ExtensionRelayBridge, tabs: RelayTabInfo[] = []) {
  const socket = new FakeSocket();
  const handlers = bridge.attachExtensionSocket(socket);
  const state = new Map<number, RelayTabInfo>(tabs.map((tab) => [tab.tabId, { ...tab }]));
  let nextTab = 100;
  let nextGroup = 10;
  const send = socket.send.bind(socket);
  socket.send = (data: string) => {
    send(data);
    const msg = JSON.parse(data) as RelayToExtensionMessage;
    if (msg.type === "ping") return;
    queueMicrotask(() => {
      const reply = replyFor(msg);
      if (reply) handlers.onMessage(JSON.stringify(reply));
    });
  };
  const replyFor = (msg: Exclude<RelayToExtensionMessage, { type: "ping" }>): ExtensionToRelayMessage => {
    const ok = (result: unknown): ExtensionToRelayMessage => ({ type: "result", seq: msg.seq, result });
    switch (msg.type) {
      case "attach":
        return ok({ targetId: `target-${msg.tabId}` });
      case "cdp":
        return ok({ ok: true, echoed: msg.method });
      case "createTab": {
        const groupId = msg.groupId ?? nextGroup++;
        const tab = { tabId: nextTab++, url: msg.url, title: "", active: false, groupId };
        state.set(tab.tabId, tab);
        return ok({ tabId: tab.tabId, groupId });
      }
      case "groupTab": {
        const tab = state.get(msg.tabId);
        if (!tab) return { type: "error", seq: msg.seq, message: "no such tab" };
        tab.groupId = msg.groupId ?? nextGroup++;
        return ok({ groupId: tab.groupId, tab: { ...tab } });
      }
      case "ungroupTab": {
        const tab = state.get(msg.tabId);
        if (tab) tab.groupId = -1;
        return ok({});
      }
      case "listAllTabs":
        return ok({ tabs: [...state.values()] });
      default:
        return ok({});
    }
  };
  const hello = () =>
    handlers.onMessage(
      JSON.stringify({
        type: "hello",
        email: "you@example.com",
        userAgent: "Mozilla/5.0 Chrome/155.0.0.0",
        browserVersion: "Chrome/155.0.8059.85",
        extensionVersion: "0.1.0",
        tabs: [...state.values()].filter((tab) => tab.groupId >= 0),
      }),
    );
  const pushTabs = (next: RelayTabInfo[]) => handlers.onMessage(JSON.stringify({ type: "tabs", tabs: next }));
  const commands = (type: string) => socket.sent.filter((frame) => frame.type === type);
  return { socket, handlers, state, hello, pushTabs, commands };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function connect(bridge: ExtensionRelayBridge, key?: string) {
  const socket = new FakeSocket();
  const cdp = bridge.attachCdpClientSocket(socket, key ? { key } : {});
  let id = 1;
  const send = async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    const requestId = id++;
    cdp.onMessage(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    await flush();
    return socket.byId(requestId);
  };
  return { socket, cdp, send };
}

function setup(opts: BridgeOptions = {}, tabs: RelayTabInfo[] = []) {
  const bridge = new ExtensionRelayBridge(opts);
  const ext = fakeExtension(bridge, tabs);
  ext.hello();
  return { bridge, ext };
}

describe("ExtensionRelayBridge", () => {
  it("reports the profile's browser through Browser.getVersion", async () => {
    const { bridge } = setup();
    const a = connect(bridge, "Chat_A");
    expect((await a.send("Browser.getVersion"))?.result).toMatchObject({ protocolVersion: "1.3", product: "Chrome/155.0.8059.85" });
    expect(bridge.identity?.email).toBe("you@example.com");
  });

  it("opens a new tab in the chat's own group, titled with its name", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    const created = await a.send("Target.createTarget", { url: "https://a.test" });
    expect(created?.result).toMatchObject({ targetId: "target-100" });
    expect(ext.commands("createTab")[0]).toMatchObject({ url: "https://a.test", title: "Chat_A" });
    expect(a.socket.events("Target.attachedToTarget")).toHaveLength(1);

    await a.send("Target.createTarget", { url: "https://a2.test" });
    expect(ext.commands("createTab")[1]).toMatchObject({ groupId: 10 });
  });

  it("keeps two chats on one profile apart", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    const b = connect(bridge, "Chat_B");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await b.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    await b.send("Target.createTarget", { url: "https://b.test" });
    expect(ext.commands("createTab").map((c) => c.color)).toEqual(["blue", "red"]);

    const aSession = (a.socket.events("Target.attachedToTarget")[0].params as { sessionId: string }).sessionId;
    expect(b.socket.events("Target.attachedToTarget")).toHaveLength(1);
    expect(((await a.send("Target.getTargets"))?.result as { targetInfos: unknown[] }).targetInfos).toHaveLength(1);

    const stolen = await b.send("Page.navigate", { url: "https://evil.test" }, aSession);
    expect(stolen?.error).toMatchObject({ code: -32001 });
    expect(ext.commands("cdp")).toHaveLength(0);
    expect((await b.send("Target.attachToTarget", { targetId: "target-100" }))?.error).toBeTruthy();

    ext.handlers.onMessage(JSON.stringify({ type: "cdpEvent", tabId: 100, method: "Page.loadEventFired", params: {} }));
    await flush();
    expect(a.socket.events("Page.loadEventFired")).toHaveLength(1);
    expect(b.socket.events("Page.loadEventFired")).toHaveLength(0);
  });

  it("routes a chat's session commands to its tab", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    const session = (a.socket.events("Target.attachedToTarget")[0].params as { sessionId: string }).sessionId;
    const reply = await a.send("Page.navigate", { url: "https://x.test" }, session);
    expect(ext.commands("cdp")[0]).toMatchObject({ tabId: 100, method: "Page.navigate" });
    expect(reply?.result).toMatchObject({ ok: true });
  });

  it("multiplexes Playwright page sessions over one attachment", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    const browserSession = ((await a.send("Target.attachToBrowserTarget"))?.result as { sessionId: string }).sessionId;
    const pageSession = (
      (await a.send("Target.attachToTarget", { targetId: "target-100", flatten: true }, browserSession))?.result as { sessionId: string }
    ).sessionId;
    expect(pageSession).not.toBe(browserSession);
    expect((await a.send("Runtime.evaluate", {}, pageSession))?.result).toMatchObject({ ok: true });
    expect(ext.commands("cdp").at(-1)).toMatchObject({ tabId: 100, method: "Runtime.evaluate" });

    ext.handlers.onMessage(JSON.stringify({ type: "cdpEvent", tabId: 100, method: "Runtime.consoleAPICalled", params: { type: "log" } }));
    await flush();
    expect(a.socket.sent.find((f) => f.sessionId === pageSession && f.method === "Runtime.consoleAPICalled")).toBeTruthy();

    const b = connect(bridge, "Chat_B");
    expect((await b.send("Target.detachFromTarget", { sessionId: pageSession }))?.error).toMatchObject({ code: -32001 });
    expect((await a.send("Target.detachFromTarget", { sessionId: pageSession }, browserSession))?.result).toEqual({});
  });

  it("gives a reconnecting chat its tabs back and detaches them meanwhile", async () => {
    const { bridge, ext } = setup({ endedGroupTtlMs: 10_000 });
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    a.cdp.onClose();
    await flush();
    expect(ext.commands("detach")).toHaveLength(1);
    expect(bridge.status().chats[0]).toMatchObject({ key: "Chat_A", connected: false, closing: true });

    const again = connect(bridge, "Chat_A");
    await again.send("Target.setAutoAttach", { autoAttach: true });
    const announced = again.socket.events("Target.attachedToTarget");
    expect(announced).toHaveLength(1);
    expect((announced[0].params as { targetInfo: { targetId: string } }).targetInfo.targetId).toBe("target-100");
    expect(bridge.status().chats[0]).toMatchObject({ connected: true, closing: false });
  });

  it("closes an ended chat's tabs after the grace period", async () => {
    const { bridge, ext } = setup({ endedGroupTtlMs: 20 });
    const a = connect(bridge, "Chat_A");
    await a.send("Target.createTarget", { url: "https://a.test" });
    a.cdp.onClose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ext.commands("closeGroup")[0]).toMatchObject({ groupId: 10 });
    expect(bridge.status().chats).toHaveLength(0);
  });

  it("lets the newer connection of one chat replace the older", async () => {
    const { bridge } = setup();
    const first = connect(bridge, "Chat_A");
    const second = connect(bridge, "Chat_A");
    expect(first.socket.closeCode).toBe(4000);
    expect(bridge.cdpClientCount).toBe(1);
    expect((await second.send("Browser.getVersion"))?.result).toBeTruthy();
  });

  it("moves a tab between chats with Bridge.adoptTab", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    const b = connect(bridge, "Chat_B");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await b.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    await b.send("Target.createTarget", { url: "https://b.test" });

    const adopted = await b.send("Bridge.adoptTab", { tabId: 100 });
    expect(adopted?.result).toMatchObject({ groupId: 11 });
    await flush();
    expect(a.socket.events("Target.detachedFromTarget")).toHaveLength(1);
    const bTargets = b.socket.events("Target.attachedToTarget").map((f) => (f.params as { targetInfo: { targetId: string } }).targetInfo.targetId);
    expect(bTargets).toContain("target-100");
    expect(ext.commands("detach").length).toBeGreaterThanOrEqual(1);
  });

  it("adopts one of your own tabs listed by Bridge.listAllTabs", async () => {
    const own = { tabId: 7, url: "https://mail.google.com", title: "Inbox", active: true, groupId: -1 };
    const { bridge } = setup({}, [own]);
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    const all = (await a.send("Bridge.listAllTabs"))?.result as { tabs: RelayTabInfo[] };
    expect(all.tabs.map((t) => t.tabId)).toEqual([7]);
    expect(a.socket.events("Target.attachedToTarget")).toHaveLength(0);
    await a.send("Bridge.adoptTab", { tabId: 7 });
    await flush();
    expect(a.socket.events("Target.attachedToTarget")).toHaveLength(1);
    expect((await a.send("Bridge.releaseTab", { tabId: 7 }))?.result).toEqual({});
    expect(a.socket.events("Target.detachedFromTarget")).toHaveLength(1);
  });

  it("announces a popup in the opener's group with its openerId", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    ext.pushTabs([
      { tabId: 100, url: "https://a.test", title: "A", active: true, groupId: 10 },
      { tabId: 101, url: "https://a.test/popup", title: "Popup", active: false, groupId: 10, openerTabId: 100 },
    ]);
    await flush();
    const popup = a.socket.events("Target.attachedToTarget").at(-1)?.params as { targetInfo: { targetId: string; openerId?: string } };
    expect(popup.targetInfo).toMatchObject({ targetId: "target-101", openerId: "target-100" });
  });

  it("detaches a tab dragged out of the chat's group", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    ext.pushTabs([]);
    await flush();
    expect(a.socket.events("Target.detachedFromTarget")).toHaveLength(1);
    expect(bridge.knownTabs()).toHaveLength(0);
  });

  it("asks for the profile to be opened and serves the chat once Chrome connects", async () => {
    let asked = 0;
    const bridge = new ExtensionRelayBridge({ onNeedExtension: () => asked++, extensionWaitMs: 1000 });
    const a = connect(bridge, "Chat_A");
    a.cdp.onMessage(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await flush();
    expect(asked).toBe(1);
    expect(a.socket.byId(1)).toBeUndefined();
    fakeExtension(bridge).hello();
    await flush();
    expect(a.socket.byId(1)?.result).toMatchObject({ product: "Chrome/155.0.8059.85" });
  });

  it("fails a waiting chat with a clear message when Chrome never connects", async () => {
    const bridge = new ExtensionRelayBridge({ name: "pw-example", extensionWaitMs: 20 });
    const a = connect(bridge, "Chat_A");
    a.cdp.onMessage(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((a.socket.byId(1)?.error as { message: string }).message).toMatch(/pw-example: Chrome did not connect/);
  });

  it("rejects isolated browser contexts", async () => {
    const { bridge } = setup();
    expect((await connect(bridge, "Chat_A").send("Target.createBrowserContext"))?.error).toBeTruthy();
  });

  it("fails commands cleanly once the extension disconnects", async () => {
    const { bridge, ext } = setup({ extensionWaitMs: 20 });
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    const session = (a.socket.events("Target.attachedToTarget")[0].params as { sessionId: string }).sessionId;
    ext.handlers.onClose();
    expect(a.socket.events("Target.detachedFromTarget")).toHaveLength(1);
    a.cdp.onMessage(JSON.stringify({ id: 99, sessionId: session, method: "Page.reload" }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(a.socket.byId(99)?.error).toBeTruthy();
    expect(bridge.extensionConnected).toBe(false);
  });

  it("reaps child sessions when their tab leaves (no stale routing)", async () => {
    const { bridge, ext } = setup();
    const a = connect(bridge, "Chat_A");
    await a.send("Target.setAutoAttach", { autoAttach: true });
    await a.send("Target.createTarget", { url: "https://a.test" });
    ext.handlers.onMessage(JSON.stringify({ type: "cdpEvent", tabId: 100, sessionId: "child-abc", method: "Page.frameNavigated", params: {} }));
    ext.pushTabs([]);
    await flush();
    expect((await a.send("Page.reload", {}, "child-abc"))?.error).toBeTruthy();
  });

  it("requires a hello frame before other extension messages", () => {
    const bridge = new ExtensionRelayBridge();
    const socket = new FakeSocket();
    bridge.attachExtensionSocket(socket).onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    expect(socket.closed).toBe(true);
    expect(bridge.extensionConnected).toBe(false);
  });
});

describe("isSignedIn", () => {
  it("is true for a real account, false for the no-account placeholder", () => {
    expect(isSignedIn("you@example.com")).toBe(true);
    expect(isSignedIn("pw-test@profile.local")).toBe(false);
    expect(isSignedIn("")).toBe(false);
    expect(isSignedIn(null)).toBe(false);
  });
});
