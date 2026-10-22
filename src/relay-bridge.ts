/**
 * One profile's CDP bridge. Presents a CDP browser endpoint that Playwright's connectOverCDP
 * accepts on one side and the extension's chrome.debugger transport on the other. All Target.*
 * synthesis lives here so the extension stays a thin forwarder that is easy to keep alive.
 *
 * Many chats can drive one profile at once. Each CDP client has an owner (keyed by the chat's
 * name) that holds one Chrome tab group; a client sees and drives only the tabs in its group.
 *
 * Adapted from OpenClaw's extension relay (MIT, third_party/OPENCLAW-LICENSE).
 */
import crypto from "node:crypto";
import { createLogger } from "./log.ts";
import {
  type ExtensionToRelayMessage,
  GROUP_COLORS,
  type GroupColor,
  parseExtensionMessage,
  type RelayCommandBody,
  type RelayTabInfo,
  type RelayToExtensionMessage,
} from "./relay-protocol.ts";

const log = createLogger("bridge");

const EXTENSION_COMMAND_TIMEOUT_MS = 15_000;
/** Message traffic keeps the MV3 service worker alive; Chrome idles it after 30 s of silence. */
const EXTENSION_PING_INTERVAL_MS = 20_000;
/** How long a client's commands wait for a closed profile to open and its extension to connect. */
const EXTENSION_WAIT_MS = 20_000;
/** An ended chat's tabs close after this unless a client with the same key comes back. */
const ENDED_GROUP_TTL_MS = 10 * 60_000;

const BROWSER_TARGET_ID = "chrome-profile-bridge";
/** Playwright requires every attached page target to identify its browser context. */
const BROWSER_CONTEXT_ID = "chrome-profile-bridge-context";

/** Minimal socket seam so tests can drive the bridge without real WebSockets. */
export type BridgeSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type CdpRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type PendingExtensionCommand = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type TabState = {
  info: RelayTabInfo;
  /** Set while chrome.debugger is attached: real CDP targetId + synthetic root sessionId. */
  attached?: { targetId: string; sessionId: string };
  attaching?: Promise<{ targetId: string; sessionId: string }>;
};

/**
 * A chat's claim on one Chrome tab group. It outlives its socket by the ended-group TTL, so a
 * chat that reconnects under the same key gets its tabs, logins and page state back.
 */
type Owner = {
  key: string;
  title: string;
  color: GroupColor;
  /** Chrome tab group id, set by the client's first createTab or adoptTab. */
  groupId: number | null;
  client: CdpClientState | null;
  closeTimer: NodeJS.Timeout | null;
};

type CdpClientState = {
  socket: BridgeSocket;
  owner: Owner;
  autoAttach: boolean;
  /** Session ids this client has been told about (root and child sessions). */
  announcedSessions: Set<string>;
};

type AuxiliaryTabSession = {
  tabId: number;
  parentSessionId: string;
  client: CdpClientState;
};

/** Browser identity reported by the extension; email is the Chrome profile's signed-in account. */
type ExtensionIdentity = {
  email: string;
  userAgent: string;
  browserVersion: string;
  extensionVersion: string;
};

export type BridgeOptions = {
  /** Profile name for error messages, e.g. "pw-example". */
  name?: string;
  onStateChange?: () => void;
  /** A client is waiting and no extension is connected: open the profile's Chrome window. */
  onNeedExtension?: () => void;
  extensionWaitMs?: number;
  endedGroupTtlMs?: number;
};

/**
 * The trusted CDP execution path (the pipe). The bridge still owns tabs, groups and target
 * synthesis; this only runs the actual attach/detach/commands against the real browser.
 */
export type CdpExecBackend = {
  attach(tabId: number, targetId: string): Promise<void>;
  detach(tabId: number): Promise<void>;
  cdp(tabId: number, sessionId: string | undefined, method: string, params?: unknown): Promise<unknown>;
};

function toErrorPayload(id: number, sessionId: string | undefined, message: string, code = -32000) {
  return JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), error: { code, message } });
}

