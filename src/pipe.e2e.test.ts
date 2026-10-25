import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon } from "./daemon.ts";
import { mcpClient } from "./testing/mcp-client.ts";

let daemon: Awaited<ReturnType<typeof startDaemon>>;
let home = "";
let udd = "";
const servers: ChildProcess[] = [];

/** playwright-mcp against the daemon, as an agent sees it. */
const mcp = (client: string) => mcpClient(`ws://127.0.0.1:${daemon.port}/cdp/pw-test?client=${client}`, servers);

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-pipe-home-"));
  udd = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-pipe-udd-"));
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify({ "pw-test": "Default" }));
  daemon = await startDaemon({
    port: 0,
    extensionDir: path.join(import.meta.dirname, "..", "extension"),
    env: { ...process.env, CBB_HOME: home, CBB_CHROME_DIR: udd },
    pipe: { chromeBinary: chromium.executablePath(), userDataDir: udd, extraArgs: ["--headless=new", "--no-first-run", "about:blank"] },
  });
}, 60_000);

afterAll(async () => {
  for (const p of servers) p.kill();
  await daemon?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(udd, { recursive: true, force: true });
});

describe("no-extension pipe mode", () => {
  it("drives the profile and reaches full F12 (navigate + heap snapshot) with no extension", async () => {
    const call = await mcp("PIPE_FULL");
    expect(await call("browser_navigate", { url: "https://example.com/" })).toContain("Example Domain");
    const code = `async (page) => {
      const s = await page.context().newCDPSession(page);
      let heap = 0; s.on("HeapProfiler.addHeapSnapshotChunk", e => heap += e.chunk.length);
      await s.send("HeapProfiler.enable"); await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      await s.send("Profiler.enable"); await s.send("Profiler.start"); const n = (await s.send("Profiler.stop")).profile.nodes.length;
      return JSON.stringify({ heapSnapshotBytes: heap, profilerNodes: n });
    }`;
    const result = await call("browser_run_code_unsafe", { code });
    const heap = Number(/"heapSnapshotBytes\\?":\s*(\d+)/.exec(result)?.[1] ?? "0");
    expect(heap, `tool output: ${result.slice(0, 300)}`).toBeGreaterThan(0);
  }, 90_000);

  it("reaches every DevTools area an agent needs (network, storage, cache, profiling, emulation)", async () => {
    const call = await mcp("PIPE_ALL");
    await call("browser_navigate", { url: "https://example.com/" });
    const code = `async (page) => {
      const s = await page.context().newCDPSession(page);
      const o = "https://example.com";
      const r = {};
      const t = async (k, fn) => { try { r[k] = await fn(); } catch (e) { r[k] = "FAIL " + String(e.message).slice(0, 90); } };
      await t("network", async () => { await s.send("Network.enable"); let n = 0; s.on("Network.responseReceived", () => n++); await page.reload(); await page.waitForTimeout(800); return n > 0 ? "ok" : "no responses"; });
      await t("cookies", async () => { await s.send("Network.setCookie", { name: "cbb", value: "1", url: o }); const { cookies } = await s.send("Network.getCookies", { urls: [o] }); return cookies.some((c) => c.name === "cbb") ? "ok" : "missing"; });
      await t("localStorage", async () => { await page.evaluate(() => localStorage.setItem("cbb", "1")); await s.send("DOMStorage.enable"); const { entries } = await s.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: o, isLocalStorage: true } }); return entries.some((e) => e[0] === "cbb") ? "ok" : "missing"; });
      await t("cacheStorage", async () => { await page.evaluate(async () => { const c = await caches.open("cbb"); await c.put("/x", new Response("hi")); }); const { caches: cs } = await s.send("CacheStorage.requestCacheNames", { securityOrigin: o }); return cs.some((c) => c.cacheName === "cbb") ? "ok" : "missing"; });
      await t("indexedDB", async () => { await page.evaluate(() => new Promise((res) => { const q = indexedDB.open("cbbdb", 1); q.onupgradeneeded = () => q.result.createObjectStore("s"); q.onsuccess = () => { q.result.close(); res(); }; })); await s.send("IndexedDB.enable"); const { databaseNames } = await s.send("IndexedDB.requestDatabaseNames", { securityOrigin: o }); return databaseNames.includes("cbbdb") ? "ok" : "missing"; });
      await t("clearCache", async () => { await s.send("Network.clearBrowserCache"); await s.send("Storage.clearDataForOrigin", { origin: o, storageTypes: "cache_storage" }); return "ok"; });
      await t("heapSnapshot", async () => { let b = 0; const h = (e) => (b += e.chunk.length); s.on("HeapProfiler.addHeapSnapshotChunk", h); await s.send("HeapProfiler.enable"); await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }); s.off("HeapProfiler.addHeapSnapshotChunk", h); return b > 0 ? "ok" : "empty"; });
      await t("cpuProfile", async () => { await s.send("Profiler.enable"); await s.send("Profiler.start"); const { profile } = await s.send("Profiler.stop"); return profile.nodes.length > 0 ? "ok" : "empty"; });
      await t("jsCoverage", async () => { await s.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true }); const { result } = await s.send("Profiler.takePreciseCoverage"); await s.send("Profiler.stopPreciseCoverage"); return Array.isArray(result) ? "ok" : "bad"; });
      await t("memory", async () => { const m = await s.send("Memory.getDOMCounters"); return m.nodes > 0 ? "ok" : "zero"; });
      await t("serviceWorker", async () => { await s.send("ServiceWorker.enable"); await s.send("ServiceWorker.disable"); return "ok"; });
      await t("security", async () => { await s.send("Security.setIgnoreCertificateErrors", { ignore: false }); return "ok"; });
      await t("performance", async () => { await s.send("Performance.enable"); const { metrics } = await s.send("Performance.getMetrics"); return metrics.length > 0 ? "ok" : "empty"; });
      await t("domCss", async () => { await s.send("DOM.enable"); await s.send("CSS.enable"); const { root } = await s.send("DOM.getDocument"); return root.nodeId ? "ok" : "no root"; });
      await t("emulation", async () => { await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: true }); await s.send("Emulation.clearDeviceMetricsOverride"); return "ok"; });
      await t("screenshot", async () => { const { data } = await s.send("Page.captureScreenshot"); return data.length > 0 ? "ok" : "empty"; });
      return "RESULTS" + JSON.stringify(r);
    }`;
    const out = await call("browser_run_code_unsafe", { code });
    const raw = /RESULTS(\{.*?\})(?:"|\n|$)/s.exec(out.replace(/\\"/g, '"'))?.[1];
    expect(raw, `tool output: ${out.slice(0, 400)}`).toBeTruthy();
    const results = JSON.parse(raw as string) as Record<string, string>;
    console.log(`DEVTOOLS ${JSON.stringify(results)}`);
    for (const [area, verdict] of Object.entries(results)) expect(verdict, area).toBe("ok");
  }, 120_000);

  it("keeps two agents on one profile in their own tabs", async () => {
    const a = await mcp("PIPE_A");
    const b = await mcp("PIPE_B");
    await Promise.all([a("browser_navigate", { url: "https://example.com/?a" }), b("browser_navigate", { url: "https://example.com/?b" })]);
    const ta = await a("browser_tabs", { action: "list" });
    const tb = await b("browser_tabs", { action: "list" });
    expect(ta).toContain("?a");
    expect(ta).not.toContain("?b");
    expect(tb).toContain("?b");
    expect(tb).not.toContain("?a");
  }, 90_000);

  it("gives a chat the popups its pages open (window.open, target=_blank)", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/" ? `<a href="/linked" target="_blank">open</a>` : `<title>${req.url?.slice(1)}</title>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${daemon.port}/cdp/pw-test?client=POPUP_A`);
    try {
      const page = await browser.contexts()[0].newPage();
      await page.goto(`${origin}/`);
      const [scripted] = await Promise.all([page.waitForEvent("popup", { timeout: 10_000 }), page.evaluate((u) => void window.open(u), `${origin}/scripted`)]);
      const [linked] = await Promise.all([page.waitForEvent("popup", { timeout: 10_000 }), page.click("a")]);
      expect(await scripted.title()).toBe("scripted"); // the chat drives both popups
      expect(await linked.title()).toBe("linked");
      const s = await page.context().newCDPSession(page);
      const { tabs } = (await s.send("Bridge.listAllTabs" as never)) as { tabs: Array<{ url: string; groupId: number }> };
      const groupOf = (path: string) => tabs.find((t) => t.url === `${origin}${path}`)?.groupId;
      expect(groupOf("/scripted"), JSON.stringify(tabs)).toBe(groupOf("/"));
      expect(groupOf("/linked"), JSON.stringify(tabs)).toBe(groupOf("/"));
      await Promise.all([scripted.close(), linked.close()]); // and can close them
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);

  it("refuses to hand one chat's tab to another chat", async () => {
    const cdp = (client: string) => chromium.connectOverCDP(`ws://127.0.0.1:${daemon.port}/cdp/pw-test?client=${client}`);
    const [a, b] = [await cdp("ADOPT_A"), await cdp("ADOPT_B")];
    try {
      const pageA = await a.contexts()[0].newPage();
      await pageA.goto("data:text/html,<title>adopt-a</title>");
      const pageB = await b.contexts()[0].newPage();
      const s = await pageB.context().newCDPSession(pageB);
      const { tabs } = (await s.send("Bridge.listAllTabs" as never)) as { tabs: Array<{ tabId: number; url: string }> };
      const tabOfA = tabs.find((t) => t.url.includes("adopt-a"));
      expect(tabOfA, JSON.stringify(tabs)).toBeDefined();
      await expect(s.send("Bridge.adoptTab" as never, { tabId: tabOfA?.tabId } as never)).rejects.toThrow(/belongs to chat "ADOPT_A"; pass fromChat/);
      expect(await pageA.title()).toBe("adopt-a"); // A still drives its tab
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);
});
