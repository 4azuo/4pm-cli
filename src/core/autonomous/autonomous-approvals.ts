/**
 * Signed autonomous approvals — the cli half. Keeps the server's approval public keys + the served
 * project id (from `ws_token`, persisted in the profile dir so a tick before the next connect still
 * enforces them), verifies every approvals-file entry (Ed25519 signature over projectId|rowId|by|at|h,
 * and `h` = the hash of the row's current content cells), and builds the entries the web writes.
 * Before this cli ever received keys, the legacy rule holds (`approved: true` is enough).
 * @adr 0438
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalEntrySchema,
  approvalRowCanonical,
  approvalSigningPayload,
  type ApprovalEntry,
  type ApprovalPublicKey,
  type ApprovalState,
} from "@4pm/dto";

/** File (in the profile dir) holding the last received trust: keys + served project. */
const TRUST_FILE = "approval-trust.json";

/** The books an approval can target, by `AutonomousBooks` key. */
export type ApprovalBooks = { userTodo: string; userQa: string; aiTodo: string };

/** Loaded trust; `null` = never received keys (legacy rule). */
let trust: { keys: Map<string, KeyObject>; projectId: string | null } | null = null;

/** Decode the pushed keys (invalid ones dropped). */
function decodeKeys(list: ApprovalPublicKey[]): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const k of list) {
    try {
      keys.set(k.kid, createPublicKey({ key: Buffer.from(k.publicKey, "base64"), format: "der", type: "spki" }));
    } catch {
      // skip a malformed key
    }
  }
  return keys;
}

/** Load the persisted trust at start (before the first connect). Never throws. */
export function loadApprovalTrust(profileDir: string): void {
  try {
    const raw = JSON.parse(readFileSync(join(profileDir, TRUST_FILE), "utf8")) as { keys?: ApprovalPublicKey[]; projectId?: string | null };
    if (Array.isArray(raw.keys) && raw.keys.length) trust = { keys: decodeKeys(raw.keys), projectId: raw.projectId ?? null };
  } catch {
    // no stored trust yet
  }
}

/**
 * Apply the trust carried on a `ws_token`. Keys absent (older server / signing off) ⇒ keep what is
 * stored; once keys were received they are never dropped (no downgrade to the legacy rule).
 */
export function setApprovalTrust(keys: ApprovalPublicKey[] | undefined, projectId: string | null | undefined, profileDir: string): void {
  if (!keys || keys.length === 0) return;
  trust = { keys: decodeKeys(keys), projectId: projectId ?? null };
  try {
    writeFileSync(join(profileDir, TRUST_FILE), JSON.stringify({ keys, projectId: projectId ?? null }, null, 2), { mode: 0o600 });
  } catch {
    // in-memory trust still applies for this process
  }
}

/**
 * Replace only the keys (a live `approval.keys` push), keeping the served project id. An empty list is
 * ignored — never a downgrade to the legacy rule.
 * @adr 0440
 */
export function replaceApprovalKeys(keys: ApprovalPublicKey[], profileDir: string): void {
  if (keys.length === 0) return;
  setApprovalTrust(keys, trust?.projectId ?? null, profileDir);
}

/** True once server keys are known — approvals must then be signed. */
export function approvalTrustActive(): boolean {
  return trust !== null;
}

/** `sha256:<hex>` of a row's canonical content in `book`, or null when the row is not there. */
export function approvalRowHash(book: string, rowId: string): string | null {
  const canonical = approvalRowCanonical(book, rowId);
  return canonical === null ? null : `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The book text holding a row, by its id prefix. */
export function bookOfRow(books: ApprovalBooks, rowId: string): string {
  return rowId.startsWith("REQ-") ? books.userTodo : rowId.startsWith("QA-") ? books.userQa : books.aiTodo;
}

/** Verify an `ed25519:<base64>` signature over `payload`; false on any malformed input. */
function verifySig(payload: string, key: KeyObject, sig: string): boolean {
  try {
    return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sig.slice("ed25519:".length), "base64"));
  } catch {
    return false;
  }
}

/**
 * Verification state of one entry against its row in `book`; null when the entry is not an approval
 * or the row is not in the book (nothing to show / nothing to run).
 */
export function approvalStateOf(rowId: string, raw: unknown, book: string): ApprovalState | null {
  const parsed = approvalEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const h = approvalRowHash(book, rowId);
  if (h === null) return null;
  if (!trust) return "approved";
  const e = parsed.data;
  if (!e.sig || !e.kid || !e.h) return "unsigned";
  const key = trust.keys.get(e.kid);
  if (!key || !trust.projectId) return "invalid";
  const payload = approvalSigningPayload({ projectId: trust.projectId, rowId, by: e.by, at: e.at, h: e.h });
  if (!verifySig(payload, key, e.sig)) return "invalid";
  return e.h === h ? "approved" : "stale";
}

/** States of every entry of an approvals map whose row is present in its book. */
export function approvalStates(map: Record<string, unknown>, books: ApprovalBooks): Record<string, ApprovalState> {
  const out: Record<string, ApprovalState> = {};
  for (const [id, raw] of Object.entries(map)) {
    const st = approvalStateOf(id, raw, bookOfRow(books, id));
    if (st) out[id] = st;
  }
  return out;
}

/** The ids that count as approved (verified + unchanged; legacy rule before keys were received). */
export function verifiedApprovedIds(map: Record<string, unknown>, books: ApprovalBooks): Set<string> {
  return new Set(Object.entries(approvalStates(map, books)).filter(([, st]) => st === "approved").map(([id]) => id));
}

/** Outcome of building the entries a web write adds: the entries, or the first stale id. */
export type ApprovalWrite = { ok: true; entries: Record<string, ApprovalEntry> } | { ok: false; staleId: string };

/**
 * The entries to write for `ids`: the server-signed one when given (after checking its `h` against the
 * row in `book`), else an unsigned legacy entry. A missing row or a hash mismatch ⇒ `staleId`.
 */
export function buildApprovalEntries(
  ids: readonly string[],
  signed: Record<string, ApprovalEntry> | undefined,
  books: ApprovalBooks,
  by: string,
  byLabel: string,
): ApprovalWrite {
  const entries: Record<string, ApprovalEntry> = {};
  const at = new Date().toISOString();
  for (const id of ids) {
    const h = approvalRowHash(bookOfRow(books, id), id);
    const s = signed?.[id];
    if (s) {
      if (h === null || s.h !== h) return { ok: false, staleId: id };
      entries[id] = s;
    } else {
      if (h === null && approvalTrustActive()) return { ok: false, staleId: id };
      entries[id] = { approved: true, by, byLabel, at };
    }
  }
  return { ok: true, entries };
}

/** Test hook: reset the in-memory trust. */
export function resetApprovalTrustForTest(): void {
  trust = null;
}
