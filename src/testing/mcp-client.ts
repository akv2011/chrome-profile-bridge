import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");

/** A real playwright-mcp on a CDP endpoint, driven over stdio the way an agent drives it. Returns a
 *  tool caller; the process is pushed to `procs` so the test can kill it. */
export async function mcpClient(endpoint: string, procs: ChildProcess[]) {
  const proc = spawn(process.execPath, [cli, "--cdp-endpoint", endpoint], { stdio: ["pipe", "pipe", "ignore"] });
  procs.push(proc);
  type Reply = { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  const waiting = new Map<number, (m: Reply) => void>();
  let buf = "";
  let id = 1;
  proc.stdout?.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  const req = (method: string, params: unknown) =>
    new Promise<Reply>((resolve) => {
      const i = id++;
      waiting.set(i, resolve);
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
    });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await req("tools/call", { name, arguments: args });
    return reply.result?.content?.map((c) => c.text ?? "").join("\n") ?? `ERROR ${JSON.stringify(reply.error)}`;
  };
}

/** browser_run_code_unsafe body that takes a heap snapshot and returns its byte count. */
export const HEAP_SNAPSHOT_CODE = `async (page) => {
  const s = await page.context().newCDPSession(page);
  let heap = 0; s.on("HeapProfiler.addHeapSnapshotChunk", e => heap += e.chunk.length);
  await s.send("HeapProfiler.enable"); await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  return JSON.stringify({ heapSnapshotBytes: heap });
}`;

export const heapBytes = (toolOutput: string): number => Number(/"heapSnapshotBytes\\?":\s*(\d+)/.exec(toolOutput)?.[1] ?? "0");
