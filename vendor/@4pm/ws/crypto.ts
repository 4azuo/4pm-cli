/**
 * WS session encryption (arch 0004, ADR-0002): ephemeral ECDH x25519 ⇒ HKDF ⇒
 * AES-256-GCM, a nonce per message, forward secrecy. Used only on server & cli
 * (node:crypto) — the web does not import this file.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/** An ephemeral ECDH key pair for one session. */
export interface EcdhSession {
  /** Raw public key (base64) sent to the other side. */
  publicKeyBase64: string;
  privateKey: KeyObject;
}

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/**
 * Generate an ephemeral x25519 key pair for the handshake.
 */
export function createEcdhSession(): EcdhSession {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // the last 32 bytes of the SPKI = the raw public key
  return {
    publicKeyBase64: Buffer.from(spki.subarray(spki.length - 32)).toString("base64"),
    privateKey,
  };
}

/**
 * Derive the AES-256 session key from our private key + the other side's public key
 * (ECDH ⇒ HKDF-SHA256).
 */
export function deriveSessionKey(
  session: EcdhSession,
  peerPublicKeyBase64: string,
): Buffer {
  const peerRaw = Buffer.from(peerPublicKeyBase64, "base64");
  const peerKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, peerRaw]),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({ privateKey: session.privateKey, publicKey: peerKey });
  return Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("4pm-ws-session"), 32),
  );
}

/** Result of encrypting one payload. */
export interface EncryptedPayload {
  payload: string;
  nonce: string;
}

/**
 * Encrypt a JSON payload with the session key (AES-256-GCM, authTag appended after the ciphertext).
 */
export function encryptPayload(key: Buffer, data: unknown): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const withTag = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return { payload: withTag.toString("base64"), nonce: nonce.toString("base64") };
}

/**
 * Decrypt a payload from an envelope (throws if the authTag does not match).
 */
export function decryptPayload<T>(
  key: Buffer,
  payloadBase64: string,
  nonceBase64: string,
): T {
  const raw = Buffer.from(payloadBase64, "base64");
  const nonce = Buffer.from(nonceBase64, "base64");
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Keep the API to build a private key from DER (for tests / session recreation).
 */
export function privateKeyFromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, type: "pkcs8", format: "der" });
}
