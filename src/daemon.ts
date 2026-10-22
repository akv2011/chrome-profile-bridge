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
import { profileDirForName, profileNameForEmail } from "./profiles.ts";
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
  pipe?: { chromeBinary: string; userDataDir: string; extraArgs?: string[] };
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
  let pipe: ChromePipe | null = null;
  if (opts.pipe) {
    pipe = new ChromePipe({
      chromeBinary: opts.pipe.chromeBinary,
      userDataDir: opts.pipe.userDataDir,
      extraArgs: opts.pipe.extraArgs,
      onEvent: ({ targetId, method, params }) => {
        const entry = targetRegistry.get(targetId);
        if (entry) entry.bridge.injectCdpEvent(entry.tabId, undefined, method, params);
      },
      onExit: () => log.warn("pipe Chrome exited; the daemon will relaunch it on the next launchd restart"),
    });
    await pipe.start();
  }

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
      wss.handleUpgrade(req, socket, head, (ws) => {
        const handlers = bridgeFor(name).attachCdpClientSocket(bridgeSocket(ws), { key: url.searchParams.get("client") ?? undefined });
        ws.on("message", (data) => handlers.onMessage(decode(data)));
        ws.on("close", handlers.onClose);
        ws.on("error", (err) => log.warn(`cdp socket: ${String(err)}`));
      });
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
    close: async () => {
      for (const bridge of bridges.values()) bridge.dispose();
      pipe?.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.main) {
  const home = process.env.CBB_HOME || path.join(process.env.HOME ?? "", ".chrome-profile-bridge");
  const extensionDir = process.env.CBB_EXTENSION_DIR || path.join(home, "extension");
  // CBB_CHROME_UDD set => full-CDP mode: the daemon owns Chrome with the pipe, and auto-loads the
  // extension so no profile needs a manual Load unpacked.
  const udd = process.env.CBB_CHROME_UDD;
  await startDaemon({
    port: Number(process.env.CBB_PORT) || DEFAULT_PORT,
    extensionDir,
    ...(udd
      ? {
          pipe: {
            chromeBinary: process.env.CBB_CHROME_BIN || CHROME_BIN,
            userDataDir: udd,
            extraArgs: [`--load-extension=${extensionDir}`, ...(process.env.CBB_CHROME_EXTRA ? process.env.CBB_CHROME_EXTRA.split(" ") : [])],
          },
        }
      : {}),
  });
}
