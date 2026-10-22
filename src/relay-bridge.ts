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
import fs from "node:fs";
import path from "node:path";
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

const BROWSER_TARGET_ID = "claude-browser-bridge";
/** Playwright requires every attached page target to identify its browser context. */
const BROWSER_CONTEXT_ID = "claude-browser-bridge-context";

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
  /** Fast-load: URL patterns blocked on every tab of this chat (Bridge.setFastLoad), or null. */
  fastLoad: string[] | null;
  /** Last lean snapshot this chat took, for Bridge.snapshot{diff}. */
  lastSnapshot: LeanNode[] | null;
  /** Recent network requests on this chat's tabs (Bridge.har), newest last, capped. */
  har: HarEntry[];
  /** Where this chat's downloads land (Bridge.setDownloadDir), or null. */
  downloadDir: string | null;
  /** A flow being recorded (Bridge.record), or null. Replayed deterministically by role+name. */
  recording: { name: string; steps: FlowStep[] } | null;
};

type FlowStep = { type: "navigate"; url: string } | { type: "act"; action: string; text?: string; role?: string; name?: string };

type HarEntry = { requestId: string; method: string; url: string; type?: string; status: number | null; mimeType?: string; ts: number };
const HAR_CAP = 500;

/** One interactive element in a lean snapshot. `id` is the backend DOM node id for later action. */
export type LeanNode = { id: number; role: string; name: string; value?: string };

/** A profile is "signed in" when it reports a real account email, not the no-account placeholder. */
export function isSignedIn(email: string | undefined | null): boolean {
  return !!email && email.includes("@") && !email.endsWith("@profile.local");
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "option", "textarea", "spinbutton",
]);

type AxNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: string }; backendDOMNodeId?: number };

/** Keep only named interactive elements from a full AX tree, the part an agent acts on. */
export function leanAxNodes(nodes: AxNode[]): LeanNode[] {
  const out: LeanNode[] = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value ?? "";
    const name = (n.name?.value ?? "").trim();
    if (!INTERACTIVE_ROLES.has(role) || !name || typeof n.backendDOMNodeId !== "number") continue;
    const value = n.value?.value;
    out.push({ id: n.backendDOMNodeId, role, name, ...(value ? { value: String(value) } : {}) });
  }
  return out;
}

/** What changed between two lean snapshots, keyed by DOM node id. */
export function diffSnapshots(prev: LeanNode[], next: LeanNode[]): { added: LeanNode[]; removed: LeanNode[]; changed: LeanNode[] } {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const nextIds = new Set(next.map((n) => n.id));
  const added: LeanNode[] = [];
  const changed: LeanNode[] = [];
  for (const n of next) {
    const was = prevById.get(n.id);
    if (!was) added.push(n);
    else if (was.name !== n.name || was.value !== n.value || was.role !== n.role) changed.push(n);
  }
  return { added, removed: prev.filter((n) => !nextIds.has(n.id)), changed };
}

/** Block-pattern groups for Bridge.setFastLoad; an agent asks for groups, not raw patterns. */
const FAST_LOAD_PATTERNS: Record<string, string[]> = {
  image: ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.ico", "*.bmp", "*.avif"],
  font: ["*.woff", "*.woff2", "*.ttf", "*.otf", "*.eot"],
  media: ["*.mp4", "*.webm", "*.mp3", "*.m4a", "*.mov", "*.ogg"],
  ads: ["*doubleclick.net*", "*googlesyndication*", "*google-analytics*", "*googletagmanager*", "*adservice*", "*scorecardresearch*", "*/ads/*", "*facebook.com/tr*"],
};

