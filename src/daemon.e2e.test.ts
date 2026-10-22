import fs from "node:fs";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { fanout } from "./fanout.ts";
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

  it("Bridge.setFastLoad blocks matching requests on this chat's tabs", async () => {
    const browser = await connect("E2E_FAST");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const probe = () => page.evaluate((u) => fetch(u).then(() => "ok", () => "blocked"), `${stack.siteUrl}asset.png`);
    expect(await probe()).toBe("ok");
    const res = (await cdp.send("Bridge.setFastLoad" as "Network.enable", { groups: ["image"] } as object)) as { blocked: number };
    expect(res.blocked).toBeGreaterThan(0);
    expect(await probe()).toBe("blocked");
    await cdp.send("Bridge.setFastLoad" as "Network.enable", { groups: [], urls: [] } as object);
    expect(await probe()).toBe("ok");
  }, 60_000);

  it("Bridge.snapshot returns a lean interactive tree, and diffs it", async () => {
    const browser = await connect("E2E_SNAP");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const first = (await cdp.send("Bridge.snapshot" as "Network.enable", {} as object)) as { nodes: Array<{ role: string; name: string }> };
    expect(first.nodes).toContainEqual(expect.objectContaining({ role: "button", name: "Go" }));
    expect(first.nodes.length).toBeLessThan(10); // lean, not the whole page
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<button id="x">Added</button>'));
    const diff = (await cdp.send("Bridge.snapshot" as "Network.enable", { diff: true } as object)) as { added: Array<{ name: string }>; removed: unknown[] };
    expect(diff.added).toContainEqual(expect.objectContaining({ name: "Added" }));
  }, 60_000);

  it("Bridge.act clicks an element by snapshot id and confirms the page changed", async () => {
    const browser = await connect("E2E_ACT");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const snap = (await cdp.send("Bridge.snapshot" as "Network.enable", {} as object)) as { nodes: Array<{ id: number; name: string }> };
    const go = snap.nodes.find((n) => n.name === "Go");
    expect(go).toBeTruthy();
    const res = (await cdp.send("Bridge.act" as "Network.enable", { id: go!.id, action: "click" } as object)) as { changed: boolean };
    expect(res.changed).toBe(true);
    await page.waitForFunction(() => document.body.dataset.api === "true");
  }, 60_000);

  it("Bridge.timeline records a numbered step with a screenshot", async () => {
    const browser = await connect("E2E_TIMELINE");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const cap = (await cdp.send("Bridge.timelineCapture" as "Network.enable", { label: "start" } as object)) as { n: number };
    expect(cap.n).toBe(1);
    const tl = (await cdp.send("Bridge.timeline" as "Network.enable", {} as object)) as { entries: Array<{ label: string; screenshot: string | null }> };
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0].label).toBe("start");
    expect(fs.existsSync(path.join(stack.home, "timeline", "E2E_TIMELINE", tl.entries[0].screenshot as string))).toBe(true);
  }, 60_000);

  it("Bridge.health reports the signed-in profile", async () => {
    const browser = await connect("E2E_HEALTH");
    const context = browser.contexts()[0];
    const cdp = await context.newCDPSession(await context.newPage());
    const h = (await cdp.send("Bridge.health" as "Network.enable", {} as object)) as { email: string; signedIn: boolean };
    expect(h.signedIn).toBe(true);
    expect(h.email).toMatch(/tester@example\.com/i);
  }, 60_000);

  it("Bridge.har logs requests and Bridge.downloads catches a file", async () => {
    const browser = await connect("E2E_NET");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(stack.siteUrl);
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForFunction(() => document.body.dataset.api === "true");
    const har = (await cdp.send("Bridge.har" as "Network.enable", {} as object)) as { entries: Array<{ url: string; status: number | null }> };
    expect(har.entries.some((e) => e.url.endsWith("/api") && e.status === 200)).toBe(true);

    const dd = (await cdp.send("Bridge.setDownloadDir" as "Network.enable", {} as object)) as { dir: string };
    expect(dd.dir).toBeTruthy();
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/download";
      a.download = "f.txt";
      document.body.appendChild(a);
      a.click();
    });
    let files: string[] = [];
    for (let i = 0; i < 20 && files.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      files = ((await cdp.send("Bridge.downloads" as "Network.enable", {} as object)) as { files: string[] }).files;
    }
    expect(files).toContain("f.txt");
  }, 60_000);

  it("Bridge.requestHuman pings once and resolves when the agent's condition comes true", async () => {
    const browser = await connect("E2E_HUMAN");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const before = stack.notifications.length;
    await page.evaluate(() => setTimeout(() => ((window as unknown as { __solved: boolean }).__solved = true), 1000));
    const res = (await cdp.send("Bridge.requestHuman" as "Network.enable", { reason: "solve the captcha", until: "window.__solved===true", timeoutMs: 8000 } as object)) as { pinged: boolean; solved: boolean };
    expect(res.solved).toBe(true);
    expect(stack.notifications.length).toBe(before + 1);
    expect(stack.notifications.at(-1)).toContain("solve the captcha");

    const timed = (await cdp.send("Bridge.requestHuman" as "Network.enable", { reason: "x", until: "false", timeoutMs: 1500 } as object)) as { solved: boolean };
    expect(timed.solved).toBe(false);
  }, 60_000);

  it("Bridge.saveSecret + typeSecret fill a field without the agent seeing the value", async () => {
    const browser = await connect("E2E_SECRET");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<input aria-label="Password" id="pw">'));
    const cdp = await context.newCDPSession(page);
    const snap = (await cdp.send("Bridge.snapshot" as "Network.enable", {} as object)) as { nodes: Array<{ id: number; name: string }> };
    const input = snap.nodes.find((n) => n.name === "Password")!;
    const saved = (await cdp.send("Bridge.saveSecret" as "Network.enable", { service: "cbb-test", account: "alice" } as object)) as Record<string, unknown>;
    expect(saved).toEqual({ saved: true, generated: true });
    const typed = (await cdp.send("Bridge.typeSecret" as "Network.enable", { id: input.id, service: "cbb-test", account: "alice" } as object)) as Record<string, unknown>;
    expect(typed).toEqual({ typed: true });
    const value = await page.evaluate(() => (document.getElementById("pw") as HTMLInputElement).value);
    expect(value.length).toBeGreaterThanOrEqual(16); // a strong generated secret landed in the field
    expect(JSON.stringify(saved) + JSON.stringify(typed)).not.toContain(value); // value never crossed the wire
  }, 60_000);

  it("Bridge.extract returns in-page data as JSON", async () => {
    const browser = await connect("E2E_EXTRACT");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const ex = (await cdp.send("Bridge.extract" as "Network.enable", { expression: "[...document.querySelectorAll('button')].map(b=>b.textContent)" } as object)) as { value: string[] };
    expect(ex.value).toContain("Go");
  }, 60_000);

  it("Bridge.marks lists interactive elements with click coordinates", async () => {
    const browser = await connect("E2E_MARKS");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(stack.siteUrl);
    const cdp = await context.newCDPSession(page);
    const m = (await cdp.send("Bridge.marks" as "Network.enable", {} as object)) as { marks: Array<{ name: string; x: number; y: number }> };
    const go = m.marks.find((mk) => mk.name === "Go");
    expect(go).toBeTruthy();
    expect(go!.x).toBeGreaterThan(0);
  }, 60_000);

  it("fanout runs a snippet across profiles and isolates failures", async () => {
    const ok = await fanout({ names: ["pw-test"], url: stack.siteUrl, expression: "document.title", port: stack.daemon.port });
    expect(ok).toEqual([{ name: "pw-test", value: "Bridge test" }]);
    const mixed = await fanout({ names: ["pw-test", "pw-nope"], expression: "1+1", port: stack.daemon.port });
    expect(mixed.find((r) => r.name === "pw-test")?.value).toBe(2);
    expect(mixed.find((r) => r.name === "pw-nope")?.error).toBeTruthy();
  }, 60_000);

  it("Bridge.record + replay reruns a flow deterministically", async () => {
    const browser = await connect("E2E_REC");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Bridge.record" as "Network.enable", { name: "go-flow" } as object);
    await page.goto(stack.siteUrl);
    const snap = (await cdp.send("Bridge.snapshot" as "Network.enable", {} as object)) as { nodes: Array<{ id: number; name: string }> };
    const go = snap.nodes.find((n) => n.name === "Go")!;
    await cdp.send("Bridge.act" as "Network.enable", { id: go.id, action: "click" } as object);
    const stop = (await cdp.send("Bridge.stopRecording" as "Network.enable", {} as object)) as { saved: boolean; steps: number };
    expect(stop).toMatchObject({ saved: true, steps: 2 });

    await page.goto("about:blank");
    const rep = (await cdp.send("Bridge.replay" as "Network.enable", { name: "go-flow" } as object)) as { replayed: number };
    expect(rep.replayed).toBe(2);
    await page.waitForFunction(() => document.body.dataset.api === "true");
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
