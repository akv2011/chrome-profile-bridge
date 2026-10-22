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
import path from "node:path";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./log.ts";
import { ChromePipe } from "./pipe.ts";
import { drivePipeProfile } from "./pipe-driver.ts";
import { chromeDir, chromeEmails, profileDirForName, profileNameForEmail } from "./profiles.ts";
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
    await pipe.start();
  }

  // contextId -> its profile dir once known. Positive cache only: a failed read (context busy, a
  // tab-creation race) is transient and must never be remembered as "not a profile", or that context
  // is skipped forever. `contextTries` bounds re-reads so a genuine non-profile context stops churning.
  const contextDirs = new Map<string, string>();
  const contextTries = new Map<string, number>();

  /** The profile directory of one browser context, read once from chrome://version over the pipe. */
  const profileDirOfContext = async (contextId: string): Promise<string | null> => {
    if (!pipe) return null;
    const known = contextDirs.get(contextId);
    if (known) return known;
    if ((contextTries.get(contextId) ?? 0) >= 4) return null; // genuine non-profile; stop re-reading
    contextTries.set(contextId, (contextTries.get(contextId) ?? 0) + 1);
    let targetId: string;
    try {
      ({ targetId } = (await pipe.send("Target.createTarget", { url: "chrome://version/", browserContextId: contextId })) as { targetId: string });
    } catch {
      return null; // transient (e.g. "Failed to find browser context"); retried next pass
    }
    try {
      const sid = await pipe.attach(targetId);
      await pipe.send("Page.enable", {}, sid).catch(() => {});
      let dir: string | null = null;
      for (let i = 0; i < 12 && !dir; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const rv = (await pipe.send("Runtime.evaluate", { expression: "document.getElementById('profile_path')?.textContent||''", returnByValue: true }, sid).catch(() => null)) as { result?: { value?: string } } | null;
        dir = (rv?.result?.value ?? "").trim() || null;
      }
      if (dir) contextDirs.set(contextId, dir);
      return dir;
    } catch {
      return null;
    } finally {
      await pipe.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  };

  /** Context ids that currently hold a page, newest discovery first. */
  const openContexts = async (): Promise<string[]> => {
    if (!pipe) return [];
    const pages = await pipe.pageTargets();
    return [...new Set(pages.map((p) => p.browserContextId).filter((c): c is string => !!c))];
  };

  /** Ensure a bridge + pipe driver exist for a profile; open the profile if it has no window yet. Deduped. */
  const ensurePipeProfile = async (name: string): Promise<void> => {
    if (!pipe) return;
    const existing = drivers.get(name);
    if (existing) {
      // Chrome unloads a profile once its last window closes; its context id dies with it.
      if ((await openContexts()).includes(existing.contextId)) return;
      log.info(`${name}: its profile closed since the last chat; reopening`);
      existing.dispose();
      drivers.delete(name);
    }
    let inflight = ensuring.get(name);
    if (!inflight) {
      inflight = buildPipeProfile(name).finally(() => ensuring.delete(name));
      ensuring.set(name, inflight);
    }
    return inflight;
  };

  const buildPipeProfile = async (name: string): Promise<void> => {
    if (!pipe || drivers.has(name)) return;
    const wantDir = profileDirForName(name, env);
    if (!wantDir) throw new Error(`${name}: no Chrome profile directory mapped (profiles.json)`);
    const wantPath = `${chromeDir(env)}/${wantDir}`;
    const find = async (): Promise<string | null> => {
      const ctxs = await openContexts();
      const seen: string[] = [];
      for (const ctx of ctxs) {
        const dir = await profileDirOfContext(ctx);
        seen.push(`${ctx.slice(0, 6)}=${dir ? dir.split("/").pop() : "·"}`);
        if (dir && (dir === wantPath || dir.endsWith(`/${wantDir}`))) return ctx;
      }
      if (env.CBB_DEBUG_FIND) log.info(`${name}: want "${wantDir}" among [${seen.join(", ")}]`);
      return null;
    };
    let ctx = await find();
    const launched = !ctx;
    if (!ctx) {
      log.info(`${name}: opening profile "${wantDir}" for a full-CDP chat`);
      spawn(opts.pipe?.chromeBinary ?? CHROME_BIN, [`--user-data-dir=${opts.pipe?.userDataDir}`, `--profile-directory=${wantDir}`], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 40 && !ctx; i++) { await new Promise((r) => setTimeout(r, 500)); ctx = await find(); }
    }
    if (!ctx) throw new Error(`${name}: could not find or open its profile window`);
    const email = chromeEmails(env).get(wantDir) ?? `${name}@profile.local`;
    const bridge = bridgeFor(name);
    const strayNewTabs = launched
      ? (await pipe.pageTargets()).filter((p) => p.browserContextId === ctx && /^chrome:\/\/new-?tab/.test(p.url)).map((p) => p.targetId)
      : [];
    const driver = drivePipeProfile({ bridge, pipe, contextId: ctx, email, browserVersion: "Chrome", strayNewTabs });
    drivers.set(name, driver);
    await driver.ready; // the bridge has the profile's tabs + identity before the client talks
    log.info(`${name}: full-CDP driver ready (context ${ctx.slice(0, 8)}, ${email})`);
  };

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
  setInterval(() => {
    const next = readVersion();
    if (!next || next === running || daemon.cdpClients() > 0) return;
    log.info(`new code ${next.slice(0, 7)} (running ${running.slice(0, 7) || "unversioned"}); restarting while idle`);
    process.exit(0);
  }, 30_000).unref();
}
