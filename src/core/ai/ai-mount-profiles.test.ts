/**
 * Tests for the mounted-login helpers: the `machine.status.aiMounts` report and switching off the seeded
 * defaults that hold no login. `HOME` points at a temp dir so `~/ai-creds` is fake.
 * @adr 0479
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableUnloggedDefaults, mountedAiLogins } from "./ai-mount-profiles";

let home: string;
let profileDir: string;
const savedHome = process.env.HOME;

/** Create a mounted login folder under the fake `~/ai-creds`. */
function mount(folder: string, files: Record<string, string>): void {
  const dir = join(home, "ai-creds", folder);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

/** Write the worker profile's config.json. */
function writeConfig(config: unknown): void {
  writeFileSync(join(profileDir, "config.json"), JSON.stringify(config));
}

/** Read the worker profile's config.json back. */
function readConfig(): { aiProfiles?: { profile: string; enabled?: boolean }[] } {
  return JSON.parse(readFileSync(join(profileDir, "config.json"), "utf8")) as { aiProfiles?: { profile: string; enabled?: boolean }[] };
}

const DEFAULTS = {
  aiProfiles: [
    { provider: "claude", profile: ".claude", args: [], model: "sonnet" },
    { provider: "codex", profile: ".codex", args: [], model: "" },
    { provider: "claude", profile: "ai-creds/claude-claude-1", args: [], model: "sonnet" },
  ],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "4pm-mount-"));
  process.env.HOME = home;
  profileDir = join(home, ".4pm", "profiles", "p");
  mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("mountedAiLogins", () => {
  it("lists only the mounted folders holding a login, with the claude email", () => {
    mount("claude-claude-1", { ".credentials.json": "{}", ".claude.json": JSON.stringify({ oauthAccount: { emailAddress: "a@x.io" } }) });
    mount("claude-empty", {});
    mount("codex-work", { "auth.json": "{}" });
    expect(mountedAiLogins()).toEqual([
      { provider: "claude", profile: "ai-creds/claude-claude-1", account: "a@x.io" },
      { provider: "codex", profile: "ai-creds/codex-work" },
    ]);
  });

  it("is empty without ~/ai-creds", () => {
    expect(mountedAiLogins()).toEqual([]);
  });
});

describe("disableUnloggedDefaults", () => {
  it("does nothing when no login is mounted", () => {
    writeConfig(DEFAULTS);
    expect(disableUnloggedDefaults(profileDir)).toEqual([]);
    expect(readConfig().aiProfiles?.every((p) => p.enabled !== false)).toBe(true);
  });

  it("switches off the unlogged defaults once a login is mounted", () => {
    mount("claude-claude-1", { ".credentials.json": "{}" });
    writeConfig(DEFAULTS);
    expect(disableUnloggedDefaults(profileDir)).toEqual([".claude", ".codex"]);
    const byDir = Object.fromEntries((readConfig().aiProfiles ?? []).map((p) => [p.profile, p.enabled]));
    expect(byDir).toEqual({ ".claude": false, ".codex": false, "ai-creds/claude-claude-1": undefined });
  });

  it("keeps a default that holds a login or uses an API key", () => {
    mount("claude-claude-1", { ".credentials.json": "{}" });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    writeConfig({
      aiProfiles: [
        { provider: "claude", profile: ".claude", args: [], model: "" },
        { provider: "codex", profile: ".codex", args: [], model: "", apiKey: { source: "inline", value: "k" } },
      ],
    });
    expect(disableUnloggedDefaults(profileDir)).toEqual([]);
  });

  it("does not switch a re-enabled default off again", () => {
    mount("claude-claude-1", { ".credentials.json": "{}" });
    writeConfig(DEFAULTS);
    disableUnloggedDefaults(profileDir);
    writeConfig(DEFAULTS); // the operator re-enables both
    expect(disableUnloggedDefaults(profileDir)).toEqual([]);
    expect(readConfig().aiProfiles?.every((p) => p.enabled !== false)).toBe(true);
  });
});