/** Turn a Bridge.setFastLoad request into a de-duplicated URL-pattern list. */
export function fastLoadPatterns(params: { groups?: unknown; urls?: unknown }): string[] {
  const groups = Array.isArray(params.groups) ? params.groups : ["image", "font", "media", "ads"];
  const out = new Set<string>();
  for (const g of groups) for (const p of FAST_LOAD_PATTERNS[String(g)] ?? []) out.add(p);
  if (Array.isArray(params.urls)) for (const u of params.urls) if (typeof u === "string") out.add(u);
  return [...out];
}

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
  /** Where Bridge.timelineCapture writes per-chat screenshots + a log; unset disables the timeline. */
  timelineDir?: string;
  /** Ping the user (Bridge.requestHuman). The daemon wires this to CBB_NOTIFY_CMD; tests pass a mock. */
  notify?: (message: string) => void;
  /** Fetch a secret for Bridge.typeSecret. The daemon reads macOS Keychain; the value never leaves here. */
  secretSource?: (service: string, account: string) => Promise<string | null>;
  /** Store a secret for Bridge.saveSecret. The daemon writes macOS Keychain. */
  secretSink?: (service: string, account: string, value: string) => Promise<boolean>;
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
    const email = this.extension?.identity?.email ?? null;
    return {
      extension: this.extension?.identity ?? null,
      email,
      signedIn: isSignedIn(email),
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
      throw new Error(`${this.opts.name ?? "this profile"}: the Chrome Profile Bridge extension is not connected`);
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
      void this.applyFastLoad(tabId); // new tab joins this chat's fast-load block list, if any
      return attached;
    })();
    tab.attaching = attaching;
    try {
      return await attaching;
    } finally {
      tab.attaching = undefined;
    }
  }

  /** Record a network request/response on the owning chat's HAR log (capped). */
  private recordHar(tabId: number, method: string, params: unknown): void {
    const groupId = this.tabs.get(tabId)?.info.groupId;
    const owner = typeof groupId === "number" ? this.ownerOfGroup(groupId) : undefined;
    if (!owner) return;
    const p = params as { requestId?: string; request?: { method?: string; url?: string }; response?: { url?: string; status?: number; mimeType?: string }; type?: string };
    if (!p.requestId) return;
    if (method === "Network.requestWillBeSent") {
      owner.har.push({ requestId: p.requestId, method: p.request?.method ?? "", url: p.request?.url ?? "", type: p.type, status: null, ts: Date.now() });
      if (owner.har.length > HAR_CAP) owner.har.shift();
    } else {
      const entry = [...owner.har].reverse().find((e) => e.requestId === p.requestId);
      if (entry) { entry.status = p.response?.status ?? null; entry.mimeType = p.response?.mimeType; }
    }
  }

  /** Screenshot the chat's active tab and append a numbered timeline entry; null if disabled. */
  private async captureTimeline(client: CdpClientState, label: string): Promise<{ n: number; url: string } | null> {
    if (!this.opts.timelineDir) return null;
    const dir = path.join(this.opts.timelineDir, client.owner.key.replace(/[^a-z0-9_-]/gi, "-"));
    const logPath = path.join(dir, "log.jsonl");
    const tabId = await this.anyTabOf(client).catch(() => null);
    if (tabId === null) return null;
    let n = 1;
    try { n = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length + 1; } catch {} // restart-safe
    fs.mkdirSync(dir, { recursive: true });
    const shot = (await this.execCdp(tabId, undefined, "Page.captureScreenshot", { format: "png" }).catch(() => null)) as { data?: string } | null;
    if (shot?.data) fs.writeFileSync(path.join(dir, `${String(n).padStart(3, "0")}.png`), Buffer.from(shot.data, "base64"));
    const urlRes = (await this.execCdp(tabId, undefined, "Runtime.evaluate", { expression: "location.href", returnByValue: true }).catch(() => null)) as { result?: { value?: string } } | null;
    const url = urlRes?.result?.value ?? "";
    fs.appendFileSync(logPath, `${JSON.stringify({ n, ts: Date.now(), label, url, screenshot: shot?.data ? `${String(n).padStart(3, "0")}.png` : null })}\n`);
    return { n, url };
  }

  /** Scroll an element into view, wait until it has a box, act, and poll for a url/DOM change. */
  private async performAct(tabId: number, id: number, action: string, text: string | undefined): Promise<{ changed: boolean; navigated: boolean; url: string }> {
    const exec = (method: string, params?: unknown) => this.execCdp(tabId, undefined, method, params);
    const read = async () =>
      ((await exec("Runtime.evaluate", { expression: "location.href + '\\u0000' + document.documentElement.outerHTML.length", returnByValue: true })) as { result?: { value?: string } }).result?.value ?? "";
    await exec("DOM.enable").catch(() => {});
    await exec("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {});
    const before = await read();
    if (action === "type") {
      await exec("DOM.focus", { backendNodeId: id });
      await exec("Input.insertText", { text: String(text ?? "") });
    } else {
      let box: { model?: { content?: number[] } } | null = null;
      for (let i = 0; i < 10 && !box?.model?.content; i++) {
        box = (await exec("DOM.getBoxModel", { backendNodeId: id }).catch(() => null)) as typeof box;
        if (!box?.model?.content) await new Promise((r) => setTimeout(r, 150));
      }
      const q = box?.model?.content;
      if (!q) throw new Error(`element ${id} never became actionable (no box)`);
      const cx = (q[0] + q[4]) / 2;
      const cy = (q[1] + q[5]) / 2;
      await exec("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
      if (action !== "hover") {
        await exec("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
        await exec("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      }
    }
    let after = before;
    for (let i = 0; i < 12 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 150));
      after = await read();
    }
    const beforeUrl = before.split("\u0000")[0];
    const afterUrl = after.split("\u0000")[0];
    return { changed: after !== before, navigated: beforeUrl !== afterUrl, url: afterUrl };
  }

  /** The role+name of a snapshot id, from the chat's last snapshot, for recording a replayable step. */
  private describeNode(owner: Owner, id: number): { role?: string; name?: string } {
    const node = owner.lastSnapshot?.find((n) => n.id === id);
    return node ? { role: node.role, name: node.name } : {};
  }

  /** A fresh lean snapshot of a tab, for replay to find an element by role+name. */
  private async leanSnapshotOf(tabId: number): Promise<LeanNode[]> {
    await this.execCdp(tabId, undefined, "Accessibility.enable").catch(() => {});
    const { nodes } = (await this.execCdp(tabId, undefined, "Accessibility.getFullAXTree")) as { nodes: AxNode[] };
    return leanAxNodes(nodes);
  }

  /** Apply the owning chat's fast-load block list (if any) to one attached tab. */
  private async applyFastLoad(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    const groupId = tab?.info.groupId;
    const owner = typeof groupId === "number" ? this.ownerOfGroup(groupId) : undefined;
    if (!owner?.fastLoad) return;
    await this.execCdp(tabId, undefined, "Network.enable").catch(() => {});
    await this.execCdp(tabId, undefined, "Network.setBlockedURLs", { urls: owner.fastLoad }).catch(() => {});
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
    if (method === "Network.requestWillBeSent" || method === "Network.responseReceived") this.recordHar(tabId, method, params);
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
      owner = { key, title: key, color: GROUP_COLORS[this.nextColor++ % GROUP_COLORS.length], groupId: null, client: null, closeTimer: null, fastLoad: null, lastSnapshot: null, har: [], downloadDir: null, recording: null };
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
    // Bridge.* are the bridge's own methods, not Chrome's; serve them whether the agent calls them
    // from a page session or a browser session, rather than forwarding them to the tab.
    if (request.method.startsWith("Bridge.")) {
      await this.handleBrowserScopedRequest(client, request);
      return;
    }
    if (client.owner.recording && request.method === "Page.navigate") {
      const url = (request.params as { url?: string } | undefined)?.url;
      if (url) client.owner.recording.steps.push({ type: "navigate", url });
    }
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
          revision: "claude-browser-bridge",
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
            targetInfo: { targetId: BROWSER_TARGET_ID, type: "browser", title: "Chrome Profile Bridge", url: "", attached: true, canAccessOpener: false },
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
        })) as { tabId?: unknown; groupId?: unknown; targetId?: unknown } | null;
        if (typeof created?.tabId !== "number" || typeof created?.groupId !== "number") {
          this.respondError(client, request, "extension did not return a tabId and groupId for createTab");
          return;
        }
        const tabId = created.tabId;
        owner.groupId = created.groupId;
        // The pipe driver returns the real targetId so the trusted backend can attach at once; the
        // Chrome extension omits it and the attach command resolves it instead.
        const createdTargetId = typeof created.targetId === "string" ? created.targetId : undefined;
        const existing = this.tabs.get(tabId);
        if (existing) {
          existing.info.groupId = created.groupId;
          if (createdTargetId) existing.info.targetId = createdTargetId;
        } else {
          this.tabs.set(tabId, { info: { tabId, url, title: "", active: false, groupId: created.groupId, ...(createdTargetId ? { targetId: createdTargetId } : {}) } });
        }
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
        this.respondError(client, request, "Chrome Profile Bridge drives a real signed-in profile; isolated browser contexts are not supported.");
        return;
      case "Bridge.setFastLoad": {
        // Block images/fonts/media/ads (or custom url patterns) on every tab of this chat, so pages
        // load faster and snapshots shrink. { groups?: ["image","font","media","ads"], urls?: [...] };
        // empty groups and urls turns it off.
        const patterns = fastLoadPatterns(request.params ?? {});
        owner.fastLoad = patterns.length ? patterns : null;
        const owned = [...this.tabs.keys()].filter((tabId) => this.ownsTab(client, tabId));
        await Promise.all(
          owned.map(async (tabId) => {
            await this.ensureTabAttached(tabId);
            await this.execCdp(tabId, undefined, "Network.enable").catch(() => {});
            await this.execCdp(tabId, undefined, "Network.setBlockedURLs", { urls: patterns }).catch(() => {}); // empty clears
          }),
        );
        this.respond(client, request, { blocked: patterns.length });
        return;
      }
      case "Bridge.saveSecret": {
        // Save a credential to the Keychain for later auto-fill. { service, account, value? }. With
        // no value a strong one is generated and stored without the agent ever seeing it, so a
        // sign-up can set a password the agent then types into the form with Bridge.typeSecret.
        const service = String(request.params?.service ?? "");
        const account = String(request.params?.account ?? "");
        if (!service || !account) {
          this.respondError(client, request, "service and account are required", -32602);
          return;
        }
        if (!this.opts.secretSink) {
          this.respondError(client, request, "secret sink not configured");
          return;
        }
        const generated = typeof request.params?.value !== "string";
        const value = generated ? crypto.randomBytes(18).toString("base64url") : String(request.params?.value);
        const ok = await this.opts.secretSink(service, account, value).catch(() => false);
        if (!ok) {
          this.respondError(client, request, `could not save secret for service="${service}" account="${account}"`);
          return;
        }
        this.respond(client, request, { saved: true, generated }); // never the value
        return;
      }
      case "Bridge.typeSecret": {
        // Type a secret from the Keychain into an element without the agent ever seeing the value.
        // { id (from Bridge.snapshot), service, account }. The value is read here, typed over the
        // pipe, and never returned or logged; the agent gets only { typed: true }.
        const id = request.params?.id;
        const service = String(request.params?.service ?? "");
        const account = String(request.params?.account ?? "");
        if (typeof id !== "number" || !service || !account) {
          this.respondError(client, request, "id (number), service and account are required", -32602);
          return;
        }
        if (!this.opts.secretSource) {
          this.respondError(client, request, "secret source not configured");
          return;
        }
        const secret = await this.opts.secretSource(service, account).catch(() => null);
        if (!secret) {
          this.respondError(client, request, `no secret for service="${service}" account="${account}"`); // never echoes a value
          return;
        }
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "DOM.focus", { backendNodeId: id });
        await this.execCdp(tabId, undefined, "Input.insertText", { text: secret });
        this.respond(client, request, { typed: true });
        return;
      }
      case "Bridge.requestHuman": {
        // Last resort: the agent has TRIED the captcha / 2FA / login itself and is stuck. Ping the
        // user once, then poll `until` (a JS expression that becomes true once they solve it) on the
        // active tab until true or timeout, and resume. { reason, until?, timeoutMs? }.
        const reason = String(request.params?.reason ?? "needs you");
        const timeoutMs = Math.min(Number(request.params?.timeoutMs) || 180_000, 600_000);
        const until = typeof request.params?.until === "string" ? request.params.until : null;
        this.opts.notify?.(`Question: browser ${this.opts.name ?? "bridge"}: ${reason}`.slice(0, 94));
        const start = Date.now();
        let solved = false;
        if (until) {
          const tabId = await this.anyTabOf(client).catch(() => null);
          while (tabId !== null && Date.now() - start < timeoutMs) {
            await new Promise((r) => setTimeout(r, 500));
            const r = (await this.execCdp(tabId, undefined, "Runtime.evaluate", { expression: until, returnByValue: true }).catch(() => null)) as { result?: { value?: unknown } } | null;
            if (r?.result?.value) { solved = true; break; }
          }
          this.respond(client, request, { pinged: true, solved, waitedMs: Date.now() - start });
        } else {
          this.respond(client, request, { pinged: true, solved: false, note: "pinged; re-check the page yourself" });
        }
        return;
      }
      case "Bridge.har": {
        // The network requests seen on this chat's tabs (method, url, status, type). { clear?: true }
        // empties the log after returning it. Needs Network.enable on the tab, which Playwright does.
        const entries = client.owner.har.slice();
        if (request.params?.clear === true) client.owner.har.length = 0;
        this.respond(client, request, { entries });
        return;
      }
      case "Bridge.setDownloadDir": {
        // Downloads from this chat's tabs land in a per-chat directory under the bridge home.
        if (!this.opts.timelineDir) {
          this.respond(client, request, { disabled: true });
          return;
        }
        const dir = path.join(path.dirname(this.opts.timelineDir), "downloads", client.owner.key.replace(/[^a-z0-9_-]/gi, "-"));
        fs.mkdirSync(dir, { recursive: true });
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
        client.owner.downloadDir = dir;
        this.respond(client, request, { dir });
        return;
      }
      case "Bridge.downloads": {
        let files: string[] = [];
        if (client.owner.downloadDir) {
          try { files = fs.readdirSync(client.owner.downloadDir).filter((f) => !f.endsWith(".crdownload")); } catch {}
        }
        this.respond(client, request, { dir: client.owner.downloadDir, files });
        return;
      }
      case "Bridge.health": {
        // Is this profile usable right now? email + signedIn tell an agent to stop before it wastes
        // a task on a logged-out profile. signedIn is false for a profile with no real account.
        const email = this.identity?.email ?? null;
        this.respond(client, request, { name: this.opts.name ?? null, email, signedIn: isSignedIn(email), browserVersion: this.identity?.browserVersion ?? null });
        return;
      }
      case "Bridge.timelineCapture": {
        // Screenshot + a numbered log line for this chat, under ~/.chrome-profile-bridge/timeline/.
        const captured = await this.captureTimeline(client, String(request.params?.label ?? ""));
        this.respond(client, request, captured ?? { disabled: true });
        return;
      }
      case "Bridge.timeline": {
        const entries: unknown[] = [];
        if (this.opts.timelineDir) {
          const logPath = path.join(this.opts.timelineDir, client.owner.key.replace(/[^a-z0-9_-]/gi, "-"), "log.jsonl");
          try {
            for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) if (line) entries.push(JSON.parse(line));
          } catch {}
        }
        this.respond(client, request, { entries });
        return;
      }
      case "Bridge.act": {
        // Act on an element by its Bridge.snapshot id (backend DOM node): scroll it into view, wait
        // until it has a box, click/type/hover, then poll for a url or DOM change and report it.
        // { id, action?: "click"|"type"|"hover", text? }. Kills "clicked a stale/hidden element".
        const tabId = await this.anyTabOf(client);
        const id = request.params?.id;
        const action = (request.params?.action as string) ?? "click";
        if (typeof id !== "number") {
          this.respondError(client, request, "id (number) from Bridge.snapshot is required", -32602);
          return;
        }
        let result: { changed: boolean; navigated: boolean; url: string };
        try {
          result = await this.performAct(tabId, id, action, request.params?.text as string | undefined);
        } catch (err) {
          this.respondError(client, request, `act failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (owner.recording) owner.recording.steps.push({ type: "act", action, text: request.params?.text as string | undefined, ...this.describeNode(owner, id) });
        void this.captureTimeline(client, action).catch(() => {}); // auto-record the step
        this.respond(client, request, result);
        return;
      }
      case "Bridge.record": {
        owner.recording = { name: String(request.params?.name ?? "flow"), steps: [] };
        this.respond(client, request, { recording: owner.recording.name });
        return;
      }
      case "Bridge.stopRecording": {
        if (!owner.recording || !this.opts.timelineDir) {
          this.respond(client, request, { saved: false });
          return;
        }
        const dir = path.join(path.dirname(this.opts.timelineDir), "recordings");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${owner.recording.name.replace(/[^a-z0-9_-]/gi, "-")}.json`);
        fs.writeFileSync(file, JSON.stringify(owner.recording.steps, null, 2));
        const steps = owner.recording.steps.length;
        owner.recording = null;
        this.respond(client, request, { saved: true, steps, file });
        return;
      }
      case "Bridge.replay": {
        if (!this.opts.timelineDir) {
          this.respondError(client, request, "recordings are disabled (no home dir)");
          return;
        }
        const name = String(request.params?.name ?? "flow").replace(/[^a-z0-9_-]/gi, "-");
        let steps: FlowStep[];
        try {
          steps = JSON.parse(fs.readFileSync(path.join(path.dirname(this.opts.timelineDir), "recordings", `${name}.json`), "utf8")) as FlowStep[];
        } catch {
          this.respondError(client, request, `no recording named "${name}"`);
          return;
        }
        const tabId = await this.anyTabOf(client);
        let done = 0;
        for (const step of steps) {
          if (step.type === "navigate") {
            await this.execCdp(tabId, undefined, "Page.navigate", { url: step.url });
            await new Promise((r) => setTimeout(r, 500));
          } else {
            const node = (await this.leanSnapshotOf(tabId)).find((n) => n.role === step.role && n.name === step.name);
            if (!node) {
              this.respondError(client, request, `replay stuck: no "${step.name}" (${step.role}) on the page after ${done} steps`);
              return;
            }
            await this.performAct(tabId, node.id, step.action, step.text);
          }
          done++;
        }
        this.respond(client, request, { replayed: done });
        return;
      }
      case "Bridge.snapshot": {
        // A lean, interactive-only accessibility tree for this chat's active tab. { diff?: bool }
        // returns only what changed since the chat's last Bridge.snapshot. Far smaller than a full
        // page snapshot, so an agent spends fewer tokens per step.
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "Accessibility.enable").catch(() => {});
        const { nodes } = (await this.execCdp(tabId, undefined, "Accessibility.getFullAXTree")) as { nodes: AxNode[] };
        const lean = leanAxNodes(nodes);
        const prev = owner.lastSnapshot;
        owner.lastSnapshot = lean;
        if (request.params?.diff === true && prev) this.respond(client, request, diffSnapshots(prev, lean));
        else this.respond(client, request, { nodes: lean });
        return;
      }
      case "Bridge.extract": {
        // Run an in-page expression and return its JSON value (awaits a promise), so an agent pulls
        // structured data instead of reading a whole snapshot. { expression }.
        const tabId = await this.anyTabOf(client);
        const expression = String(request.params?.expression ?? "null");
        const r = (await this.execCdp(tabId, undefined, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
        if (r.exceptionDetails) {
          this.respondError(client, request, `extract threw: ${r.exceptionDetails.exception?.description ?? "error"}`);
          return;
        }
        this.respond(client, request, { value: r.result?.value ?? null });
        return;
      }
      case "Bridge.marks": {
        // Screenshot-friendly list of this tab's interactive elements with click coordinates, for
        // visual grounding when the AX names are thin. { screenshot?: true } adds a base64 png.
        const tabId = await this.anyTabOf(client);
        await this.execCdp(tabId, undefined, "Accessibility.enable").catch(() => {});
        const { nodes } = (await this.execCdp(tabId, undefined, "Accessibility.getFullAXTree")) as { nodes: AxNode[] };
        const marks: Array<{ n: number; id: number; role: string; name: string; x: number; y: number }> = [];
        let n = 1;
        for (const node of leanAxNodes(nodes)) {
          const box = (await this.execCdp(tabId, undefined, "DOM.getBoxModel", { backendNodeId: node.id }).catch(() => null)) as { model?: { content?: number[] } } | null;
          const q = box?.model?.content;
          if (!q) continue;
          marks.push({ n: n++, id: node.id, role: node.role, name: node.name, x: Math.round((q[0] + q[4]) / 2), y: Math.round((q[1] + q[5]) / 2) });
        }
        const out: Record<string, unknown> = { marks };
        if (request.params?.screenshot === true) {
          const shot = (await this.execCdp(tabId, undefined, "Page.captureScreenshot", { format: "png" }).catch(() => null)) as { data?: string } | null;
          if (shot?.data) out.screenshot = shot.data;
        }
        this.respond(client, request, out);
        return;
      }
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
