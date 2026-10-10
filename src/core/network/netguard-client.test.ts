/**
 * Tests for the kernel side of the egress policy: only IP/CIDR rules go to the kernel, an idle cli is
 * held to Enforce with the org denylist, and RAG jobs get their fixed hosts on top of the project policy.
 * @adr 0439
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ipRules } from "./netguard-client";
import { kernelEgress, policyFor, resetEgressStateForTest, setNetworkPolicy } from "./egress-state";

beforeEach(() => resetEgressStateForTest());

describe("kernel egress", () => {
  it("keeps only IP / CIDR rules", () => {
    expect(ipRules([{ target: "pypi.org", port: 443 }, { target: "10.0.4.0/24", port: 5432 }, { target: "1.2.3.4", port: null }])).toEqual([
      { cidr: "10.0.4.0/24", port: 5432 },
      { cidr: "1.2.3.4", port: null },
    ]);
  });

  it("follows the served project's mode, and holds an idle cli to Enforce", () => {
    expect(kernelEgress()).toEqual({ mode: "enforce", allow: [], deny: [] });
    setNetworkPolicy({ mode: "audit", allow: [{ target: "10.1.0.0/16", port: null }], deny: [{ target: "10.1.2.3", port: null }], orgDeny: [], projectId: "p1" });
    expect(kernelEgress()).toEqual({ mode: "audit", allow: [{ cidr: "10.1.0.0/16", port: null }], deny: [{ cidr: "10.1.2.3", port: null }] });
    setNetworkPolicy({ mode: "audit", allow: [], deny: [], orgDeny: [{ target: "10.9.0.0/16", port: null }], projectId: null });
    expect(kernelEgress()).toEqual({ mode: "enforce", allow: [], deny: [{ cidr: "10.9.0.0/16", port: null }] });
  });

  it("grants the RAG hosts only to a RAG run", () => {
    setNetworkPolicy({ mode: "enforce", allow: [], deny: [], orgDeny: [], projectId: "p1" });
    expect(policyFor("project").allow).toEqual([]);
    expect(policyFor("project", ["rag"]).allow.map((r) => r.target)).toContain("pypi.org");
  });
});
