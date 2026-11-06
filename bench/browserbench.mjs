#!/usr/bin/env node
// browserbench flow against the bridge: node bench/browserbench.mjs [runs=50] [profile=pw-work]. Run on the Mac (the daemon is loopback).
// Runs whose page open takes over 1 s are printed to stderr with their time, to line up with daemon.log.
// Same flow as Steel's browserbench: connect -> goto google.com (domcontentloaded) -> release. "Create" is 0: the profile already runs.
// playwright-core comes from the installed app copy, which bin/ship.sh keeps.
const { chromium } = await import(`${process.env.HOME}/.claude-browser-bridge/app/node_modules/playwright-core/index.mjs`);
const N = Number(process.argv[2] || 50), prof = process.argv[3] || "pw-work";
const rows = [], fails = [];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout " + ms + "ms")), ms))]);
for (let i = 0; i < N; i++) {
  let browser, page; const t0 = performance.now(); let t1, t2, t3, tN;
  try {
    await withTimeout((async () => {
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:18765/cdp/${prof}?client=bench-${Date.now()}-${i}`); t1 = performance.now();
      page = await browser.contexts()[0].newPage(); tN = performance.now();
      await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 25000 }); t2 = performance.now();
      await page.close(); await browser.close(); t3 = performance.now();
    })(), 30000);
    if (t2 - tN > 1000) console.error(JSON.stringify({ i, at: new Date().toISOString(), nav: Math.round(t2 - tN), url: page.url() }));
    rows.push({ connect: t1 - t0, newtab: tN - t1, nav: t2 - tN, goto: t2 - t1, release: t3 - t2, total: t3 - t0 });
  } catch (e) {
    fails.push({ i, at: t2 ? "release" : t1 ? "goto" : "connect", err: e.message.split("\n")[0].slice(0, 90) });
    await page?.close().catch(() => {}); await browser?.close().catch(() => {});
  }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const st = (k) => { const a = rows.map(r => r[k]); return { avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length), median: Math.round(q(a, 0.5)), p95: Math.round(q(a, 0.95)), p99: Math.round(q(a, 0.99)) }; };
console.log(JSON.stringify({ profile: prof, runs: N, ok: rows.length, failed: fails.length, connect: st("connect"), goto: st("goto"), newtab: st("newtab"), nav: st("nav"), release: st("release"), total: st("total"), fails: fails.slice(0, 8) }, null, 1));
