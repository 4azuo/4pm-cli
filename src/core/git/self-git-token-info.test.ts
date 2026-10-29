/**
 * Tests for the self-managed login token info: GitHub scope / expiry headers and the GitLab self-info body.
 * @adr 0680
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubInfo, gitlabInfo } from "./self-git-token-info";

afterEach(() => vi.unstubAllGlobals());

describe("self git token info", () => {
  it("reads a GitHub token's scopes and expiry from the /user headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "x-oauth-scopes": "repo, admin:org", "github-authentication-token-expiration": "2026-12-01 10:00:00 UTC" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await githubInfo("github.com", "t")).toEqual({ tool: "gh", host: "github.com", expiresAt: "2026-12-01T10:00:00.000Z", scopes: ["repo", "admin:org"] });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/user", expect.anything());
  });

  it("treats a GitHub token without the expiry header as never expiring, and a refusal as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await githubInfo("ghe.acme.io", "t")).toEqual({ tool: "gh", host: "ghe.acme.io", expiresAt: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await githubInfo("github.com", "t")).toBeNull();
  });

  it("reads a GitLab token's expiry and scopes from personal_access_tokens/self", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ expires_at: "2027-01-31", scopes: ["api", "write_repository"] })));
    expect(await gitlabInfo("gitlab.com", "t")).toEqual({ tool: "glab", host: "gitlab.com", expiresAt: "2027-01-31T00:00:00.000Z", scopes: ["api", "write_repository"] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ expires_at: null, scopes: ["api"] })));
    expect(await gitlabInfo("git.acme.io", "t")).toMatchObject({ expiresAt: null });
  });
});
