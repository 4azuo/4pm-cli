/**
 * The release signing keys must be present and valid Ed25519 SPKI keys — the self-update signature
 * check is mandatory, so a build without a key must fail here. Also checks that the verifier
 * accepts a matching signature, tries every key (rotation) and rejects a missing / wrong one.
 * @adr 0508
 */
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLI_SIGNING_PUBLIC_KEYS } from "./signing";
import { verifyTarballSignature } from "../core/update";

describe("release signing keys", () => {
  it("embeds at least one valid ed25519 public key", () => {
    expect(CLI_SIGNING_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const k of CLI_SIGNING_PUBLIC_KEYS) expect(createPublicKey(k.trim()).asymmetricKeyType).toBe("ed25519");
  });

  it("verifies against any embedded key and refuses a missing or foreign signature", () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const pem = (k: typeof signer.publicKey): string => k.export({ type: "spki", format: "pem" }).toString();
    const buf = Buffer.from("tarball bytes");
    const sig = sign(null, buf, signer.privateKey).toString("base64");
    expect(() => verifyTarballSignature(buf, sig, [pem(other.publicKey), pem(signer.publicKey)])).not.toThrow();
    expect(() => verifyTarballSignature(buf, undefined, [pem(signer.publicKey)])).toThrow(/Missing/);
    expect(() => verifyTarballSignature(buf, sig, [pem(other.publicKey)])).toThrow(/Invalid/);
    expect(() => verifyTarballSignature(buf, sig, [])).toThrow(/No release signing key/);
  });
});
