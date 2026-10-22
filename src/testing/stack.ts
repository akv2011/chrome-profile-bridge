/**
 * The whole bridge stack for end-to-end tests: a local site, a real headless Chromium, the
 * daemon, and the CDP-backed stand-in for the extension, wired as profile "pw-test".
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { extensionIdFromKey, startDaemon } from "../daemon.ts";
import { startCdpExtension } from "./cdp-extension.ts";

export const extensionDir = path.join(import.meta.dirname, "..", "..", "extension");

export async function startStack() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8")) as { key: string };
  const origin = `chrome-extension://${extensionIdFromKey(manifest.key)}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-e2e-"));
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify({ "pw-test": "Profile 9" }));
  fs.mkdirSync(path.join(home, "chrome"));
  fs.writeFileSync(
    path.join(home, "chrome", "Local State"),
    JSON.stringify({ profile: { info_cache: { "Profile 9": { user_name: "tester@example.com" } } } }),
  );

  const site = http.createServer((req, res) => {
    if (req.url === "/api") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "sid=abc123; Path=/" });
    res.end(`<title>Bridge test</title><button onclick="fetch('/api').then(r=>r.json()).then(j=>document.body.dataset.api=j.ok)">Go</button>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const chrome: ChildProcess = spawn(
    chromium.executablePath(),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(home, "profile")}`, "--no-first-run", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const browserWs = await new Promise<string>((resolve, reject) => {
    let err = "";
    chrome.stderr?.on("data", (chunk) => {
      err += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (match) resolve(match[1]);
    });
    chrome.once("exit", (code) => reject(new Error(`chromium exited ${code}: ${err}`)));
  });

  const opened: string[] = [];
  const daemon = await startDaemon({
    port: 0,
    extensionDir,
    env: { ...process.env, CBB_HOME: home, CBB_CHROME_DIR: path.join(home, "chrome") },
    openProfile: (dir) => opened.push(dir),
    extensionWaitMs: 3000,
  });
  const ext = await startCdpExtension({ daemonPort: daemon.port, origin, browserWs, email: "Tester@Example.com" });
  for (let i = 0; i < 50 && !daemon.bridges.get("pw-test")?.extensionConnected; i++) await new Promise((r) => setTimeout(r, 20));

  return {
    home,
    daemon,
    siteUrl,
    opened,
    cdpUrl: (client: string, profile = "pw-test") => `ws://127.0.0.1:${daemon.port}/cdp/${profile}?client=${client}`,
    close: async () => {
      ext.close();
      await daemon.close();
      chrome.kill();
      site.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
