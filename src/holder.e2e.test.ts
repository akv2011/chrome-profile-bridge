import type { ChildProcess } from "node:child_process";
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
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(udd, { recursive: true, force: true });
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
});
