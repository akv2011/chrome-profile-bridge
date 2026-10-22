import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack } from "./testing/stack.ts";

const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");

let stack: Awaited<ReturnType<typeof startStack>>;
const servers: ChildProcess[] = [];

/** The same playwright-mcp the pw-* tools run, as an agent sees it: JSON-RPC over stdio. */
async function mcp(client: string) {
  const proc = spawn(process.execPath, [cli, "--cdp-endpoint", stack.cdpUrl(client)], { stdio: ["pipe", "pipe", "ignore"] });
  servers.push(proc);
  const waiting = new Map<number, (msg: { result?: { content?: Array<{ text?: string }> }; error?: unknown }) => void>();
  let buffer = "";
  let nextId = 1;
  proc.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: { content?: Array<{ text?: string }> }; error?: unknown }>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-test", version: "0" } });
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    return reply.result?.content?.map((part) => part.text ?? "").join("\n") ?? `ERROR ${JSON.stringify(reply.error)}`;
  };
}

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
