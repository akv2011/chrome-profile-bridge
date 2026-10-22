/**
 * The trusted CDP connection to the real Chrome, over --remote-debugging-pipe (fd 3/4).
 *
 * The extension's chrome.debugger gets an untrusted V8 session, so Chrome refuses Profiler,
 * HeapProfiler, Memory, DOMStorage, IndexedDB, Security and ServiceWorker. A pipe connection is a
 * fully trusted client and reaches every domain. The daemon owns Chrome's launch so it holds the
 * pipe fds; a pipe is a file descriptor, not a network port, so nothing else on the Mac can use it.
 *
 * One Chrome process serves all of your profiles, so this is one connection for the whole
 * browser. Callers address a tab by its CDP targetId (the extension reports the targetId of each
 * tab it manages), and the bridge scopes which targetIds each chat may touch.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "./log.ts";

const log = createLogger("pipe");

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type PipeEvent = { targetId: string; sessionId?: string; method: string; params: unknown };

/** Chrome launch for the pipe. The user-data-dir must be non-default (Chrome 136+ refuses the pipe on the default dir). */
export type PipeOptions = {
  chromeBinary: string;
  userDataDir: string;
  extraArgs?: string[];
  onEvent: (event: PipeEvent) => void;
  onExit?: (code: number | null) => void;
};

export class ChromePipe {
  private chrome: ChildProcess | null = null;
  private toChrome: NodeJS.WritableStream | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** CDP sessionId -> the page targetId it drives, so events route back to a tab. */
  private readonly sessionTarget = new Map<string, string>();
  private readonly opts: PipeOptions;

  constructor(opts: PipeOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.chrome !== null && this.toChrome !== null;
  }

  /** Launch Chrome with the pipe and wait until CDP answers. */
  async start(): Promise<void> {
    if (this.running) return;
    const chrome = spawn(
      this.opts.chromeBinary,
      ["--remote-debugging-pipe", `--user-data-dir=${this.opts.userDataDir}`, "--no-first-run", "--no-default-browser-check", ...(this.opts.extraArgs ?? [])],
      { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
    );
    this.chrome = chrome;
    this.toChrome = chrome.stdio[3] as NodeJS.WritableStream;
    (chrome.stdio[4] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => this.onData(chunk));
    chrome.on("exit", (code) => {
      log.warn(`Chrome exited (${code}); CDP pipe closed`);
      this.chrome = null;
      this.toChrome = null;
      for (const p of this.pending.values()) p.reject(new Error("Chrome exited"));
      this.pending.clear();
      this.sessionTarget.clear();
      this.opts.onExit?.(code);
    });
    // Confirm the pipe answers.
    await this.send("Browser.getVersion");
    log.info(`Chrome up on the pipe (${this.opts.userDataDir})`);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let z: number;
    while ((z = this.buf.indexOf(0)) >= 0) {
      const raw = this.buf.subarray(0, z).toString("utf8");
      this.buf = this.buf.subarray(z + 1);
      let msg: { id?: number; result?: unknown; error?: { message: string }; sessionId?: string; method?: string; params?: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        continue;
      }
      if (!msg.method) continue;
      // Track child sessions so their events route to the right tab.
      if (msg.method === "Target.attachedToTarget") {
        const info = (msg.params as { sessionId?: string; targetInfo?: { targetId?: string } }) ?? {};
        if (info.sessionId && info.targetInfo?.targetId) this.sessionTarget.set(info.sessionId, info.targetInfo.targetId);
      }
      const targetId = msg.sessionId ? this.sessionTarget.get(msg.sessionId) : undefined;
      if (targetId) this.opts.onEvent({ targetId, sessionId: msg.sessionId, method: msg.method, params: msg.params });
    }
  }

  /** One CDP command (browser-scoped, or session-scoped when sessionId is given). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.toChrome) return Promise.reject(new Error("Chrome is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.toChrome?.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Attach to a page target with a flat session; returns the sessionId. */
  async attach(targetId: string): Promise<string> {
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    this.sessionTarget.set(sessionId, targetId);
    return sessionId;
  }

  async detach(sessionId: string): Promise<void> {
    this.sessionTarget.delete(sessionId);
    await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  /** Every page target in the browser (all profiles), for mapping tabs to targetIds. */
  async pageTargets(): Promise<Array<{ targetId: string; url: string; title: string; browserContextId?: string }>> {
    const { targetInfos } = (await this.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string; browserContextId?: string }>;
    };
    return targetInfos.filter((t) => t.type === "page");
  }

  stop(): void {
    this.chrome?.kill();
    this.chrome = null;
    this.toChrome = null;
  }
}
