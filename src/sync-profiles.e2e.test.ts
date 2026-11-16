import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Runs the real bin/sync-profiles.sh against a fake HOME. Only the outside world is stubbed: `claude`
// (logs its args, reads its stdin) and `uname` (so it runs on Linux CI too).
const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpb-sync-profiles-"));
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, "ChromeData"));
  fs.mkdirSync(path.join(home, ".chrome-profile-bridge"));
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("uname", "echo Darwin");
  stub("claude", `echo "$*" >> "$HOME/claude.log"; cat > /dev/null; [ "$2" = get ] && exit 1; exit 0`);
  const info = (user_name: string) => ({ user_name });
  fs.writeFileSync(
    path.join(home, "ChromeData", "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          "Profile 1": info("a@alpha.com"),
          "Profile 2": info("c@gamma.net"),
          "Profile 3": info("b@beta.org"),
          "Profile 4": info(""),
        },
      },
    }),
  );
  const run = (...args: string[]) =>
    execFileSync("bash", [path.join(import.meta.dirname, "..", "bin", "sync-profiles.sh"), ...args], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  const read = (file: string) => (fs.existsSync(path.join(home, file)) ? fs.readFileSync(path.join(home, file), "utf8") : "");
  return { home, run, read };
};

// A shared Chrome holds other people's accounts, so a run with no argument only lists what it could add.
it("lists candidates and registers nothing when no profile is named", () => {
  const { home, run, read } = setup();
  const out = run();
  expect(out).toContain("Profile 1\ta@alpha.com");
  expect(out).toContain("Profile 2\tc@gamma.net\tpw-gamma");
  expect(read(".chrome-profile-bridge/profiles.json")).toBe("");
  expect(read("claude.log")).toBe("");
  fs.rmSync(home, { recursive: true, force: true });
});

it("registers every named profile in one run, and only those", () => {
  const { home, run, read } = setup();
  const out = run("Profile 1", "Profile 3");
  expect(JSON.parse(read(".chrome-profile-bridge/profiles.json")), out).toEqual({ "pw-alpha": "Profile 1", "pw-beta": "Profile 3" });
  const adds = read("claude.log").split("\n").filter((l) => l.startsWith("mcp add"));
  expect(adds.map((l) => l.split(" ")[2])).toEqual(["pw-alpha", "pw-beta"]);
  fs.rmSync(home, { recursive: true, force: true });
});
