/**
 * Vendored from @4pm/ws (crypto.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { createHash, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject, } from "node:crypto";
export interface EcdhSession {
    publicKeyBase64: string;
    privateKey: KeyObject;
}
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
export function createEcdhSession(): EcdhSession {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    return {
        publicKeyBase64: Buffer.from(spki.subarray(spki.length - 32)).toString("base64"),
        privateKey,
    };
}
export function deriveSessionKey(session: EcdhSession, peerPublicKeyBase64: string): Buffer {
    const peerRaw = Buffer.from(peerPublicKeyBase64, "base64");
    const peerKey = createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, peerRaw]),
        type: "spki",
        format: "der",
    });
    const shared = diffieHellman({ privateKey: session.privateKey, publicKey: peerKey });
    return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("4pm-ws-session"), 32));
}
export interface EncryptedPayload {
    payload: string;
    nonce: string;
}
export function encryptPayload(key: Buffer, data: unknown): EncryptedPayload {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    const plaintext = Buffer.from(JSON.stringify(data), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const withTag = Buffer.concat([encrypted, cipher.getAuthTag()]);
    return { payload: withTag.toString("base64"), nonce: nonce.toString("base64") };
}
export function decryptPayload<T>(key: Buffer, payloadBase64: string, nonceBase64: string): T {
    const raw = Buffer.from(payloadBase64, "base64");
    const nonce = Buffer.from(nonceBase64, "base64");
    if (raw.length < 16)
        throw new Error("payload too short");
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(0, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
}
export function privateKeyFromDer(der: Buffer): KeyObject {
    return createPrivateKey({ key: der, type: "pkcs8", format: "der" });
}
export function handshakeTranscript(clientPubBase64: string, serverPubBase64: string): Buffer {
    return createHash("sha256")
        .update("4pm-ws-hello\n")
        .update(Buffer.from(clientPubBase64, "base64"))
        .update(Buffer.from(serverPubBase64, "base64"))
        .digest();
}
export function handshakeKeyId(publicKey: KeyObject): string {
    return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}
export function signHandshake(privateKeyPem: string, clientPubBase64: string, serverPubBase64: string): {
    kid: string;
    sig: string;
} {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519")
        throw new Error("the handshake signing key must be ed25519");
    const sig = sign(null, handshakeTranscript(clientPubBase64, serverPubBase64), key).toString("base64");
    return { kid: handshakeKeyId(createPublicKey(key)), sig };
}
export function verifyHandshake(pinnedPem: readonly string[], clientPubBase64: string, serverPubBase64: string, kid: string | undefined, sig: string | undefined): boolean {
    if (!sig)
        return false;
    const message = handshakeTranscript(clientPubBase64, serverPubBase64);
    const signature = Buffer.from(sig, "base64");
    const keys = pinnedPem.map((pem) => createPublicKey(pem)).filter((k) => k.asymmetricKeyType === "ed25519");
    keys.sort((a, b) => Number(handshakeKeyId(b) === kid) - Number(handshakeKeyId(a) === kid));
    return keys.some((k) => verify(null, message, k, signature));
}
