/**
 * Env var names shared by the daemon and the standalone agent helper (git credential helper, `gh` / `glab`
 * shim token source). Kept dependency-free so the helper bundle stays small and self-contained.
 * @adr 0356 @adr 0499
 */

/** Env var carrying the job scope to the helper / shim (set per dispatched process). */
export const JOB_ID_ENV = "FOURPM_JOB_ID";
/** Env var telling the helper / shim which profile's control socket to ask. */
export const PROFILE_DIR_ENV = "FOURPM_PROFILE_DIR";
/** Env vars naming the App host + its kind (read by the shim + the `git-token` helper). */
export const GIT_HOST_ENV = "FOURPM_GIT_HOST";
export const GIT_HOST_KIND_ENV = "FOURPM_GIT_HOST_KIND";
/** Env var naming the git-token socket for the helper / shims (allow-listed into agent processes). */
export const GIT_TOKEN_SOCKET_ENV = "FOURPM_GIT_TOKEN_SOCKET";
