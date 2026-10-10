/**
 * Tests for the transport-security guard: plaintext schemes are only allowed against
 * loopback hosts (incl. the bracketed IPv6 form the WHATWG URL parser returns), secure schemes are
 * always allowed, and the opt-out env flag lifts the hard block.
 * @adr 0194
 */
import { afterEach, describe, expect, it } from "vitest";
import { assertSecureRemoteUrl, insecureTransportAllowed, isInsecureRemoteUrl } from "./secure-url";

const FLAG = "FOURPM_ALLOW_INSECURE_TRANSPORT";

afterEach(() => {
  delete process.env[FLAG];
});

describe("isInsecureRemoteUrl", () => {
  it("flags plaintext schemes against a remote host", () => {
    expect(isInsecureRemoteUrl("http://api.example.com")).toBe(true);
    expect(isInsecureRemoteUrl("ws://10.0.0.5:42003")).toBe(true);
  });

  it("accepts secure schemes anywhere", () => {
    expect(isInsecureRemoteUrl("https://api.example.com")).toBe(false);
    expect(isInsecureRemoteUrl("wss://api.example.com/ws")).toBe(false);
  });

  it("accepts plaintext against loopback hosts, including IPv6 [::1]", () => {
    for (const url of ["http://localhost:42003", "ws://127.0.0.1", "http://[::1]:42003", "http://dev.localhost"]) {
      expect(isInsecureRemoteUrl(url)).toBe(false);
    }
  });

  it("does not treat a look-alike host as local", () => {
    expect(isInsecureRemoteUrl("http://localhost.evil.com")).toBe(true);
  });

  it("leaves an unparseable URL to the caller's connect attempt", () => {
    expect(isInsecureRemoteUrl("not a url")).toBe(false);
  });
});

describe("assertSecureRemoteUrl / opt-out", () => {
  it("throws for a plaintext remote URL by default", () => {
    expect(() => assertSecureRemoteUrl("http://api.example.com")).toThrow(/Refusing to connect/);
  });

  it("is lifted by the explicit opt-out flag (1 / true / yes)", () => {
    for (const v of ["1", "true", "YES"]) {
      process.env[FLAG] = v;
      expect(insecureTransportAllowed()).toBe(true);
      expect(() => assertSecureRemoteUrl("http://api.example.com")).not.toThrow();
    }
    process.env[FLAG] = "0";
    expect(insecureTransportAllowed()).toBe(false);
  });
});
