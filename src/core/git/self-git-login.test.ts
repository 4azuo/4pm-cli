/**
 * Tests for the Self-managed git login discovery: host parsing of gh `hosts.yml` / glab `config.yml`.
 * @adr 0467
 */
import { describe, expect, it } from "vitest";
import { ghHostsOf, glabHostsOf } from "./self-git-login";

describe("ghHostsOf", () => {
  it("lists the top-level host keys", () => {
    const yaml = [
      "github.com:",
      "    users:",
      "        alice:",
      "            oauth_token: gho_x",
      "    git_protocol: https",
      "    user: alice",
      "ghe.example.com:",
      "    user: bob",
    ].join("\n");
    expect(ghHostsOf(yaml)).toEqual(["github.com", "ghe.example.com"]);
  });

  it("returns nothing for an empty file", () => {
    expect(ghHostsOf("")).toEqual([]);
  });
});

describe("glabHostsOf", () => {
  it("lists the keys one level under hosts:", () => {
    const yaml = [
      "git_protocol: ssh",
      "hosts:",
      "  gitlab.com:",
      "    token: glpat-x",
      "    api_protocol: https",
      "  gitlab.example.com:8443:",
      "    token: ''",
      "editor: vim",
    ].join("\n");
    expect(glabHostsOf(yaml)).toEqual(["gitlab.com", "gitlab.example.com:8443"]);
  });

  it("ignores a config without hosts", () => {
    expect(glabHostsOf("git_protocol: https\n")).toEqual([]);
  });
});
