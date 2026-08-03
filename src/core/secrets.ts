/**
 * Security & placeholder management on the worker (ADR-0154, secrets.read/write channels). Reads
 * the security docs (AI_SECURITY.md, AI_PLACEHOLDER.md) and reports which placeholder/secret KEYS
 * have a value set — **never the values**. Writes the docs, or sets/rotates/deletes a value in
 * `project.secrets.json` (write-only: values have no read path). Only the cli process touches
 * `project.secrets.json` (it stays gitignored + AI-denied). Never throws — errors map to a reply.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  SecretKeyStatus,
  SecretsReadReply,
  SecretsWriteReply,
  SecretsWriteRequest,
} from "@4pm/ws";

const SECURITY_REL = "AI_SECURITY.md";
const PLACEHOLDER_REL = "AI_PLACEHOLDER.md";
const SECRETS_REL = "project.secrets.json";

/** Read a file as UTF-8; fallback when missing. */
async function readText(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Parse the current secrets object from project.secrets.json (`{}` on any error). */
async function readSecretsObject(root: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFile(join(root, SECRETS_REL), "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Extract placeholder keys from the AI_PLACEHOLDER.md markdown table (first column). */
function placeholderKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|?$/.test(s)) continue; // separator row
    const first = s.replace(/^\|/, "").split("|")[0]?.trim() ?? "";
    if (/^[\w.-]+$/.test(first) && first.toLowerCase() !== "key") keys.push(first);
  }
  return keys;
}

/** secrets.read — security docs + placeholder keys with a set/unset flag (no values). */
export async function readSecrets(root: string): Promise<SecretsReadReply> {
  const [security, placeholder, secrets] = await Promise.all([
    readText(join(root, SECURITY_REL)),
    readText(join(root, PLACEHOLDER_REL)),
    readSecretsObject(root),
  ]);
  const names = new Set<string>([...placeholderKeys(placeholder), ...Object.keys(secrets)]);
  const keys: SecretKeyStatus[] = [...names].sort().map((name) => ({
    name,
    set: secrets[name] !== undefined && String(secrets[name]).length > 0,
  }));
  return { security, placeholder, keys };
}

/** secrets.write — write a doc, or set/rotate/delete a secret value. Never throws. */
export async function writeSecrets(
  root: string,
  req: SecretsWriteRequest,
): Promise<SecretsWriteReply> {
  try {
    if (req.kind === "security") {
      await writeFile(join(root, SECURITY_REL), req.content, "utf8");
    } else if (req.kind === "placeholder") {
      await writeFile(join(root, PLACEHOLDER_REL), req.content, "utf8");
    } else {
      const secrets = await readSecretsObject(root);
      if (req.kind === "secret") secrets[req.key] = req.value;
      else delete secrets[req.key];
      await writeFile(join(root, SECRETS_REL), JSON.stringify(secrets, null, 2) + "\n", "utf8");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
