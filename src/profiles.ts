/**
 * Which Chrome profile an extension connection belongs to. The extension reports the profile's
 * signed-in email; Chrome's Local State maps email to profile dir; profiles.json (written by the
 * installer from the old pw-* configs) maps the dir to the name agents use, e.g. pw-example.
 * Both files are re-read on every lookup, so a new profile or account needs no restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function bridgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CBB_HOME || path.join(os.homedir(), ".chrome-profile-bridge");
}

export function chromeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CBB_CHROME_DIR || path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

/** name -> Chrome profile dir, e.g. { "pw-example": "Profile 42" }. */
export function loadProfiles(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(bridgeHome(env), "profiles.json"), "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return new Map();
  }
}

/** Chrome profile dir -> signed-in email, from Local State. */
export function chromeEmails(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(chromeDir(env), "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { user_name?: string }> };
    };
    const cache = state.profile?.info_cache ?? {};
    return new Map(
      Object.entries(cache)
        .filter(([, info]) => typeof info.user_name === "string" && info.user_name.length > 0)
        .map(([dir, info]) => [dir, (info.user_name as string).toLowerCase()]),
    );
  } catch {
    return new Map();
  }
}

/** The agent-facing name for a signed-in email; profiles missing from profiles.json still get one. */
export function profileNameForEmail(email: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const emails = chromeEmails(env);
  for (const [name, dir] of loadProfiles(env)) {
    if (emails.get(dir) === wanted) return name;
  }
  for (const [dir, address] of emails) {
    if (address === wanted) return `chrome-${dir.toLowerCase().replace(/\s+/g, "-")}`;
  }
  return null;
}

/** The Chrome profile dir behind an agent-facing name, for opening a closed profile. */
export function profileDirForName(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const known = loadProfiles(env).get(name);
  if (known) return known;
  for (const dir of chromeEmails(env).keys()) {
    if (`chrome-${dir.toLowerCase().replace(/\s+/g, "-")}` === name) return dir;
  }
  return null;
}
