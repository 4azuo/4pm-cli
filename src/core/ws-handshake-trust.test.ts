/**
 * Tests for the handshake trust: per-host pins, unknown hosts, unsigned acks and malformed keys.
 * @adr 0681 @adr 0700
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEcdhSession, signHandshake } from "@4pm/ws";
import type { PinnedServerKey } from "../config/ws-server-keys";
import { handshakeTrusted, trustedServerKeys, wsHost } from "./ws-handshake-trust";

/** A fresh ed25519 pair: private PEM + public PEM. */
function pair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("ws handshake trust", () => {
  const staging = pair();
  const prod = pair();
  const pins: PinnedServerKey[] = [
    { label: "staging", since: "2026-10-30", kid: "a", hosts: ["cli.localhost"], pem: staging.pub },
    { label: "production", since: "2026-10-30", kid: "b", hosts: ["cli.example.com"], pem: prod.pub },
  ];
  const client = createEcdhSession().publicKeyBase64;
  const server = createEcdhSession().publicKeyBase64;
  const signedBy = (priv: string) => ({ pubkey: server, ...signHandshake(priv, client, server) });

  it("trusts a key only for the hosts it is pinned to", () => {
    const ack = signedBy(staging.priv);
    expect(handshakeTrusted("cli.localhost", client, ack, trustedServerKeys("cli.localhost", pins))).toBe(true);
    expect(handshakeTrusted("cli.example.com", client, ack, trustedServerKeys("cli.example.com", pins))).toBe(false);
  });

  it("refuses an unknown host, an unsigned ack and a malformed key list", () => {
    const ack = signedBy(prod.priv);
    expect(handshakeTrusted("evil.example", client, ack, trustedServerKeys("evil.example", pins))).toBe(false);
    expect(handshakeTrusted("cli.example.com", client, { pubkey: server }, trustedServerKeys("cli.example.com", pins))).toBe(false);
    expect(handshakeTrusted("cli.example.com", client, ack, ["not a key"])).toBe(false);
  });

  it("reads the host of a WS URL without port or case", () => {
    expect(wsHost("wss://CLI.Example.com:443/ws")).toBe("cli.example.com");
    expect(wsHost("ws://[::1]:42003/ws")).toBe("::1");
    expect(wsHost("not a url")).toBe("");
  });
});
