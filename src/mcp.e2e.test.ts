import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpClient } from "./testing/mcp-client.ts";
import { startStack } from "./testing/stack.ts";

let stack: Awaited<ReturnType<typeof startStack>>;
const servers: ChildProcess[] = [];

/** The same playwright-mcp the pw-* tools run, as an agent sees it: JSON-RPC over stdio. */
const mcp = (client: string) => mcpClient(stack.cdpUrl(client), servers);

beforeAll(async () => {
  stack = await startStack();
}, 60_000);

afterAll(async () => {
  for (const proc of servers) proc.kill();
  await stack?.close();
});

describe("playwright-mcp 0.0.82 through the bridge", () => {
  it("navigates, snapshots, clicks by ref and lists network requests", async () => {
    const call = await mcp("MCP_A");
    expect(await call("browser_navigate", { url: stack.siteUrl })).toContain("Bridge test");
    const snapshot = await call("browser_snapshot");
    const ref = /button "Go" \[ref=(\w+)\]/.exec(snapshot)?.[1];
    expect(ref).toBeTruthy();
    expect(await call("browser_click", { element: "Go button", target: ref })).not.toContain("### Error");
    await call("browser_wait_for", { time: 1 });
    expect(await call("browser_network_requests", { static: false })).toContain("/api");
  }, 90_000);

  it("reaches the full trusted-CDP domains through the agent tool (heap snapshot, Profiler, Memory, DOMStorage)", async () => {
    const call = await mcp("MCP_FULL");
    await call("browser_navigate", { url: stack.siteUrl });
    const code = `async (page) => {
      const s = await page.context().newCDPSession(page);
      const out = {};
      let heap = 0; s.on("HeapProfiler.addHeapSnapshotChunk", (e) => (heap += e.chunk.length));
      await s.send("HeapProfiler.enable"); await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      out.heapSnapshotBytes = heap;
      await s.send("Profiler.enable"); await s.send("Profiler.start"); out.profilerNodes = (await s.send("Profiler.stop")).profile.nodes.length;
      out.domCounterNodes = (await s.send("Memory.getDOMCounters")).nodes;
      await s.send("DOMStorage.enable"); out.domStorage = "ok";
      return JSON.stringify(out);
    }`;
    const result = await call("browser_run_code_unsafe", { code });
    const num = (key: string) => Number(new RegExp(`"${key}\\\\?":\\s*(\\d+)`).exec(result)?.[1] ?? "0");
    expect(num("heapSnapshotBytes"), `tool output: ${result.slice(0, 300)}`).toBeGreaterThan(0);
    expect(num("profilerNodes")).toBeGreaterThan(0);
    expect(result).toContain("domStorage");
  }, 90_000);

  it("gives two agents on one profile their own tabs", async () => {
    const a = await mcp("MCP_B1");
    const b = await mcp("MCP_B2");
    await Promise.all([a("browser_navigate", { url: `${stack.siteUrl}?one` }), b("browser_navigate", { url: `${stack.siteUrl}?two` })]);
    const tabsA = await a("browser_tabs", { action: "list" });
    const tabsB = await b("browser_tabs", { action: "list" });
    expect(tabsA).toContain("?one");
    expect(tabsA).not.toContain("?two");
    expect(tabsB).toContain("?two");
    expect(tabsB).not.toContain("?one");
  }, 90_000);
});