export class ExtensionRelayBridge {
  private extension: { socket: BridgeSocket; identity: ExtensionIdentity } | null = null;
  private readonly clients = new Set<CdpClientState>();
  private readonly owners = new Map<string, Owner>();
  private readonly tabs = new Map<number, TabState>();
  /** Browser-level sessions created by Playwright for page-scoped CDP access. */
  private readonly browserSessions = new Map<string, CdpClientState>();
  /** Extra root-page sessions multiplexed over one chrome.debugger attachment. */
  private readonly auxiliaryTabSessions = new Map<string, AuxiliaryTabSession>();
  /** Child debugger sessions (iframes/workers) mapped to their owning tab. */
  private readonly childSessions = new Map<string, number>();
  private readonly pendingExtension = new Map<number, PendingExtensionCommand>();
  private extensionWaiters: Array<() => void> = [];
  private nextSeq = 1;
  private nextSessionOrdinal = 1;
  private nextColor = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly opts: BridgeOptions;

  constructor(opts: BridgeOptions = {}) {
    this.opts = opts;
  }

  /** True once an extension socket completed its hello handshake. */
  get extensionConnected(): boolean {
    return this.extension !== null;
  }

  get identity(): ExtensionIdentity | null {
    return this.extension?.identity ?? null;
  }

  /** Tabs in Claude groups, as last reported by the extension. */
  knownTabs(): RelayTabInfo[] {
    return [...this.tabs.values()].map((tab) => tab.info);
  }

  get cdpClientCount(): number {
    return this.clients.size;
  }

