import fs from "node:fs";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startStack } from "./testing/stack.ts";

let stack: Awaited<ReturnType<typeof startStack>>;
const browsers: Browser[] = [];

const connect = async (client: string) => {
  const browser = await chromium.connectOverCDP(stack.cdpUrl(client));
  browsers.push(browser);
  return browser;
};

/** Upgrade status a raw WebSocket handshake gets, or "open". */
function handshake(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    ws.once("error", () => resolve("error"));
  });
}

beforeAll(async () => {
  stack = await startStack();
}, 60_000);

afterAll(async () => {
  for (const browser of browsers) await browser.close().catch(() => {});
  await stack?.close();
});

describe("daemon end to end with real Playwright", () => {
  it("matches the extension to its profile by signed-in email", () => {
    expect(stack.daemon.bridges.get("pw-test")?.identity?.email).toBe("Tester@Example.com");
  });

  it("drives a page: navigate, click, network, cookies, raw CDP", async () => {
    const browser = await connect("E2E_A");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(stack.siteUrl);
    expect(await page.title()).toBe("Bridge test");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForFunction(() => document.body.dataset.api === "true");
    expect(requests).toContain("/api");

    const cdp = await context.newCDPSession(page);
    const { cookies } = (await cdp.send("Network.getAllCookies")) as { cookies: Array<{ name: string; value: string }> };
    expect(cookies).toContainEqual(expect.objectContaining({ name: "sid", value: "abc123" }));
    await cdp.send("Performance.enable");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: unknown[] };
    expect(metrics.length).toBeGreaterThan(0);
    expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: "sid", value: "abc123" }));
  }, 60_000);

  it("keeps two chats on one profile in separate tabs", async () => {
    const a = await connect("E2E_A2");
    const b = await connect("E2E_B");
    const pageA = await a.contexts()[0].newPage();
    const pageB = await b.contexts()[0].newPage();
    await Promise.all([pageA.goto(`${stack.siteUrl}?a`), pageB.goto(`${stack.siteUrl}?b`)]);
    expect(a.contexts()[0].pages().map((p) => p.url())).toEqual([`${stack.siteUrl}?a`]);
    expect(b.contexts()[0].pages().map((p) => p.url())).toEqual([`${stack.siteUrl}?b`]);
  }, 60_000);

  it("gives a reconnecting chat its open tab back", async () => {
    const first = await connect("E2E_R");
    await (await first.contexts()[0].newPage()).goto(`${stack.siteUrl}?r`);
    await first.close();
    const again = await connect("E2E_R");
    expect(again.contexts()[0].pages().map((p) => p.url())).toEqual([`${stack.siteUrl}?r`]);
  }, 60_000);

  it("keeps web pages out", async () => {
    const port = stack.daemon.port;
    expect(await handshake(stack.cdpUrl("Evil"), { Origin: "https://evil.test" })).toBe("403");
    expect(await handshake(`ws://127.0.0.1:${port}/ext`, { Origin: "https://evil.test" })).toBe("403");
    expect(await handshake(`ws://127.0.0.1:${port}/ext`, {})).toBe("403");
    expect(await handshake(stack.cdpUrl("Rebind"), { Host: "evil.test" })).toBe("403");
    const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: "https://evil.test" } });
    expect(status.status).toBe(403);
    const ok = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { profiles: Record<string, unknown> };
    expect(Object.keys(ok.profiles)).toContain("pw-test");
  });

  it("opens a closed profile for a waiting chat, then fails it clearly", async () => {
    fs.writeFileSync(path.join(stack.home, "profiles.json"), JSON.stringify({ "pw-test": "Profile 9", "pw-closed": "Profile 3" }));
    const started = Date.now();
    const error = await chromium.connectOverCDP(stack.cdpUrl("Waiter", "pw-closed")).catch((e: Error) => e);
    expect(stack.opened).toEqual(["Profile 3"]);
    expect(String(error)).toMatch(/pw-closed: Chrome did not connect/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
