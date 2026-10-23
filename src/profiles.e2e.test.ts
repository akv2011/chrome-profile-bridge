/**
 * Two profiles in one headful Chrome, the way the bridge drives the user's browser. Chrome's
 * Target.createTarget finds a regular profile's context only while it is the last-used profile, so a
 * chat on the other profile must still get its tab, in the right profile, without a slow relaunch.
 * Headful because a headless Chrome never hands a second launch to the running one. On Linux without
 * a display it starts Xvfb.
 */
import { type ChildProcess, spawn } from "node:child_process";
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
let xvfb: ChildProcess | undefined;
const servers: ChildProcess[] = [];

const mcp = (name: string, client: string) => mcpClient(`ws://127.0.0.1:${daemon.port}/cdp/${name}?client=${client}`, servers);

/** The profile directory the chat's current tab belongs to, read from chrome://version. */
const profileOf = async (call: Awaited<ReturnType<typeof mcp>>): Promise<string> => {
  await call("browser_navigate", { url: "chrome://version/" });
  return call("browser_evaluate", { function: "() => document.getElementById('profile_path')?.textContent" });
};

beforeAll(async () => {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    process.env.DISPLAY = `:${90 + Math.floor(Math.random() * 100)}`;
    xvfb = spawn("Xvfb", [process.env.DISPLAY, "-screen", "0", "1280x800x24"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1_000));
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-prof-home-"));
  udd = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-prof-udd-"));
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify({ "pw-a": "Default", "pw-b": "Profile 2", "pw-c": "Profile 3" }));
  daemon = await startDaemon({
    port: 0,
    extensionDir: path.join(import.meta.dirname, "..", "extension"),
    env: { ...process.env, CBB_HOME: home, CBB_CHROME_DIR: udd },
    pipe: { chromeBinary: chromium.executablePath(), userDataDir: udd, extraArgs: ["--no-first-run", "about:blank"] },
  });
}, 60_000);

afterAll(async () => {
  for (const p of servers) p.kill();
  await daemon?.close();
  xvfb?.kill();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(udd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("several profiles in one Chrome", () => {
  it("gives a chat its tab in its own profile while another profile is the last-used one", async () => {
    const a = await mcp("pw-a", "A1");
    expect(await profileOf(a)).toContain(path.join(udd, "Default"));
    const b = await mcp("pw-b", "B1");
    expect(await profileOf(b)).toContain(path.join(udd, "Profile 2"));

    // Profile 2 opened last, so Chrome now refuses Target.createTarget into Default's context.
    const a2 = await mcp("pw-a", "A2");
    const started = Date.now();
    expect(await profileOf(a2)).toContain(path.join(udd, "Default"));
    expect(Date.now() - started).toBeLessThan(5_000); // the old relaunch-and-guess took 8 s or more

    // And back the other way, on the chat that already has a tab.
    expect(await b("browser_tabs", { action: "new" })).not.toContain("ERROR");
    expect(await profileOf(b)).toContain(path.join(udd, "Profile 2"));
  }, 120_000);

  it("gives a new chat a working page after its profile's window closed and reopened", async () => {
    const cdp = (client: string) => chromium.connectOverCDP(`ws://127.0.0.1:${daemon.port}/cdp/pw-c?client=${client}`);
    const first = await cdp("REOPEN_1");
    const page1 = await first.contexts()[0].newPage();
    await page1.goto("data:text/html,<title>first</title>");
    // Closing the profile's only tab closes its window, so Chrome unloads the profile; the next chat
    // reopens it in a new context and the daemon rebuilds the profile's driver. REOPEN_1 keeps its tab
    // group through the reconnect grace.
    await page1.close();
    await first.close();
    await new Promise((r) => setTimeout(r, 3_000));

    const second = await cdp("REOPEN_2");
    try {
      const page2 = await second.contexts()[0].newPage();
      await page2.goto("data:text/html,<title>second</title>");
      expect(await page2.title()).toBe("second");
    } finally {
      await second.close();
    }
  }, 60_000);
});
