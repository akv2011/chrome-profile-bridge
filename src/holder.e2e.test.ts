import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon } from "./daemon.ts";
import { startHolder } from "./holder.ts";
import { HEAP_SNAPSHOT_CODE, heapBytes, mcpClient } from "./testing/mcp-client.ts";

let home = "";
let udd = "";
let holder: ReturnType<typeof startHolder>;
const procs: ChildProcess[] = [];

const daemonOn = (socketPath: string) =>
  startDaemon({
    port: 0,
    extensionDir: path.join(import.meta.dirname, "..", "extension"),
    env: { ...process.env, CBB_HOME: home, CBB_CHROME_DIR: udd },
    pipe: { chromeBinary: chromium.executablePath(), userDataDir: udd, socketPath },
  });

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-holder-home-"));
  udd = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-holder-udd-"));
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify({ "pw-test": "Default" }));
  holder = startHolder({
    chromeBinary: chromium.executablePath(),
    userDataDir: udd,
    socketPath: path.join(home, "chrome.sock"),
    extraArgs: ["--headless=new", "about:blank"],
  });
});

afterAll(() => {
  for (const p of procs) p.kill();
  holder?.close();
  // Chrome is still writing its profile while it exits; rmSync retries ENOTEMPTY.
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(udd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("holder: the daemon restarts, Chrome does not", () => {
  it("keeps the same Chrome across a daemon restart, with full access before and after", async () => {
    const sock = path.join(home, "chrome.sock");
    const alive = () => { try { process.kill(holder.chromePid as number, 0); return true; } catch { return false; } };

    const first = await daemonOn(sock);
    const a = await mcpClient(`ws://127.0.0.1:${first.port}/cdp/pw-test?client=H1`, procs);
    expect(await a("browser_navigate", { url: "https://example.com/" })).toContain("Example Domain");
    expect(heapBytes(await a("browser_run_code_unsafe", { code: HEAP_SNAPSHOT_CODE }))).toBeGreaterThan(0);

    // The update path: the old daemon goes away, a new one (new code) comes up on the same holder.
    for (const p of procs.splice(0)) p.kill();
    await first.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(), "Chrome must survive the daemon exiting").toBe(true);

    const second = await daemonOn(sock);
    const b = await mcpClient(`ws://127.0.0.1:${second.port}/cdp/pw-test?client=H2`, procs);
    expect(await b("browser_navigate", { url: "https://example.com/?after" })).toContain("Example Domain");
    expect(heapBytes(await b("browser_run_code_unsafe", { code: HEAP_SNAPSHOT_CODE }))).toBeGreaterThan(0);
    expect(alive()).toBe(true);
    await second.close();
  }, 120_000);

  it("leaves a quit Chrome closed until a chat needs a profile, then starts it again", async () => {
    const sock = path.join(home, "chrome.sock");
    const first = holder.chromePid as number;
    for (const p of procs.splice(0)) p.kill();
    process.kill(first); // stands in for Cmd+Q
    for (let i = 0; i < 40 && fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 250));
    expect(fs.existsSync(sock), "the Chrome socket goes with Chrome").toBe(false);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(holder.chromePid, "nothing reopens a quit Chrome on its own").toBeUndefined();

    const daemon = await daemonOn(sock); // a daemon (re)start with Chrome closed must not open it
    await new Promise((r) => setTimeout(r, 1_000));
    expect(holder.chromePid).toBeUndefined();

    const c = await mcpClient(`ws://127.0.0.1:${daemon.port}/cdp/pw-test?client=H3`, procs);
    expect(await c("browser_navigate", { url: "https://example.com/?reopened" })).toContain("Example Domain");
    expect(holder.chromePid).toBeGreaterThan(0);
    expect(holder.chromePid).not.toBe(first);
    await daemon.close();
  }, 120_000);

  it("quits a Chrome started without the pipe and reopens it through the holder", async () => {
    const sock = path.join(home, "chrome.sock");
    for (const p of procs.splice(0)) p.kill();
    process.kill(holder.chromePid as number);
    for (let i = 0; i < 40 && fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 250));
    expect(holder.chromePid).toBeUndefined();

    // Stands in for Chrome opened from the Dock: same binary and data dir, no pipe.
    const stray = spawn(chromium.executablePath(), [`--user-data-dir=${udd}`, "--headless=new", "--no-first-run", "about:blank"], { stdio: "ignore" });
    const strayExit = new Promise((r) => stray.on("exit", r));
    for (let i = 0; i < 80 && !holder.chromePid; i++) await new Promise((r) => setTimeout(r, 250));
    await strayExit;
    expect(holder.chromePid, "the holder reopened Chrome on the pipe").toBeGreaterThan(0);
    expect(holder.chromePid).not.toBe(stray.pid);
    for (let i = 0; i < 20 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 250));
    expect(fs.existsSync(sock)).toBe(true);
  }, 60_000);
});
