/**
 * Run one snippet across several profiles at once, through the daemon. Each profile is driven as its
 * own CDP client, in parallel, and the results come back keyed by profile. Used by bin/cbb-fanout.
 */
import { chromium, type Page } from "playwright-core";

export type FanoutResult = { name: string; value?: unknown; error?: string };

/** For each profile: connect, optionally navigate, evaluate `expression`, return its value. */
export async function fanout(opts: { names: string[]; expression: string; url?: string; port?: number; host?: string }): Promise<FanoutResult[]> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 18765;
  return Promise.all(
    opts.names.map(async (name): Promise<FanoutResult> => {
      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
      let page: Page | null = null;
      try {
        browser = await chromium.connectOverCDP(`ws://${host}:${port}/cdp/${encodeURIComponent(name)}?client=fanout-${name}`);
        page = await browser.contexts()[0].newPage();
        if (opts.url) await page.goto(opts.url);
        return { name, value: await page.evaluate(opts.expression) };
      } catch (e) {
        return { name, error: e instanceof Error ? e.message : String(e) };
      } finally {
        // Disconnecting leaves the tab open in the profile for the reconnect window, so close it first.
        await page?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
    }),
  );
}
