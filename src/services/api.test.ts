/**
 * Tests for the cli's API error formatting.
 */
import { describe, expect, it } from "vitest";
import { CliApiError } from "./api";

describe("CliApiError.toString", () => {
  it("prints the code, status and meta of a gateway rejection with no message", () => {
    const err = new CliApiError("VALIDATION_FAILED", "HTTP 400", 400, { field: "X-4PM-Client", rule: "required" });
    expect(String(err)).toBe('CliApiError [VALIDATION_FAILED, HTTP 400]: HTTP 400 {"field":"X-4PM-Client","rule":"required"}');
  });

  it("leaves out an empty meta", () => {
    const err = new CliApiError("LINK_REVOKED", "The link was revoked — pairing is required again.", 401, {});
    expect(String(err)).toBe("CliApiError [LINK_REVOKED, HTTP 401]: The link was revoked — pairing is required again.");
  });
});
