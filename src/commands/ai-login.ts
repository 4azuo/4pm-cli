/**
 * `4pm ai-login` command (ADR-0199) — authenticate a profile's AI-CLI credential dir IN PLACE, so
 * an operator can log into claude/codex inside the container (the `in-container` credential posture)
 * without hunting for the right `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. For each configured, usable AI
 * profile it spawns the provider CLI interactively with that env var pointed at the profile's
 * resolved config dir (created if missing); the operator completes the provider's own login
 * (claude: `/login`; codex: its sign-in). `--ai <dir|index>` targets a single profile.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { readProfileConfig } from "../config/profile";
import { isUsableCredential, profileEnvVar, resolveHomePath } from "../utils/ai-cli";
import type { AiCredential } from "../utils/ai-cli";

/** Spawn one provider CLI interactively with its config-dir env var set; resolve on exit. */
function runProviderLogin(cmd: string, envVar: string, dir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [], {
      stdio: "inherit",
      env: { ...process.env, [envVar]: dir },
    });
    child.on("error", (err) => {
      console.error(`  ✖ Could not launch \`${cmd}\` — is it installed? (${(err as Error).message})`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * Authenticate the AI credential dir(s) of a linked profile. `aiFilter` (from `--ai`) narrows to a
 * single credential by its profile dir name or its 1-based index in the list.
 */
export async function runAiLogin(
  profileDir: string,
  profileName: string,
  aiFilter: string | null,
): Promise<void> {
  const config = readProfileConfig(profileDir);
  const credentials: AiCredential[] = (config.aiProfiles ?? []).filter(isUsableCredential);
  if (credentials.length === 0) {
    console.log(
      `Profile "${profileName}" has no usable AI profiles configured — add one in the web Worker configs or config.json.`,
    );
    return;
  }
  // Narrow to a single credential when `--ai` is given (match the profile dir name or a 1-based index).
  const selected = aiFilter
    ? credentials.filter(
        (c, i) => c.profile === aiFilter || basename(resolveHomePath(c.profile)) === aiFilter || String(i + 1) === aiFilter,
      )
    : credentials;
  if (selected.length === 0) {
    console.log(`No AI profile matches --ai "${aiFilter}". Available: ${credentials.map((c) => c.profile).join(", ")}`);
    return;
  }

  for (const cred of selected) {
    const envVar = profileEnvVar(cred.provider);
    if (!envVar) {
      console.log(`- Skipping ${cred.provider} "${cred.profile}" — no known credential dir for this provider.`);
      continue;
    }
    const dir = resolveHomePath(cred.profile);
    mkdirSync(dir, { recursive: true });
    console.log(`\n▶ Logging in ${cred.provider} · ${cred.profile} (${envVar}=${dir})`);
    console.log(`  Complete the provider's own sign-in (claude: type \`/login\`; codex: follow its prompt), then exit.`);
    const code = await runProviderLogin(cred.provider, envVar, dir);
    console.log(code === 0 ? `  ✔ ${cred.provider} "${cred.profile}" session updated.` : `  ⚠ ${cred.provider} exited with code ${code}.`);
  }
  console.log(
    `\nTip: for the credentials to survive \`docker rm\`/recreate, keep each profile path under the mounted volume (e.g. \`~/.4pm/ai/<name>\`) — ADR-0199.`,
  );
}
