/**
 * The Chrome holder: owns Chrome's --remote-debugging-pipe and serves it to the bridge daemon on an
 * owner-only unix socket.
 *
 * Chrome closes when the process holding its pipe exits, so the holder is kept tiny and is never
 * restarted for an update. The daemon, which changes often, connects here and can restart (to
 * update itself, or after a crash) without closing the user's browser.
 *
 * Messages are NUL-delimited CDP JSON both ways. The holder forwards only whole messages, so a
 * daemon that drops mid-message never corrupts the stream. When a daemon disconnects, the holder
 * detaches the debug sessions that daemon left attached, so the next daemon starts clean.
 *
 * Quitting Chrome leaves it closed: the holder stays up, removes the Chrome socket, and starts Chrome
 * again only when something connects to the launch socket (the daemon, when a chat needs a profile,
 * or the Dock launcher bin/cbb-chrome). The holder outlives Chrome, so launchd never relaunches it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./log.ts";
import { NulFramer } from "./nul-frames.ts";

const log = createLogger("holder");

/** Command ids the holder uses for its own cleanup; the daemon's ids stay far below. */
const OWN_ID_BASE = 2_100_000_000;

export type HolderOptions = {
  chromeBinary: string;
  userDataDir: string;
  socketPath: string;
  extraArgs?: string[];
  /** Start Chrome right away (default). Otherwise it waits for the first launch request. */
  launchAtStart?: boolean;
};

/** Any connection here starts Chrome if it is not running. Lives next to the Chrome socket. */
export const launchSocketFor = (socketPath: string): string => path.join(path.dirname(socketPath), "chrome-launch.sock");

export function startHolder(opts: HolderOptions): { readonly chromePid: number | undefined; launch: () => void; close: () => void } {
  let chrome: ChildProcess | null = null;
  let toChrome: NodeJS.WritableStream | null = null;
  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  const sessions = new Set<string>(); // debug sessions attached through the current client
  let ownId = OWN_ID_BASE;
  let closing = false;

  /** Watch for sessions opening and closing, without parsing every (possibly huge) message. */
  const track = (raw: string): void => {
    if (raw.length > 4096) return;
    if (raw.includes('"Target.attachedToTarget"') || raw.includes('"result":{"sessionId"')) {
      try {
        const m = JSON.parse(raw) as { params?: { sessionId?: string }; result?: { sessionId?: string } };
        const id = m.params?.sessionId ?? m.result?.sessionId;
        if (id) sessions.add(id);
      } catch {}
    } else if (raw.includes('"Target.detachedFromTarget"')) {
      try {
        const id = (JSON.parse(raw) as { params?: { sessionId?: string } }).params?.sessionId;
        if (id) sessions.delete(id);
      } catch {}
    }
  };

  const cleanup = (): void => {
    for (const sessionId of sessions) {
      toChrome?.write(`${JSON.stringify({ id: ownId++, method: "Target.detachFromTarget", params: { sessionId } })}\0`);
    }
    sessions.clear();
  };

  const NUL = Buffer.from([0]);

  /** Start Chrome on the pipe and serve it on socketPath while it runs. No-op while it runs. */
  const launch = (): void => {
    if (chrome) return;
    const startedAt = Date.now();
    const proc = spawn(
      opts.chromeBinary,
      ["--remote-debugging-pipe", `--user-data-dir=${opts.userDataDir}`, "--no-first-run", "--no-default-browser-check", ...(opts.extraArgs ?? [])],
      { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
    );
    chrome = proc;
    toChrome = proc.stdio[3] as NodeJS.WritableStream;

    // Chrome -> daemon. Read always: a full pipe would stall Chrome while no daemon is connected.
    // Linear framing, and only small frames are decoded (a heap-snapshot chunk can be tens of MB).
    const fromChromeFrames = new NulFramer();
    (proc.stdio[4] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      fromChromeFrames.push(chunk, (frame) => {
        const head = frame.subarray(0, 40).toString("utf8");
        if (Number(/^\{"id":(\d+)/.exec(head)?.[1] ?? 0) >= OWN_ID_BASE) return; // answer to our own cleanup
        if (frame.length <= 4096) track(frame.toString("utf8"));
        if (client) {
          client.write(frame);
          client.write(NUL);
        }
      });
    });

    try { fs.unlinkSync(opts.socketPath); } catch {}
    const srv = net.createServer((sock) => {
      if (client) {
        log.warn("a new daemon connected; dropping the previous one");
        client.destroy();
      }
      client = sock;
      const toChromeFrames = new NulFramer();
      sock.on("data", (chunk: Buffer) => {
        // Forward whole frames only, so a daemon dropping mid-message never corrupts Chrome's stream.
        toChromeFrames.push(chunk, (frame) => {
          toChrome?.write(frame);
          toChrome?.write(NUL);
        });
      });
      sock.on("close", () => {
        if (client !== sock) return;
        client = null;
        cleanup();
        log.info("daemon disconnected; Chrome stays up");
      });
      sock.on("error", () => {});
      log.info("daemon connected");
    });
    srv.listen(opts.socketPath, () => fs.chmodSync(opts.socketPath, 0o600));
    server = srv;

    proc.on("exit", (code) => {
      // A Chrome that quits within seconds of launch handed its window to a Chrome already running
      // on the same data dir without the pipe (opened from the Dock), which the bridge cannot drive.
      const why = !closing && Date.now() - startedAt < 5_000 ? "; another Chrome without the pipe holds the data dir (opened from the Dock?): quit it" : "";
      log.warn(`Chrome exited (${code}); it stays closed until a chat or the launcher asks for it${why}`);
      client?.destroy();
      client = null;
      sessions.clear();
      srv.close(); // also removes the socket file, so the daemon sees Chrome is closed
      if (chrome === proc) {
        chrome = null;
        toChrome = null;
        server = null;
      }
    });
    log.info(`Chrome ${proc.pid} on the pipe (${opts.userDataDir}); serving ${opts.socketPath}`);
  };

  const launchSocket = launchSocketFor(opts.socketPath);
  try { fs.unlinkSync(launchSocket); } catch {}
  const launcher = net.createServer((sock) => {
    sock.on("error", () => {});
    launch();
    sock.end();
  });
  launcher.listen(launchSocket, () => fs.chmodSync(launchSocket, 0o600));
  if (opts.launchAtStart ?? true) launch();

  return {
    get chromePid() {
      return chrome?.pid;
    },
    launch,
    close: () => {
      closing = true;
      launcher.close();
      server?.close();
      chrome?.kill();
    },
  };
}

if (import.meta.main) {
  const home = process.env.CBB_HOME || path.join(process.env.HOME ?? "", ".claude-browser-bridge");
  const udd = process.env.CBB_CHROME_UDD;
  if (!udd) throw new Error("holder: CBB_CHROME_UDD (a non-default Chrome data dir) is required");
  startHolder({
    chromeBinary: process.env.CBB_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: udd,
    socketPath: process.env.CBB_CHROME_SOCKET || path.join(home, "chrome.sock"),
    extraArgs: process.env.CBB_CHROME_EXTRA ? process.env.CBB_CHROME_EXTRA.split(" ") : [],
    // Open Chrome at login, before macOS reopens it without the pipe. Any later holder start (a
    // crash, an update that replaced a holder which exited with Chrome) leaves a quit Chrome closed.
    // ponytail: uptime stands in for "this is login"; a login long after boot just starts on demand.
    launchAtStart: os.uptime() < 600,
  });
  // The launch socket keeps this process alive with Chrome closed; launchd restarts it only on a crash.
}
