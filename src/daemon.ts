/**
 * The always-on daemon (launchd KeepAlive on the Mac). One ProfileBridge per Chrome profile.
 *
 *   WS  /ext                 the extension, one socket per profile; Origin must be our extension
 *   WS  /cdp/<name>?client=  a CDP client (playwright-mcp --cdp-endpoint); must carry no Origin
 *   GET /status              JSON view of profiles, chats and tabs
 *
 * No token: the daemon binds 127.0.0.1, rejects foreign Host headers (DNS rebinding), and the
 * Origin rules keep every web page out, since browsers stamp Origin on each WebSocket handshake.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { launchSocketFor } from "./holder.ts";
import { createLogger } from "./log.ts";
import { ChromePipe } from "./pipe.ts";
import { drivePipeProfile, LAUNCH_MARKER } from "./pipe-driver.ts";
import { bridgeHome, chromeDir, chromeEmails, profileDirForName, profileNameForEmail } from "./profiles.ts";
import { type CdpExecBackend, ExtensionRelayBridge } from "./relay-bridge.ts";
import { parseExtensionMessage } from "./relay-protocol.ts";

const log = createLogger("daemon");

export const DEFAULT_PORT = 18765;
/** Room for CDP payloads (base64 screenshots, DOM snapshots, response bodies). */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const OPEN_PROFILE_DEBOUNCE_MS = 30_000;
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Chrome's extension id: the first 32 hex digits of sha256(public key DER), mapped 0-f to a-p. */
export function extensionIdFromKey(base64Key: string): string {
  const hex = crypto.createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

function readManifest(extensionDir: string): { key: string; version: string } {
  return JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8")) as { key: string; version: string };
}

/** True when a dotted version is older than another (1.9 < 1.10). */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Reject DNS rebinding: a page on evil.test resolved to 127.0.0.1 still sends Host: evil.test. */
function loopbackHost(req: IncomingMessage): boolean {
  const host = header(req, "host").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function bridgeSocket(ws: WebSocket) {
  return {
    send: (data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code?: number, reason?: string) => {
      try {
        ws.close(code, reason);
      } catch {
        // already closing
      }
    },
  };
}

export type DaemonOptions = {
  port?: number;
  /** Folder of the installed (unpacked) extension; its manifest gives the id and the current version. */
  extensionDir: string;
  env?: NodeJS.ProcessEnv;
  /** Opens a closed profile; defaults to launching Chrome with --profile-directory. */
  openProfile?: (dir: string) => void;
  extensionWaitMs?: number;
  endedGroupTtlMs?: number;
  /** Override the Bridge.requestHuman ping (defaults to running CBB_NOTIFY_CMD); tests pass a recorder. */
  notify?: (message: string) => void;
  /** Override the Bridge.typeSecret source (defaults to macOS Keychain); tests pass a mock. */
  secretSource?: (service: string, account: string) => Promise<string | null>;
  /** Override the Bridge.saveSecret sink (defaults to macOS Keychain); tests pass a mock. */
  secretSink?: (service: string, account: string, value: string) => Promise<boolean>;
  /**
   * Full-CDP mode: one Chrome launched with --remote-debugging-pipe on a non-default user-data-dir,
   * giving a fully trusted connection that reaches every domain. The extension still does identity,
   * groups and tab lifecycle; the pipe runs the CDP. Omit for the extension-only (chrome.debugger) path.
   */
  /** Full-CDP mode. With socketPath the daemon talks to a running holder (src/holder.ts) instead of
   *  launching Chrome itself, so it can restart without closing the browser. */
  pipe?: { chromeBinary: string; userDataDir: string; extraArgs?: string[]; socketPath?: string };
  /** Holder mode: the connection to Chrome went away (Chrome closed). The entrypoint exits so
   *  launchd restarts the daemon fresh; tests leave it unset. */
  onPipeLost?: () => void;
};

type Registry = Map<string, { bridge: ExtensionRelayBridge; tabId: number }>;

/** Per-profile trusted-CDP backend over the one shared Chrome pipe, keyed by the tab's real targetId. */
class PipeBackend implements CdpExecBackend {
  private readonly sessions = new Map<number, string>();
  private readonly pipe: ChromePipe;
  private readonly registry: Registry;
  private readonly bridge: ExtensionRelayBridge;
  constructor(pipe: ChromePipe, registry: Registry, bridge: ExtensionRelayBridge) {
    this.pipe = pipe;
    this.registry = registry;
    this.bridge = bridge;
  }
  async attach(tabId: number, targetId: string): Promise<void> {
    this.sessions.set(tabId, await this.pipe.attach(targetId));
    this.registry.set(targetId, { bridge: this.bridge, tabId });
  }
  async detach(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    for (const [targetId, entry] of this.registry) {
      if (entry.bridge === this.bridge && entry.tabId === tabId) this.registry.delete(targetId);
    }
    await this.pipe.detach(session);
  }
  cdp(tabId: number, _sessionId: string | undefined, method: string, params?: unknown): Promise<unknown> {
    const session = this.sessions.get(tabId);
    if (!session) return Promise.reject(new Error(`tab ${tabId} is not attached on the pipe`));
    return this.pipe.send(method, (params as Record<string, unknown>) ?? {}, session);
  }
}

export async function startDaemon(opts: DaemonOptions) {
  const env = opts.env ?? process.env;
  const extensionOrigin = `chrome-extension://${extensionIdFromKey(readManifest(opts.extensionDir).key)}`;
  const bridges = new Map<string, ExtensionRelayBridge>();
  const lastOpened = new Map<string, number>();

  // Full-CDP mode: one trusted pipe to the whole browser. A tab's CDP events route back to its
  // bridge by the real targetId the extension reports; iframe child targets are not tabs, so
  // their events are dropped here (page-level domains, the ones Chrome blocks the extension from,
  // all ride the page session).
  const targetRegistry = new Map<string, { bridge: ExtensionRelayBridge; tabId: number }>();
  const drivers = new Map<string, ReturnType<typeof drivePipeProfile>>();
  const ensuring = new Map<string, Promise<void>>();
  let pipe: ChromePipe | null = null;
  if (opts.pipe) {
    pipe = new ChromePipe({
      chromeBinary: opts.pipe.chromeBinary,
      userDataDir: opts.pipe.userDataDir,
      extraArgs: opts.pipe.extraArgs,
      socketPath: opts.pipe.socketPath,
      onEvent: ({ targetId, method, params }) => {
        const entry = targetRegistry.get(targetId);
        if (entry) entry.bridge.injectCdpEvent(entry.tabId, undefined, method, params);
      },
      onTargetEvent: (e) => {
        for (const d of drivers.values()) d.onTargetEvent(e);
      },
      onExit: () => {
        log.warn("lost Chrome; launchd restarts the daemon, which reconnects");
        opts.onPipeLost?.();
      },
    });
    // Holder mode connects lazily (ensurePipe): a quit Chrome stays closed until a chat needs it.
    if (!opts.pipe.socketPath) await pipe.start();
  }

  // The agent is stuck (captcha, login, a Chrome the bridge cannot reach) and needs you. Run
  // CBB_NOTIFY_CMD with the message as its one argument ($1, never parsed by the shell), so you can
  // wire any notifier (a script, a desktop toast); no-op if unset.
  const notify =
    opts.notify ??
    ((message: string) => {
      const cmd = process.env.CBB_NOTIFY_CMD;
      if (cmd) spawn("/bin/sh", ["-c", `${cmd} "$1"`, "sh", message], { detached: true, stdio: "ignore" }).unref();
    });

  // contextId -> its profile dir (string), or null for a confirmed non-profile context. A read that
  // merely failed (context tearing down, createTarget race) is NEVER cached, so it is retried, not
  // poisoned. A context opened by our own --profile-directory launch is cached from the launch, with
  // no read at all (the slow, flaky part). Most connects after warm-up are pure cache hits.
  const contextDirs = new Map<string, string>();
  // Why the last tab open into a context failed, for the resolve-failure log (a profile once
  // refused new tabs for ~2 min while it had pages, and nothing said why).
  const openErrors = new Map<string, string>();

  /** Read one context's profile dir from chrome://version. Robust to slow renders; a createTarget
   *  failure (context gone) returns null uncached. Caches the result once the page actually loads. */
  const readContextDir = async (contextId: string): Promise<string | null> => {
    if (!pipe) return null;
    let targetId: string;
    try {
      ({ targetId } = (await pipe.send("Target.createTarget", { url: "chrome://version/", browserContextId: contextId }, undefined, 8_000)) as { targetId: string });
    } catch (err) {
      openErrors.set(contextId, String(err));
      return null; // context is gone / tearing down; retry next time, do not cache
    }
    try {
      const sid = await pipe.attach(targetId, 5_000);
      await pipe.send("Page.enable", {}, sid, 5_000).catch(() => {});
      let dir = "";
      const deadline = Date.now() + 10_000; // one read never holds a resolve longer than this
      while (!dir && Date.now() < deadline) {
        const rv = (await pipe.send("Runtime.evaluate", { expression: "document.getElementById('profile_path')?.textContent||''", returnByValue: true }, sid, 2_000).catch(() => null)) as { result?: { value?: string } } | null;
        dir = (rv?.result?.value ?? "").trim();
        if (!dir) await new Promise((r) => setTimeout(r, 250));
      }
      // Cache only a real answer. An empty read is usually a slow render under load, and caching it as
      // "not a profile" would hide an open profile and cause a needless launch (a stray window).
      if (dir) contextDirs.set(contextId, dir);
      return dir || null;
    } catch {
      return null;
    } finally {
      await pipe.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {});
    }
  };

  /** Context ids that currently hold a page. */
  const openContexts = async (): Promise<string[]> => {
    if (!pipe) return [];
    const pages = await pipe.pageTargets();
    return [...new Set(pages.map((p) => p.browserContextId).filter((c): c is string => !!c))];
  };

  const matchesDir = (dir: string | null | undefined, wantDir: string, wantPath: string): boolean => !!dir && (dir === wantPath || dir.endsWith(`/${wantDir}`));

  /** Is this context really drivable? A page target can linger after its context dies (a zombie), so
   *  reuse is only safe if one of its pages still attaches. Not createTarget: Chrome finds a signed-in
   *  profile's context by id only while it is the last-used profile. A failure drops the id from the cache. */
  const validateContext = async (contextId: string): Promise<boolean> => {
    if (!pipe) return false;
    try {
      const page = (await pipe.pageTargets()).find((p) => p.browserContextId === contextId);
      if (!page) throw new Error("no page left");
      const sessionId = await pipe.attach(page.targetId, 5_000);
      void pipe.detach(sessionId);
      openErrors.delete(contextId);
      return true;
    } catch (err) {
      openErrors.set(contextId, String(err));
      contextDirs.delete(contextId);
      return false;
    }
  };

  /** Read-free cache of open contexts' profile dirs at startup, so later connects are cache hits. */
  const warmContexts = async (): Promise<void> => {
    for (const c of await openContexts()) if (!contextDirs.has(c)) await readContextDir(c);
  };

  // Open a tab in a profile through Chrome's command line, the way a link from another app opens. It
  // lands in that profile whichever window is active, which Target.createTarget cannot do for a profile
  // that is not the last-used one (a profile refused new tabs whenever another profile's window
  // opened). A unique data: URL marks the tab, so its context is that profile's, exactly: no
  // correlating "the context that appeared after the launch", which another window could fake.
  const openTabByLaunch = async (wantDir: string, wantPath: string): Promise<{ targetId: string; contextId: string } | null> => {
    if (!pipe) return null;
    const marker = `${LAUNCH_MARKER}${crypto.randomUUID()}</title>`;
    log.info(`opening a tab in profile "${wantDir}" by launch`);
    spawn(opts.pipe?.chromeBinary ?? CHROME_BIN, [`--user-data-dir=${opts.pipe?.userDataDir}`, `--profile-directory=${wantDir}`, marker], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const tab = (await pipe.pageTargets()).find((p) => p.url === marker);
      if (tab?.browserContextId) {
        contextDirs.set(tab.browserContextId, wantPath);
        return { targetId: tab.targetId, contextId: tab.browserContextId };
      }
    }
    return null;
  };

  const ensurePipeProfile = (name: string): Promise<void> => {
    if (!pipe) return Promise.resolve();
    let inflight = ensuring.get(name);
    if (!inflight) {
      inflight = buildOrReuse(name).finally(() => ensuring.delete(name));
      ensuring.set(name, inflight);
    }
    return inflight;
  };

  // Resolve a profile's live context, cheapest first: cache hit, else a one-off read of an already-open
  // window, else a tab opened by launch. No keepalive: an idle profile's window closes (window space,
  // RAM) and the next use reopens it. The launched tab is returned as a stray: the chat's first tab, or
  // closed once the chat has its own, so it cannot hold an idle window open. Tabs we did not open are
  // never touched.
  const resolveContext = async (wantDir: string, wantPath: string): Promise<{ contextId: string; strays: string[] } | null> => {
    if (!pipe) return null;
    const open = await openContexts();
    const live = new Set(open);
    for (const id of [...contextDirs.keys()]) if (!live.has(id)) contextDirs.delete(id); // drop dead ids
    let how = "cache";
    let ctx = open.find((c) => matchesDir(contextDirs.get(c), wantDir, wantPath)) ?? null; // cache hit
    if (ctx && !(await validateContext(ctx))) ctx = null; // the cached context died (window closed)
    if (!ctx) {
      // Read already-open windows BEFORE launching: --profile-directory on an open profile would open
      // a second window in it, which is exactly the clutter we avoid. Reads are cached once each.
      how = "read";
      for (const c of await openContexts()) {
        if (contextDirs.has(c)) continue;
        if (matchesDir(await readContextDir(c), wantDir, wantPath)) { ctx = c; break; }
      }
    }
    let strays: string[] = [];
    if (!ctx) {
      how = "launch";
      const opened = await openTabByLaunch(wantDir, wantPath);
      ctx = opened?.contextId ?? null;
      strays = opened ? [opened.targetId] : [];
    }
    if (!ctx) {
      const pages = await pipe.pageTargets().catch(() => []);
      const seen = [...new Set(pages.map((p) => p.browserContextId ?? "none"))].map((c) => {
        const urls = pages.filter((p) => (p.browserContextId ?? "none") === c).map((p) => p.url.slice(0, 40));
        return `${c.slice(0, 8)}=${contextDirs.get(c)?.split("/").pop() ?? "?"} [${urls.join(", ")}]${openErrors.has(c) ? ` (${openErrors.get(c)})` : ""}`;
      });
      log.warn(`${wantDir}: the launched tab never appeared; contexts: ${seen.join("; ")}`);
      return null;
    }
    log.info(`${wantDir}: resolved via ${how} (context ${ctx.slice(0, 8)}, strays ${strays.length})`);
    return { contextId: ctx, strays };
  };

  const buildOrReuse = async (name: string): Promise<void> => {
    if (!pipe) return;
    await ensurePipe(true);
    const wantDir = profileDirForName(name, env);
    if (!wantDir) throw new Error(`${name}: no Chrome profile directory mapped (profiles.json)`);
    const wantPath = `${chromeDir(env)}/${wantDir}`;
    const resolved = await resolveContext(wantDir, wantPath);
    if (!resolved) throw new Error(`${name}: could not find or open its profile window`);
    const ctx = resolved.contextId;
    const existing = drivers.get(name);
    if (existing) {
      if (existing.contextId === ctx) return existing.addStrays(resolved.strays); // same live context, reuse the driver
      existing.dispose(); // the old context died; rebuild on the new one
      drivers.delete(name);
    }
    const email = chromeEmails(env).get(wantDir) ?? `${name}@profile.local`;
    const bridge = bridgeFor(name);
    // openTab lets the driver open tabs in a profile that is not the last-used one, and recover a dead
    // context, without the client reconnecting.
    const driver = drivePipeProfile({
      bridge,
      pipe,
      contextId: ctx,
      email,
      browserVersion: "Chrome",
      strayNewTabs: resolved.strays,
      openTab: () => openTabByLaunch(wantDir, wantPath),
    });
    drivers.set(name, driver);
    await driver.ready; // the bridge has the profile's tabs + identity before the client talks
    log.info(`${name}: full-CDP driver ready (context ${ctx.slice(0, 8)}, ${email})`);
  };

  // Holder mode: connect to Chrome, and with `launch` ask the holder to start it first. A quit Chrome
  // stays closed until a chat needs a profile. Once connected, warm the cache for the profiles Chrome
  // restored, so the first connects are cache hits instead of a burst of chrome://version reads.
  let connecting: Promise<void> | null = null;
  let lastLaunchPing = 0;
  const ensurePipe = (launch: boolean): Promise<void> => {
    const socketPath = opts.pipe?.socketPath;
    if (!pipe || !socketPath || (pipe.running && !connecting)) return Promise.resolve();
    if (launch) net.connect(launchSocketFor(socketPath)).on("error", () => {}).end();
    connecting ??= pipe
      .start()
      .then(() => void warmContexts().catch(() => {}))
      .finally(() => (connecting = null));
    return connecting.catch((err) => {
      if (!launch) throw err;
      if (Date.now() - lastLaunchPing > 10 * 60_000) {
        lastLaunchPing = Date.now();
        notify("Question: Chrome is open outside the bridge (Dock?); quit it (Cmd+Q) so agents can use it");
      }
      throw new Error(`Chrome did not start on the bridge (${String(err)}). If Chrome was opened from the Dock, quit it (Cmd+Q) and retry: the bridge reopens it.`);
    });
  };
  if (pipe?.running) void warmContexts().catch(() => {});
  else if (opts.pipe?.socketPath && fs.existsSync(opts.pipe.socketPath)) void ensurePipe(false).catch(() => {});

  const openProfile =
    opts.openProfile ??
    ((dir: string) => {
      // --no-startup-window loads the profile, and so its extension, without opening a window
      // over your work. A running Chrome takes the request over its process singleton.
      spawn(CHROME_BIN, [`--profile-directory=${dir}`, "--no-startup-window"], { detached: true, stdio: "ignore" }).unref();
    });

  const diskVersion = () => {
    try {
      return readManifest(opts.extensionDir).version;
    } catch {
      return null;
    }
  };

  /** Reload an outdated extension, but only while no chat is using the profile. */
  const maybeUpdate = (name: string) => {
    const bridge = bridges.get(name);
    const running = bridge?.identity?.extensionVersion;
    const onDisk = diskVersion();
    if (!bridge || !running || !onDisk || !versionLess(running, onDisk) || bridge.cdpClientCount > 0) return;
    log.info(`${name}: updating the extension ${running} -> ${onDisk}`);
    bridge.requestExtensionReload();
  };

  const bridgeFor = (name: string): ExtensionRelayBridge => {
    let bridge = bridges.get(name);
    if (!bridge) {
      bridge = new ExtensionRelayBridge({
        name,
        extensionWaitMs: opts.extensionWaitMs,
        endedGroupTtlMs: opts.endedGroupTtlMs,
        timelineDir: path.join(bridgeHome(env), "timeline"),
        notify,
        secretSource:
          opts.secretSource ??
          ((service: string, account: string) =>
            // macOS Keychain; -w prints only the password. Never logged.
            new Promise<string | null>((resolve) => {
              const p = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { stdio: ["ignore", "pipe", "ignore"] });
              let out = "";
              p.stdout.on("data", (d) => (out += d));
              p.on("close", (code) => resolve(code === 0 ? out.replace(/\n$/, "") : null));
              p.on("error", () => resolve(null));
            })),
        secretSink:
          opts.secretSink ??
          ((service: string, account: string, value: string) =>
            new Promise<boolean>((resolve) => {
              // -U updates an existing item; -w takes the password so it is not in the arg list of ps.
              const p = spawn("/usr/bin/security", ["add-generic-password", "-s", service, "-a", account, "-U", "-w", value], { stdio: "ignore" });
              p.on("close", (code) => resolve(code === 0));
              p.on("error", () => resolve(false));
            })),
        onStateChange: () => maybeUpdate(name),
        onNeedExtension: () => {
          const dir = profileDirForName(name, env);
          const now = Date.now();
          if (!dir || now - (lastOpened.get(name) ?? 0) < OPEN_PROFILE_DEBOUNCE_MS) return;
          lastOpened.set(name, now);
          log.info(`${name}: opening Chrome profile "${dir}" for a waiting chat`);
          openProfile(dir);
        },
      });
      if (pipe) bridge.setCdpBackend(new PipeBackend(pipe, targetRegistry, bridge));
      bridges.set(name, bridge);
    }
    return bridge;
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const server = http.createServer((req, res) => {
    if (!loopbackHost(req) || header(req, "origin")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") {
      const profiles = Object.fromEntries([...bridges].map(([name, bridge]) => [name, bridge.status()]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ extensionOnDisk: diskVersion(), profiles }, null, 2));
      return;
    }
    res.writeHead(404).end("Not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = header(req, "origin");
    if (!loopbackHost(req)) return refuse(socket, "403 Forbidden");

    if (url.pathname === "/ext") {
      if (origin !== extensionOrigin) return refuse(socket, "403 Forbidden");
      // Full-CDP mode drives every profile through the pipe driver. A leftover installed extension
      // would replace that driver as the profile's tab source and hand out tabs without targetIds.
      if (pipe) return refuse(socket, "409 Conflict");
      wss.handleUpgrade(req, socket, head, (ws) => {
        let handlers: { onMessage: (raw: string) => void; onClose: () => void } | null = null;
        ws.on("message", (data) => {
          const raw = decode(data);
          if (handlers) return handlers.onMessage(raw);
          const hello = parseExtensionMessage(raw);
          if (hello?.type !== "hello") return ws.close(4001, "expected hello");
          const name = profileNameForEmail(hello.email, env);
          if (!name) {
            log.warn(`extension for "${hello.email}" matches no signed-in Chrome profile`);
            return ws.close(4004, "no Chrome profile is signed in with this email");
          }
          log.info(`${name}: extension ${hello.extensionVersion} connected (${hello.email})`);
          handlers = bridgeFor(name).attachExtensionSocket(bridgeSocket(ws));
          handlers.onMessage(raw);
        });
        ws.on("close", () => handlers?.onClose());
        ws.on("error", (err) => log.warn(`extension socket: ${String(err)}`));
      });
      return;
    }

    const cdp = /^\/cdp\/([\w.@-]+)$/.exec(url.pathname);
    if (cdp) {
      // Every browser page stamps Origin on a WebSocket handshake; agent processes send none.
      if (origin) return refuse(socket, "403 Forbidden");
      const name = cdp[1];
      if (!bridges.has(name) && !profileDirForName(name, env)) return refuse(socket, "404 Not Found");
      const accept = () =>
        wss.handleUpgrade(req, socket, head, (ws) => {
          const handlers = bridgeFor(name).attachCdpClientSocket(bridgeSocket(ws), { key: url.searchParams.get("client") ?? undefined });
          ws.on("message", (data) => handlers.onMessage(decode(data)));
          ws.on("close", handlers.onClose);
          ws.on("error", (err) => log.warn(`cdp socket: ${String(err)}`));
        });
      // Full-CDP mode: finish the profile's pipe driver BEFORE upgrading, so no opening CDP
      // command from the client is dropped while setup is still running.
      if (pipe) {
        ensurePipeProfile(name).then(accept, (err) => {
          log.warn(`${name}: ${String(err)}`);
          refuse(socket, "500 Internal Server Error");
        });
      } else {
        accept();
      }
      return;
    }
    refuse(socket, "404 Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);
  log.info(`listening on 127.0.0.1:${port}; extension origin ${extensionOrigin}`);

  return {
    port,
    bridges,
    /** Chats connected right now, across every profile; the self-update waits for zero. */
    cdpClients: () => [...bridges.values()].reduce((n, b) => n + b.cdpClientCount, 0),
    /** Profiles whose setup (opening a window, mapping the context) is in flight; a restart here
     *  would kill a connect that has not yet registered as a client, so the self-update waits for it. */
    pendingSetups: () => ensuring.size,
    close: async () => {
      for (const bridge of bridges.values()) bridge.dispose();
      pipe?.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.main) {
  const home = process.env.CBB_HOME || path.join(process.env.HOME ?? "", ".claude-browser-bridge");
  const extensionDir = process.env.CBB_EXTENSION_DIR || path.join(home, "extension");
  // CBB_CHROME_UDD set => full-CDP mode: every profile is driven over the trusted pipe, no
  // extension. CBB_CHROME_SOCKET set too => the holder owns Chrome and this daemon connects to it.
  const udd = process.env.CBB_CHROME_UDD;
  const daemon = await startDaemon({
    port: Number(process.env.CBB_PORT) || DEFAULT_PORT,
    extensionDir,
    onPipeLost: () => process.exit(1),
    ...(udd
      ? {
          pipe: {
            chromeBinary: process.env.CBB_CHROME_BIN || CHROME_BIN,
            userDataDir: udd,
            extraArgs: process.env.CBB_CHROME_EXTRA ? process.env.CBB_CHROME_EXTRA.split(" ") : [],
            socketPath: process.env.CBB_CHROME_SOCKET,
          },
        }
      : {}),
  });

  // Self-update: the repo's post-commit hook copies new code into the app dir and writes VERSION.
  // Once no chat is connected, exit; launchd restarts the daemon on the new code. In holder mode
  // Chrome stays open throughout.
  const versionFile = path.join(path.dirname(import.meta.dirname), "VERSION");
  const readVersion = () => { try { return fs.readFileSync(versionFile, "utf8").trim(); } catch { return ""; } };
  const running = readVersion();
  let idleTicks = 0;
  setInterval(() => {
    const busy = daemon.cdpClients() > 0 || daemon.pendingSetups() > 0;
    idleTicks = busy ? 0 : idleTicks + 1;
    const next = readVersion();
    // Restart only after a sustained quiet window (no chats, no setups in flight for ~60s), so a
    // connect that is opening a profile is never cut off mid-setup.
    if (!next || next === running || busy || idleTicks < 2) return;
    log.info(`new code ${next.slice(0, 7)} (running ${running.slice(0, 7) || "unversioned"}); restarting while idle`);
    process.exit(0);
  }, 30_000).unref();
}
