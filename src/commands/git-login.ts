/**
 * `4pm git-login <gh|glab> [args…]` command — log the worker's own GitHub / GitLab CLI in, as the cli user,
 * into its login dir (`GH_CONFIG_DIR` / `GLAB_CONFIG_DIR`; the worker image defaults them to `~/.4pm/gh|glab`
 * in the persistent volume). In a container `docker exec -it <c> 4pm git-login gh` goes through the image
 * launcher and so runs as `node`; a bare `docker exec <c> gh auth login` would run as a capability-less root
 * that cannot write the cli's home. The login serves Self-managed git auth. Extra args are passed
 * to `gh auth login` / `glab auth login` (e.g. `--hostname ghe.example.com`).
 * @adr 0487 §4 @adr 0467
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { initI18n, t } from "../i18n";

/** The tools this command logs in, with the env var that names each one's login dir. */
const TOOLS = { gh: "GH_CONFIG_DIR", glab: "GLAB_CONFIG_DIR" } as const;

/** Token env vars that would make the tool skip or shadow the interactive login. */
const TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GLAB_TOKEN"];

/**
 * Run the provider's interactive login with the cli user's login dir; resolves the tool's exit code.
 */
export async function runGitLogin(tool: string | undefined, args: string[]): Promise<number> {
  initI18n();
  if (tool !== "gh" && tool !== "glab") {
    console.error(t("gitLogin.usage"));
    return 2;
  }
  const envVar = TOOLS[tool];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of TOKEN_ENV) delete env[k];
  const dir = env[envVar];
  if (dir) {
    // Owner-only: the login holds a long-lived token (cli-fs 0002).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  console.log(t("gitLogin.loggingIn", { tool, dir: dir ?? t("gitLogin.defaultDir") }));
  const code = await new Promise<number>((resolve) => {
    const child = spawn(tool, ["auth", "login", ...args], { stdio: "inherit", env });
    child.on("error", (err) => {
      console.error(t("gitLogin.launchFailed", { tool, message: (err as Error).message }));
      resolve(1);
    });
    child.on("exit", (c) => resolve(c ?? 0));
  });
  console.log(code === 0 ? t("gitLogin.done", { tool }) : t("gitLogin.exited", { tool, code }));
  return code;
}
