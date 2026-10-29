/**
 * Tests for the handshake trust: pinned / dev-env keys, release builds ignoring the env, and unsigned acks.
 * @adr 0681
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEcdhSession, signHandshake } from "@4pm/ws";
import { handshakeTrusted, trustedServerKeys } from "./ws-handshake-trust";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("ws handshake trust", () => {
  const client = createEcdhSession().publicKeyBase64;
  const server = createEcdhSession().publicKeyBase64;
  const ack = { pubkey: server, ...signHandshake(priv, client, server) };

  it("trusts a dev-env key only on a dev build", () => {
    const env = { FOURPM_WS_SERVER_KEYS: spkiB64 } as NodeJS.ProcessEnv;
    expect(handshakeTrusted(client, ack, trustedServerKeys(env, "0.0.0"))).toBe(true);
    expect(handshakeTrusted(client, ack, trustedServerKeys(env, "1.50.0"))).toBe(false);
  });

  it("refuses an unsigned ack and a malformed key list", () => {
    const keys = trustedServerKeys({ FOURPM_WS_SERVER_KEYS: spkiB64 } as NodeJS.ProcessEnv, "0.0.0");
    expect(handshakeTrusted(client, { pubkey: server }, keys)).toBe(false);
    expect(handshakeTrusted(client, ack, ["not a key"])).toBe(false);
  });
});
