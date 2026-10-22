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
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createLogger } from "./log.ts";

const log = createLogger("holder");

/** Command ids the holder uses for its own cleanup; the daemon's ids stay far below. */
const OWN_ID_BASE = 2_100_000_000;

export type HolderOptions = { chromeBinary: string; userDataDir: string; socketPath: string; extraArgs?: string[] };

export function startHolder(opts: HolderOptions): { chromePid: number | undefined; close: () => void; exited: Promise<number | null> } {
  const chrome = spawn(
    opts.chromeBinary,
    ["--remote-debugging-pipe", `--user-data-dir=${opts.userDataDir}`, "--no-first-run", "--no-default-browser-check", ...(opts.extraArgs ?? [])],
    { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
  );
  const toChrome = chrome.stdio[3] as NodeJS.WritableStream;
  const fromChrome = chrome.stdio[4] as NodeJS.ReadableStream;

  let client: net.Socket | null = null;
  const sessions = new Set<string>(); // debug sessions attached through the current client
  let ownId = OWN_ID_BASE;

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

  // Chrome -> daemon. Read always: a full pipe would stall Chrome while no daemon is connected.
  let inBuf = Buffer.alloc(0);
  fromChrome.on("data", (chunk: Buffer) => {
    inBuf = Buffer.concat([inBuf, chunk]);
    let z: number;
    while ((z = inBuf.indexOf(0)) >= 0) {
      const frame = inBuf.subarray(0, z + 1);
      inBuf = inBuf.subarray(z + 1);
      const raw = frame.subarray(0, z).toString("utf8");
      if (Number(/^\{"id":(\d+)/.exec(raw)?.[1] ?? 0) >= OWN_ID_BASE) continue; // answer to our own cleanup
      track(raw);
      client?.write(frame);
    }
  });

  const cleanup = (): void => {
    for (const sessionId of sessions) {
      toChrome.write(`${JSON.stringify({ id: ownId++, method: "Target.detachFromTarget", params: { sessionId } })}\0`);
    }
    sessions.clear();
  };

  try { fs.unlinkSync(opts.socketPath); } catch {}
  const server = net.createServer((sock) => {
    if (client) {
      log.warn("a new daemon connected; dropping the previous one");
      client.destroy();
    }
    client = sock;
    let outBuf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      outBuf = Buffer.concat([outBuf, chunk]);
      let z: number;
      while ((z = outBuf.indexOf(0)) >= 0) {
        toChrome.write(outBuf.subarray(0, z + 1));
        outBuf = outBuf.subarray(z + 1);
      }
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
  server.listen(opts.socketPath, () => fs.chmodSync(opts.socketPath, 0o600));

  const exited = new Promise<number | null>((resolve) =>
    chrome.on("exit", (code) => {
      log.warn(`Chrome exited (${code})`);
      client?.destroy();
      server.close();
      resolve(code);
    }),
  );
  log.info(`Chrome ${chrome.pid} on the pipe (${opts.userDataDir}); serving ${opts.socketPath}`);
  return {
    chromePid: chrome.pid,
    exited,
    close: () => {
      server.close();
      chrome.kill();
    },
  };
}

if (import.meta.main) {
  const home = process.env.CBB_HOME || path.join(process.env.HOME ?? "", ".claude-browser-bridge");
  const udd = process.env.CBB_CHROME_UDD;
  if (!udd) throw new Error("holder: CBB_CHROME_UDD (a non-default Chrome data dir) is required");
  const h = startHolder({
    chromeBinary: process.env.CBB_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: udd,
    socketPath: process.env.CBB_CHROME_SOCKET || path.join(home, "chrome.sock"),
    extraArgs: process.env.CBB_CHROME_EXTRA ? process.env.CBB_CHROME_EXTRA.split(" ") : [],
  });
  // Exit with Chrome; launchd (KeepAlive) brings both back, so agents always have a browser.
  process.exit((await h.exited) ?? 0);
}