  /** Reload the extension onto newer files from disk; the daemon calls this only while no chat is connected. */
  requestExtensionReload(): void {
    if (this.extension) void this.callExtension({ type: "reloadExtension" }, 5_000).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // CDP execution backend. Tab and group ops always go to the extension; the actual CDP
  // (attach/detach/command) goes to the pipe when one is wired, which is the fully trusted path.
  // ---------------------------------------------------------------------

  private cdpBackend: CdpExecBackend | null = null;

  /** Route attach/detach/CDP through the trusted pipe instead of the extension's chrome.debugger. */
  setCdpBackend(backend: CdpExecBackend): void {
    this.cdpBackend = backend;
  }

  /** The daemon calls this for every CDP event the pipe emits for one of this profile's tabs. */
  injectCdpEvent(tabId: number, childSessionId: string | undefined, method: string, params: unknown): void {
    this.forwardExtensionEvent(tabId, childSessionId, method, params);
  }

  /** Attach a tab for CDP. Pipe path uses the tab's real targetId; extension path uses chrome.debugger. */
  private async execAttach(tabId: number): Promise<{ targetId: string }> {
    if (this.cdpBackend) {
      const targetId = this.tabs.get(tabId)?.info.targetId;
      if (!targetId) throw new Error(`tab ${tabId} has no CDP targetId yet`);
      await this.cdpBackend.attach(tabId, targetId);
      return { targetId };
    }
    const result = (await this.callExtension({ type: "attach", tabId })) as { targetId?: unknown } | null;
    return { targetId: typeof result?.targetId === "string" ? result.targetId : `tab-${tabId}` };
  }

  private async execDetach(tabId: number): Promise<void> {
    if (this.cdpBackend) return void this.cdpBackend.detach(tabId).catch(() => {});
    if (this.extension) void this.callExtension({ type: "detach", tabId }).catch(() => {});
  }

  private execCdp(tabId: number, sessionId: string | undefined, method: string, params?: unknown): Promise<unknown> {
    if (this.cdpBackend) return this.cdpBackend.cdp(tabId, sessionId, method, params);
    return this.callExtension({ type: "cdp", tabId, ...(sessionId ? { sessionId } : {}), method, params });
  }

  /** Per-chat view for /status. */
  status() {
    return {
      extension: this.extension?.identity ?? null,
      chats: [...this.owners.values()].map((owner) => ({
        key: owner.key,
        connected: owner.client !== null,
        groupId: owner.groupId,
        tabs: [...this.tabs.values()].filter((tab) => owner.groupId !== null && tab.info.groupId === owner.groupId).length,
        closing: owner.closeTimer !== null,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------

  private ownerOfGroup(groupId: number): Owner | undefined {
    if (groupId < 0) return undefined;
    for (const owner of this.owners.values()) {
      if (owner.groupId === groupId) return owner;
    }
    return undefined;
  }

  private clientOfTab(tab: TabState): CdpClientState | null {
    return this.ownerOfGroup(tab.info.groupId)?.client ?? null;
  }

  private ownsTab(client: CdpClientState, tabId: number): boolean {
    const tab = this.tabs.get(tabId);
    return tab !== undefined && this.clientOfTab(tab) === client;
  }

  // ---------------------------------------------------------------------
  // Extension side
  // ---------------------------------------------------------------------

  attachExtensionSocket(socket: BridgeSocket): {
    onMessage: (raw: string) => void;
    onClose: () => void;
  } {
    if (this.extension) {
      // MV3 service workers restart and the stale socket may linger half-open. Newest wins.
      log.info(`${this.opts.name ?? "profile"}: extension reconnected; replacing the previous connection`);
      this.extension.socket.close(4000, "replaced by newer extension connection");
      this.handleExtensionGone();
    }
    let helloSeen = false;
    const onMessage = (raw: string) => {
      const msg = parseExtensionMessage(raw);
      if (!msg) {
        log.warn("dropping malformed extension frame");
        return;
      }
      if (!helloSeen) {
        if (msg.type !== "hello") {
          socket.close(4001, "expected hello");
          return;
        }
        helloSeen = true;
        this.extension = {
          socket,
          identity: {
            email: msg.email,
            userAgent: msg.userAgent,
            browserVersion: msg.browserVersion,
            extensionVersion: msg.extensionVersion,
          },
        };
        this.syncTabs(msg.tabs);
        this.startPing();
        const waiters = this.extensionWaiters;
        this.extensionWaiters = [];
        for (const wake of waiters) wake();
        this.opts.onStateChange?.();
        return;
      }
      this.handleExtensionMessage(msg);
    };
    const onClose = () => {
      if (this.extension?.socket === socket) {
        this.handleExtensionGone();
        this.opts.onStateChange?.();
      }
    };
    return { onMessage, onClose };
  }

  private handleExtensionMessage(msg: ExtensionToRelayMessage): void {
    switch (msg.type) {
      case "result":
      case "error": {
        const pending = this.pendingExtension.get(msg.seq);
        if (!pending) return;
        this.pendingExtension.delete(msg.seq);
        clearTimeout(pending.timer);
        if (msg.type === "result") pending.resolve(msg.result);
        else pending.reject(new Error(msg.message));
        return;
      }
      case "cdpEvent":
        this.forwardExtensionEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
        return;
      case "tabs":
        this.syncTabs(msg.tabs);
        return;
      case "detached": {
        const tab = this.tabs.get(msg.tabId);
        if (tab?.attached) {
          const { sessionId, targetId } = tab.attached;
          tab.attached = undefined;
          this.emitDetachedFromTarget(msg.tabId, sessionId, targetId);
        }
        return;
      }
      case "pong":
      case "hello":
        return;
    }
  }

  private handleExtensionGone(): void {
    this.extension = null;
    this.stopPing();
    for (const pending of this.pendingExtension.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("extension disconnected"));
    }
    this.pendingExtension.clear();
    // Clients learn their pages are gone; the tab list survives so a reconnecting extension
    // re-exposes the same tabs to the same owners.
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached) {
        const { sessionId, targetId } = tab.attached;
        tab.attached = undefined;
        this.emitDetachedFromTarget(tabId, sessionId, targetId);
      }
    }
    this.childSessions.clear();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.sendToExtension({ type: "ping" }), EXTENSION_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendToExtension(msg: RelayToExtensionMessage): void {
    if (!this.extension) {
      throw new Error(`${this.opts.name ?? "this profile"}: the Claude Browser Bridge extension is not connected`);
    }
    this.extension.socket.send(JSON.stringify(msg));
  }

  private callExtension(command: RelayCommandBody, timeoutMs = EXTENSION_COMMAND_TIMEOUT_MS): Promise<unknown> {
    const seq = this.nextSeq++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtension.delete(seq);
        reject(new Error(`extension command timed out after ${timeoutMs / 1000} s: ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingExtension.set(seq, { resolve, reject, timer });
      try {
        this.sendToExtension({ ...command, seq });
      } catch (err) {
        this.pendingExtension.delete(seq);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Resolve once an extension is connected; asks the daemon to open the profile first. */
  private waitForExtension(): Promise<void> {
    if (this.extension) return Promise.resolve();
    this.opts.onNeedExtension?.();
    const waitMs = this.opts.extensionWaitMs ?? EXTENSION_WAIT_MS;
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.extensionWaiters = this.extensionWaiters.filter((w) => w !== wake);
        reject(
          new Error(
            `${this.opts.name ?? "this profile"}: Chrome did not connect within ${waitMs / 1000} s; is the profile open and the extension enabled?`,
          ),
        );
      }, waitMs);
      timer.unref?.();
      this.extensionWaiters.push(wake);
    });
  }

  private syncTabs(next: RelayTabInfo[]): void {
    const nextIds = new Set(next.map((tab) => tab.tabId));
    for (const tabId of [...this.tabs.keys()]) {
      if (!nextIds.has(tabId)) this.dropTab(tabId);
    }
    for (const info of next) this.applyTab(info);
  }

  /** A tab left every Claude group (closed, or dragged out): its client loses it. */
  private dropTab(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    if (tab.attached) {
      const { sessionId, targetId } = tab.attached;
      tab.attached = undefined;
      this.emitDetachedFromTarget(tabId, sessionId, targetId);
      void this.execDetach(tabId).catch(() => {});
    }
  }

  private applyTab(info: RelayTabInfo): void {
    const existing = this.tabs.get(info.tabId);
    if (!existing) {
      this.tabs.set(info.tabId, { info });
      this.autoAttachForOwner(info.tabId);
      return;
    }
    const ownerChanged = existing.info.groupId !== info.groupId;
    existing.info = info;
    if (!ownerChanged) return;
    if (existing.attached) {
      // The new owner gets a fresh attachment: the old owner's enabled domains, bindings and child
      // sessions must not leak into another chat's session.
      const { sessionId, targetId } = existing.attached;
      existing.attached = undefined;
      this.emitDetachedFromTarget(info.tabId, sessionId, targetId);
      void this.execDetach(info.tabId)
        .catch(() => {})
        .finally(() => this.autoAttachForOwner(info.tabId));
      return;
    }
    this.autoAttachForOwner(info.tabId);
  }

  private autoAttachForOwner(tabId: number): void {
    const tab = this.tabs.get(tabId);
    const client = tab ? this.clientOfTab(tab) : null;
    if (!client?.autoAttach) return;
    void this.ensureTabAttached(tabId)
      .then(({ targetId, sessionId }) => this.announceAttachedTab(tabId, targetId, sessionId, client))
      .catch((err: unknown) => log.warn(`auto-attach of tab ${tabId} failed: ${String(err)}`));
  }

  private async ensureTabAttached(tabId: number): Promise<{ targetId: string; sessionId: string }> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`tab ${tabId} is not in a Claude tab group`);
    if (tab.attached) return tab.attached;
    if (tab.attaching) return await tab.attaching;
    const attaching = (async () => {
      const { targetId } = await this.execAttach(tabId);
      const attached = { targetId, sessionId: `cbb-tab-${tabId}-${this.nextSessionOrdinal++}` };
      // Identity check: the tab could have closed and a new one taken its id mid-attach.
      if (this.tabs.get(tabId) !== tab) {
        void this.execDetach(tabId).catch(() => {});
        throw new Error(`tab ${tabId} closed during attach`);
      }
      tab.attached = attached;
      return attached;
    })();
    tab.attaching = attaching;
    try {
      return await attaching;
    } finally {
      tab.attaching = undefined;
    }
  }

  private targetInfoForTab(tab: TabState, targetId: string): Record<string, unknown> {
    const opener = tab.info.openerTabId !== undefined ? this.tabs.get(tab.info.openerTabId) : undefined;
    return {
      targetId,
      type: "page",
      title: tab.info.title,
      url: tab.info.url,
      // connectOverCDP owns this as a persistent default context, but still asserts that
      // attached page events carry a non-empty context id.
      browserContextId: BROWSER_CONTEXT_ID,
      attached: true,
      canAccessOpener: false,
      ...(opener?.attached ? { openerId: opener.attached.targetId } : {}),
    };
  }

  private announceAttachedTab(tabId: number, targetId: string, sessionId: string, client: CdpClientState): void {
    const tab = this.tabs.get(tabId);
    // Ownership can move while an attach is in flight; only the current owner hears about it.
    if (!tab || this.clientOfTab(tab) !== client || client.announcedSessions.has(sessionId)) return;
    client.announcedSessions.add(sessionId);
    client.socket.send(
      JSON.stringify({
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: this.targetInfoForTab(tab, targetId), waitingForDebugger: false },
      }),
    );
  }

  private emitDetachedFromTarget(tabId: number, sessionId: string, targetId: string): void {
    const event = JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
    for (const client of this.clients) {
      if (client.announcedSessions.delete(sessionId)) client.socket.send(event);
    }
    // Playwright's page-scoped sessions listen on their synthetic parent browser session.
    for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
      if (auxiliary.tabId !== tabId) continue;
      auxiliary.client.socket.send(
        JSON.stringify({
          sessionId: auxiliary.parentSessionId,
          method: "Target.detachedFromTarget",
          params: { sessionId: auxiliarySessionId, targetId },
        }),
      );
      this.auxiliaryTabSessions.delete(auxiliarySessionId);
    }
    // Reap child sessions (iframes/workers) by owner tab, so none can route to a reused tab id.
    for (const [childSessionId, ownerTabId] of this.childSessions) {
      if (ownerTabId !== tabId) continue;
      this.childSessions.delete(childSessionId);
      for (const client of this.clients) client.announcedSessions.delete(childSessionId);
    }
  }

  private forwardExtensionEvent(tabId: number, childSessionId: string | undefined, method: string, params: unknown): void {
    const rootSessionId = this.tabs.get(tabId)?.attached?.sessionId;
    if (!rootSessionId) return;
    const sessionId = childSessionId ?? rootSessionId;
    if (childSessionId) this.childSessions.set(childSessionId, tabId);
    // Child sessions announced through a parent's attachedToTarget stay routable for its client.
    if (method === "Target.attachedToTarget") {
      const announced = (params as { sessionId?: unknown } | null)?.sessionId;
      if (typeof announced === "string") {
        this.childSessions.set(announced, tabId);
        for (const client of this.clients) {
          if (client.announcedSessions.has(sessionId)) client.announcedSessions.add(announced);
        }
      }
    }
    const frame = JSON.stringify({ sessionId, method, params });
    for (const client of this.clients) {
      if (client.announcedSessions.has(sessionId)) client.socket.send(frame);
    }
    if (!childSessionId) {
      // Page-scoped sessions multiplex the same root; mirror root events onto them.
      for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
        if (auxiliary.tabId === tabId) {
          auxiliary.client.socket.send(JSON.stringify({ sessionId: auxiliarySessionId, method, params }));
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // CDP client side (Playwright connectOverCDP)
  // ---------------------------------------------------------------------

  /**
   * Wire up a CDP client. `key` names the chat; a client with the key of an ended chat takes its
   * tab group back, and a second live connection under one key replaces the first.
   */
  attachCdpClientSocket(
    socket: BridgeSocket,
    opts: { key?: string } = {},
  ): { onMessage: (raw: string) => void; onClose: () => void } {
    const key = opts.key?.trim() || `claude-${crypto.randomBytes(3).toString("hex")}`;
    let owner = this.owners.get(key);
    if (!owner) {
      owner = { key, title: key, color: GROUP_COLORS[this.nextColor++ % GROUP_COLORS.length], groupId: null, client: null, closeTimer: null };
      this.owners.set(key, owner);
    }
    if (owner.closeTimer) {
      clearTimeout(owner.closeTimer);
      owner.closeTimer = null;
    }
    if (owner.client) {
      const previous = owner.client;
      this.releaseClient(previous);
      previous.socket.close(4000, "replaced by a newer connection for this chat");
    }
    const client: CdpClientState = { socket, owner, autoAttach: false, announcedSessions: new Set() };
    owner.client = client;
    this.clients.add(client);
    this.opts.onStateChange?.();
    const onMessage = (raw: string) => {
      let request: CdpRequest;
      try {
        request = JSON.parse(raw) as CdpRequest;
      } catch {
        return;
      }
      if (typeof request?.id !== "number" || typeof request?.method !== "string") return;
      void this.handleCdpRequest(client, request);
    };
    const onClose = () => {
      if (!this.clients.has(client)) return;
      this.releaseClient(client);
      this.scheduleGroupClose(client.owner);
      this.opts.onStateChange?.();
    };
    return { onMessage, onClose };
  }

  /** Forget a client's sessions and detach its tabs so the debugging infobar goes away. */
  private releaseClient(client: CdpClientState): void {
    this.clients.delete(client);
    if (client.owner.client === client) client.owner.client = null;
    for (const [sessionId, owner] of this.browserSessions) {
      if (owner === client) this.browserSessions.delete(sessionId);
    }
    for (const [sessionId, auxiliary] of this.auxiliaryTabSessions) {
      if (auxiliary.client === client) this.auxiliaryTabSessions.delete(sessionId);
    }
    const groupId = client.owner.groupId;
    for (const [tabId, tab] of this.tabs) {
      if (groupId === null || tab.info.groupId !== groupId || !tab.attached) continue;
      const { sessionId, targetId } = tab.attached;
      tab.attached = undefined;
      this.emitDetachedFromTarget(tabId, sessionId, targetId);
      void this.execDetach(tabId).catch(() => {});
    }
  }

  private scheduleGroupClose(owner: Owner): void {
    if (owner.client || owner.closeTimer) return;
    owner.closeTimer = setTimeout(() => {
      owner.closeTimer = null;
      if (owner.client) return;
      this.owners.delete(owner.key);
      if (owner.groupId !== null && this.extension) {
        void this.callExtension({ type: "closeGroup", groupId: owner.groupId }).catch((err: unknown) =>
          log.warn(`closing ${owner.key}'s tabs failed: ${String(err)}`),
        );
      }
      this.opts.onStateChange?.();
    }, this.opts.endedGroupTtlMs ?? ENDED_GROUP_TTL_MS);
    owner.closeTimer.unref?.();
  }

  private respond(client: CdpClientState, request: CdpRequest, result: unknown): void {
    client.socket.send(
      JSON.stringify({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), result: result ?? {} }),
    );
  }

  private respondError(client: CdpClientState, request: CdpRequest, message: string, code = -32000): void {
    client.socket.send(toErrorPayload(request.id, request.sessionId, message, code));
  }

  /** The tab behind a session this client was told about (or its own page-scoped alias). */
  private tabForClientSession(client: CdpClientState, sessionId: string): { tabId: number; child: boolean } | null {
    const auxiliary = this.auxiliaryTabSessions.get(sessionId);
    if (auxiliary) return auxiliary.client === client ? { tabId: auxiliary.tabId, child: false } : null;
    if (!client.announcedSessions.has(sessionId)) return null;
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached?.sessionId === sessionId) return { tabId, child: false };
    }
    const childOwner = this.childSessions.get(sessionId);
    return childOwner !== undefined ? { tabId: childOwner, child: true } : null;
  }

  /** A tab this client owns, found by its CDP targetId. */
  private ownedTabByTargetId(client: CdpClientState, targetId: string): { tabId: number; tab: TabState } | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached?.targetId === targetId && this.clientOfTab(tab) === client) return { tabId, tab };
    }
    return null;
  }

  private async handleCdpRequest(client: CdpClientState, request: CdpRequest): Promise<void> {
    try {
      await this.waitForExtension();
      if (request.sessionId && this.browserSessions.get(request.sessionId) !== client) {
        await this.handleSessionScopedRequest(client, request);
        return;
      }
      await this.handleBrowserScopedRequest(client, request);
    } catch (err) {
      this.respondError(client, request, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleSessionScopedRequest(client: CdpClientState, request: CdpRequest): Promise<void> {
    const sessionId = request.sessionId as string;
    const route = this.tabForClientSession(client, sessionId);
    if (!route) {
      this.respondError(client, request, `Session not found: ${sessionId}`, -32001);
      return;
    }
    const result = await this.execCdp(route.tabId, route.child ? sessionId : undefined, request.method, request.params);
    this.respond(client, request, result);
  }

  /** An attached tab this chat owns, for browser-scope calls that must run inside some tab. */
  private async anyTabOf(client: CdpClientState): Promise<number> {
    const owned = [...this.tabs.keys()].filter((tabId) => this.ownsTab(client, tabId));
    const attached = owned.find((tabId) => this.tabs.get(tabId)?.attached);
    if (attached !== undefined) return attached;
    if (owned.length === 0) throw new Error("this chat has no tab yet; open a page first");
    await this.ensureTabAttached(owned[0]);
    return owned[0];
  }

  private notFound(client: CdpClientState, request: CdpRequest, targetId: unknown): void {
    this.respondError(client, request, `No target with given id found: ${String(targetId)}`, -32602);
  }

  private async handleBrowserScopedRequest(client: CdpClientState, request: CdpRequest): Promise<void> {
    const owner = client.owner;
    switch (request.method) {
      case "Browser.getVersion": {
        const identity = this.extension?.identity;
        this.respond(client, request, {
          protocolVersion: "1.3",
          product: identity?.browserVersion ?? "Chrome/unknown",
          revision: "chrome-profile-bridge",
          userAgent: identity?.userAgent ?? "unknown",
          jsVersion: "",
        });
        return;
      }
      case "Browser.close": {
        // Never close the user's real browser; end this client only.
        this.respond(client, request, {});
        client.socket.close(1000, "Browser.close");
        return;
      }
      // Browser-level knobs chrome.debugger cannot reach; acknowledging keeps Playwright's
      // default-context bootstrap happy with browser defaults.
      case "Browser.setDownloadBehavior":
      case "Target.setDiscoverTargets":
        this.respond(client, request, {});
        return;
      case "Target.getTargetInfo": {
        const targetId = request.params?.targetId as string | undefined;
        if (!targetId || targetId === BROWSER_TARGET_ID) {
          this.respond(client, request, {
            targetInfo: { targetId: BROWSER_TARGET_ID, type: "browser", title: "Claude Browser Bridge", url: "", attached: true, canAccessOpener: false },
          });
          return;
        }
        const found = this.ownedTabByTargetId(client, targetId);
        if (!found) return this.notFound(client, request, targetId);
        this.respond(client, request, { targetInfo: this.targetInfoForTab(found.tab, targetId) });
        return;
      }
      case "Target.getTargets": {
        const targetInfos = [...this.tabs.values()]
          .filter((tab) => tab.attached && this.clientOfTab(tab) === client)
          .map((tab) => this.targetInfoForTab(tab, tab.attached?.targetId ?? ""));
        this.respond(client, request, { targetInfos });
        return;
      }
      case "Target.attachToBrowserTarget": {
        const sessionId = `cbb-browser-${this.nextSessionOrdinal++}`;
        this.browserSessions.set(sessionId, client);
        this.respond(client, request, { sessionId });
        return;
      }
      case "Target.setAutoAttach": {
        client.autoAttach = request.params?.autoAttach !== false;
        if (client.autoAttach) {
          const owned = [...this.tabs.keys()].filter((tabId) => this.ownsTab(client, tabId));
          const results = await Promise.allSettled(
            owned.map(async (tabId) => ({ tabId, ...(await this.ensureTabAttached(tabId)) })),
          );
          for (const settled of results) {
            if (settled.status === "fulfilled") {
              this.announceAttachedTab(settled.value.tabId, settled.value.targetId, settled.value.sessionId, client);
            } else {
              log.warn(`setAutoAttach attach failed: ${String(settled.reason)}`);
            }
          }
        }
        this.respond(client, request, {});
        return;
      }
      case "Target.attachToTarget": {
        const targetId = request.params?.targetId as string | undefined;
        if (!targetId) {
          this.respondError(client, request, "targetId is required", -32602);
          return;
        }
        const found = this.ownedTabByTargetId(client, targetId);
        if (!found) return this.notFound(client, request, targetId);
        const attached = await this.ensureTabAttached(found.tabId);
        if (request.sessionId && this.browserSessions.get(request.sessionId) === client) {
          // Playwright opens a fresh page-scoped session for helpers; multiplex it onto the one
          // real chrome.debugger attachment.
          const sessionId = `cbb-tab-${found.tabId}-${this.nextSessionOrdinal++}`;
          this.auxiliaryTabSessions.set(sessionId, { tabId: found.tabId, parentSessionId: request.sessionId, client });
          this.respond(client, request, { sessionId });
          return;
        }
        this.announceAttachedTab(found.tabId, attached.targetId, attached.sessionId, client);
        this.respond(client, request, { sessionId: attached.sessionId });
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = request.params?.sessionId as string | undefined;
        if (sessionId && this.browserSessions.get(sessionId) === client) {
          this.browserSessions.delete(sessionId);
          for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
            if (auxiliary.parentSessionId === sessionId && auxiliary.client === client) {
              this.auxiliaryTabSessions.delete(auxiliarySessionId);
            }
          }
          this.respond(client, request, {});
          return;
        }
        const route = sessionId ? this.tabForClientSession(client, sessionId) : null;
        if (!route) {
          this.respondError(client, request, `Session not found: ${String(sessionId)}`, -32001);
          return;
        }
        if (this.auxiliaryTabSessions.has(sessionId as string)) {
          this.auxiliaryTabSessions.delete(sessionId as string);
        } else if (!route.child) {
          const tab = this.tabs.get(route.tabId);
          if (tab?.attached) {
            const { sessionId: rootSession, targetId } = tab.attached;
            tab.attached = undefined;
            this.emitDetachedFromTarget(route.tabId, rootSession, targetId);
            await this.execDetach(route.tabId).catch(() => {});
          }
        }
        this.respond(client, request, {});
        return;
      }
      case "Target.createTarget": {
        const url = typeof request.params?.url === "string" ? request.params.url : "about:blank";
        const created = (await this.callExtension({
          type: "createTab",
          url,
          ...(owner.groupId !== null ? { groupId: owner.groupId } : {}),
          title: owner.title,
          color: owner.color,
        })) as { tabId?: unknown; groupId?: unknown } | null;
        if (typeof created?.tabId !== "number" || typeof created?.groupId !== "number") {
          this.respondError(client, request, "extension did not return a tabId and groupId for createTab");
          return;
        }
        const tabId = created.tabId;
        owner.groupId = created.groupId;
        const existing = this.tabs.get(tabId);
        if (existing) existing.info.groupId = created.groupId;
        else this.tabs.set(tabId, { info: { tabId, url, title: "", active: false, groupId: created.groupId } });
        const attached = await this.ensureTabAttached(tabId);
        // Announce before responding, mirroring Chrome's event-then-result order.
        this.announceAttachedTab(tabId, attached.targetId, attached.sessionId, client);
        this.respond(client, request, { targetId: attached.targetId });
        return;
      }
      case "Target.closeTarget": {
        const found = this.ownedTabByTargetId(client, request.params?.targetId as string);
        if (!found) return this.notFound(client, request, request.params?.targetId);
        await this.callExtension({ type: "closeTab", tabId: found.tabId });
        this.respond(client, request, { success: true });
        return;
      }
      case "Target.activateTarget": {
        const found = this.ownedTabByTargetId(client, request.params?.targetId as string);
        if (!found) return this.notFound(client, request, request.params?.targetId);
        await this.callExtension({ type: "activateTab", tabId: found.tabId });
        this.respond(client, request, {});
        return;
      }
      // context.cookies(), addCookies() and clearCookies() arrive at browser scope, which
      // chrome.debugger cannot reach; Network.* on one of this chat's tabs sees the same
      // profile-wide cookie jar.
      case "Storage.getCookies": {
        const tabId = await this.anyTabOf(client);
        const result = (await this.execCdp(tabId, undefined, "Network.getAllCookies")) as { cookies?: unknown };
        this.respond(client, request, { cookies: result?.cookies ?? [] });
        return;
      }
      case "Storage.setCookies": {
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "Network.setCookies", { cookies: request.params?.cookies ?? [] });
        this.respond(client, request, {});
        return;
      }
      case "Storage.clearCookies": {
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "Network.clearBrowserCookies");
        this.respond(client, request, {});
        return;
      }
      case "Target.createBrowserContext":
        this.respondError(client, request, "Claude Browser Bridge drives a real signed-in profile; isolated browser contexts are not supported.");
        return;
      case "Bridge.listAllTabs":
        this.respond(client, request, await this.callExtension({ type: "listAllTabs" }));
        return;
      case "Bridge.adoptTab": {
        const tabId = request.params?.tabId;
        if (typeof tabId !== "number") {
          this.respondError(client, request, "tabId (number) is required; Bridge.listAllTabs lists them", -32602);
          return;
        }
        const moved = (await this.callExtension({
          type: "groupTab",
          tabId,
          ...(owner.groupId !== null ? { groupId: owner.groupId } : {}),
          title: owner.title,
          color: owner.color,
        })) as { groupId?: unknown; tab?: RelayTabInfo } | null;
        if (typeof moved?.groupId !== "number" || !moved.tab) {
          this.respondError(client, request, "extension did not return a groupId and tab for groupTab");
          return;
        }
        owner.groupId = moved.groupId;
        this.applyTab(moved.tab);
        this.respond(client, request, { groupId: moved.groupId });
        return;
      }
      case "Bridge.releaseTab": {
        const tabId = request.params?.tabId;
        if (typeof tabId !== "number" || !this.ownsTab(client, tabId)) {
          this.respondError(client, request, `tab ${String(tabId)} is not in this chat's group`, -32602);
          return;
        }
        await this.callExtension({ type: "ungroupTab", tabId });
        this.dropTab(tabId);
        this.respond(client, request, {});
        return;
      }
      default:
        this.respondError(client, request, `'${request.method}' wasn't found`, -32601);
    }
  }

  /** Close all sockets and reject pending work (daemon shutdown). */
  dispose(): void {
    this.stopPing();
    for (const pending of this.pendingExtension.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge stopped"));
    }
    this.pendingExtension.clear();
    for (const owner of this.owners.values()) {
      if (owner.closeTimer) clearTimeout(owner.closeTimer);
    }
    this.owners.clear();
    this.extension?.socket.close(1001, "bridge stopped");
    this.extension = null;
    for (const client of this.clients) client.socket.close(1001, "bridge stopped");
    this.clients.clear();
    this.browserSessions.clear();
    this.auxiliaryTabSessions.clear();
    this.tabs.clear();
    this.childSessions.clear();
  }
}
