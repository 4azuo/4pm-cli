/**
 * Tests for the git credential pre-check's error classification: credential refusals (GitHub / GitLab push and
 * fetch messages, the App workflow refusal) fail the check, network and local errors do not.
 * @adr 0661
 */
import { describe, expect, it } from "vitest";
import { isGitAccessError } from "./autonomous-git-access";

describe("isGitAccessError", () => {
  it("flags credential refusals", () => {
    for (const msg of [
      "remote: Permission to acme/app.git denied to 4pm-worker[bot]. fatal: unable to access: The requested URL returned error: 403",
      "remote: You are not allowed to push code to this project.",
      "fatal: Authentication failed for 'https://gitlab.com/acme/app.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "remote: Repository not found. fatal: repository 'https://github.com/acme/rc-design.git/' not found",
      "! [remote rejected] HEAD -> dev/main/G7/T-121 (refusing to allow a GitHub App to create or update workflow `.github/workflows/lint.yml` without `workflows` permission)",
      "remote: Write access to repository not granted.",
    ]) {
      expect(isGitAccessError(msg)).toBe(true);
    }
  });

  it("ignores network and local problems", () => {
    for (const msg of [
      "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Connection timed out",
      "error: failed to push some refs (non-fast-forward)",
      "fatal: not a git repository (or any of the parent directories): .git",
    ]) {
      expect(isGitAccessError(msg)).toBe(false);
    }
  });
});
