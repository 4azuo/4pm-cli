/**
 * RAG on the worker — capability probe, install, reindex and query (rag.* channels), Node engine: a
 * pinned npm runtime (`@huggingface/transformers` + `sqlite-vec` + `undici`) in `.claude/rag/runtime`,
 * ONNX models cached in `.claude/rag/models`, the index in `.claude/rag/index.db` — all in the workspace
 * volume, so it survives container restarts. No Python.
 *
 * Privilege boundary (agent uid separation): install / reindex / query run **as the agent** in the
 * project (`projectSpawnArgs` / `execInProject`), under the `rag` egress grant. `.claude/rag/` is
 * agent-writable, so the cli never loads anything from it in its own process — it only spawns
 * `node engine.mjs` as the agent — and treats every file it reads back (markers, logs, `.index.json`,
 * the query reply) as untrusted: symlink-safe reads, size caps, schema checks, clamped values.
 * Search settings (`minScore`, `topK`) live per machine user in `.claude/rag/settings.json`; hits come
 * back grouped per file.
 * Never throws — errors map to a reply.
 * @adr 0156 @adr 0157 @adr 0489 @adr 0496
 */
import { statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { totalmem, cpus } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  RagIndex,
  RagInstallReply,
  RagMachine,
  RagOption,
  RagPrereq,
  RagQueryReply,
  RagQueryResult,
  RagReindexReply,
  RagSettings,
  RagSettingsReply,
  RagStatusReply,
} from "@4pm/ws";
import { mkdirInRoot, PathEscapeError, readFileInRoot, writeFileInRoot } from "../../utils/safe-path";
import { execInProject, projectSpawnArgs } from "../agent/agent-spawn";
import { withEgressRun } from "../network/egress-env";
import { RAG_ENGINE_MJS, RAG_ENGINE_VERSION } from "./rag-engine-script";
import runtimeLock from "./rag-runtime.lock.json";

const RAG_REL = ".claude/rag";
const RUNTIME_REL = `${RAG_REL}/runtime`;
/** The pinned runtime manifest (bumped with cli releases; the lockfile carries the integrity hashes). */
const RUNTIME_PACKAGE = {
  name: "4pm-rag-runtime",
  private: true,
  type: "module",
  dependencies: { "@huggingface/transformers": "4.3.0", "sqlite-vec": "0.1.9", undici: "8.11.2" },
};
/** Minimum Node for `node:sqlite` with extension loading. */
const MIN_NODE: [number, number] = [22, 13];
/** Search settings when none were saved. */
const DEFAULT_SETTINGS: RagSettings = { minScore: 0, topK: 8 };
/** Disk the recommended option needs (GB, model + runtime + headroom). */
const NEED_DISK_GB = 1;

/** Run a probe command; `{ ok, out }` (never throws). Inside the project ⇒ as the agent. */
async function tryRun(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execInProject(cmd, args, { timeout: 8000, ...(cwd ? { cwd } : {}) });
    return { ok: true, out: stdout.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Read a small agent-written file under `.claude/rag/` (symlink-safe, capped), or null. */
async function readSmall(root: string, rel: string, cap = 256 * 1024): Promise<string | null> {
  try {
    const text = await readFileInRoot(root, join(root, RAG_REL, rel), "utf8");
    return text.length > cap ? text.slice(-cap) : text;
  } catch {
    return null;
  }
}

/** Whether the worker's Node supports `node:sqlite` extension loading. */
function nodeOk(version: string): boolean {
  const [maj = 0, min = 0] = version.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/** Compute install options (q8 ONNX embedding models; the engine adds ~95 MB) tuned to RAM + free disk. */
function optionsFor(m: RagMachine): RagOption[] {
  const opts: RagOption[] = [
    {
      id: "small",
      label: "Small · bge-small (English)",
      model: "Xenova/bge-small-en-v1.5",
      sizeMB: 35,
      recommended: m.ramGB < 8,
      note: "Lightweight, low RAM.",
    },
  ];
  if (m.diskFreeGB > 1.5) {
    opts.push({
      id: "multilingual",
      label: "Multilingual · MiniLM-L12 (incl. Vietnamese)",
      model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      sizeMB: 130,
      recommended: m.ramGB >= 8,
      note: "Best for mixed Vietnamese / English content.",
    });
  }
  if (m.ramGB >= 8 && m.diskFreeGB > 2) {
    opts.push({
      id: "base",
      label: "Base · bge-base (English)",
      model: "Xenova/bge-base-en-v1.5",
      sizeMB: 110,
      recommended: false,
      note: "Higher-quality English, needs ≥ 8 GB RAM.",
    });
  }
  return opts;
}

/** Shape of `.index.json` (agent-written ⇒ validated). */
const indexMetaSchema = z.object({
  chunks: z.number().int().min(0).max(1_000_000).optional(),
  docs: z.number().int().min(0).max(1_000_000).optional(),
  indexedAt: z.string().max(40).optional(),
  model: z.string().max(200).optional(),
  engine: z.string().max(40).optional(),
});

/** Read the vector-index meta (`.index.json`) + the `.indexing` marker. */
async function readIndexMeta(root: string, model: string): Promise<RagIndex> {
  const indexing = existsSync(join(root, RAG_REL, ".indexing"));
  const raw = await readSmall(root, ".index.json", 8 * 1024);
  if (raw === null) return { present: false, indexing, chunks: 0, indexedAt: "" };
  let meta: z.infer<typeof indexMetaSchema>;
  try {
    meta = indexMetaSchema.parse(JSON.parse(raw));
  } catch {
    return { present: false, indexing, chunks: 0, indexedAt: "", stale: true };
  }
  const stale = meta.engine !== RAG_ENGINE_VERSION || (model !== "" && meta.model !== model);
  return {
    present: !stale && existsSync(join(root, RAG_REL, "index.db")),
    indexing,
    chunks: meta.chunks ?? 0,
    indexedAt: meta.indexedAt ?? "",
    stale,
    ...(meta.docs !== undefined ? { docs: meta.docs } : {}),
  };
}

/** Clamp settings into range (0–1 score, 1–20 files). */
function clampSettings(s: Partial<RagSettings>): RagSettings {
  const minScore = Number.isFinite(s.minScore) ? Math.min(Math.max(Number(s.minScore), 0), 1) : DEFAULT_SETTINGS.minScore;
  const topK = Number.isFinite(s.topK) ? Math.min(Math.max(Math.floor(Number(s.topK)), 1), 20) : DEFAULT_SETTINGS.topK;
  return { minScore: Math.round(minScore * 1000) / 1000, topK };
}

/** Read `.claude/rag/settings.json` (agent-writable ⇒ validated + clamped; defaults when missing/bad). */
async function readSettings(root: string): Promise<RagSettings> {
  const raw = await readSmall(root, "settings.json", 4 * 1024);
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = z.object({ minScore: z.number().optional(), topK: z.number().optional() }).parse(JSON.parse(raw));
    return clampSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** rag.settings — clamp + save this machine user's search settings. */
export async function ragSettings(root: string, input: Partial<RagSettings>): Promise<RagSettingsReply> {
  const settings = clampSettings(input ?? {});
  try {
    await mkdirInRoot(root, join(root, RAG_REL));
    await writeFileInRoot(root, join(root, RAG_REL, "settings.json"), `${JSON.stringify(settings)}\n`);
    return { ok: true, settings };
  } catch (err) {
    return { ok: false, settings: await readSettings(root), error: err instanceof Error ? err.message : String(err) };
  }
}

/** The host the egress proxy refused in the last failed install, from its log tail (or null). */
function blockedHost(log: string[]): string | null {
  for (const line of [...log].reverse()) {
    const m = /\b403\b[^\n]*?https?:\/\/([a-z0-9.-]+)/i.exec(line) ?? /blocked[^\n]*?\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(line);
    if (m) return m[1]!.slice(0, 120);
  }
  return null;
}

/** rag.status — probe capability, prerequisites, install + index state. */
export async function ragStatus(root: string): Promise<RagStatusReply> {
  const node = process.version;
  const okNode = nodeOk(node);
  const npm = await tryRun("npm", ["--version"], root);
  let diskFreeGB: number;
  try {
    const s = await statfs(root);
    diskFreeGB = Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
  } catch {
    diskFreeGB = 0;
  }
  const gpu = (await tryRun("nvidia-smi", ["-L"])).ok;
  const machine: RagMachine = { ramGB: Math.round((totalmem() / 1e9) * 10) / 10, cpus: cpus().length, diskFreeGB, gpu };
  const modules = join(root, RUNTIME_REL, "node_modules");
  const transformers = existsSync(join(modules, "@huggingface", "transformers", "package.json"));
  const sqliteVec = existsSync(join(modules, "sqlite-vec", "package.json"));
  const modelName = ((await readSmall(root, ".installed", 512)) ?? "").trim();
  const model = /^[A-Za-z0-9._/-]{1,200}$/.test(modelName) ? modelName : "";
  const installed = transformers && sqliteVec && model !== "" && okNode;
  const installing = existsSync(join(root, RAG_REL, ".installing"));
  const failed = existsSync(join(root, RAG_REL, ".install-failed"));
  const log = await installLog(root);
  // Can the agent write `.claude/rag/`? (folder made by the cli with the shared mode, then probed as the agent)
  let access: boolean;
  try {
    await mkdirInRoot(root, join(root, RAG_REL));
    access = (await tryRun("sh", ["-c", `touch "${RAG_REL}/.probe" && rm -f "${RAG_REL}/.probe"`], root)).ok;
  } catch {
    access = false;
  }
  const host = failed && !installing ? blockedHost(log) : null;
  const prereqs: RagPrereq[] = [
    { key: "node", ok: okNode, detail: node, ...(okNode ? {} : { hint: "Node 22.13+ is needed — update the worker image / cli." }) },
    { key: "npm", ok: npm.ok, ...(npm.ok ? { detail: npm.out.slice(0, 20) } : { hint: "npm is not available to the agent user." }) },
    { key: "disk", ok: diskFreeGB >= NEED_DISK_GB, detail: `${diskFreeGB} GB` },
    { key: "access", ok: access, ...(access ? {} : { hint: "The agent user cannot write .claude/rag/ (see cli-fs 0002 §7)." }) },
    { key: "network", ok: host === null, ...(host ? { detail: host, hint: `The egress proxy refused ${host}.` } : {}) },
  ];
  return {
    installed,
    installing,
    runtime: { node, nodeOk: okNode, npm: npm.ok, sqliteExt: okNode },
    deps: { transformers, sqliteVec },
    prereqs,
    model: { present: model !== "", name: model },
    machine,
    options: optionsFor(machine),
    installLog: log,
    index: await readIndexMeta(root, model),
    settings: await readSettings(root),
  };
}

/** Read `install.log` + `index.log` tails (last ~200 lines). */
async function installLog(root: string): Promise<string[]> {
  const text = [(await readSmall(root, "install.log", 64 * 1024)) ?? "", (await readSmall(root, "index.log", 32 * 1024)) ?? ""].join("\n");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, 500))
    .slice(-200);
}

/** Write the engine, the runtime manifest + lockfile and the folder's own `.gitignore` (self-healing). */
async function ensureFiles(root: string): Promise<void> {
  // Symlink-safe + shared mode (ADR-0430/0487): a linked `.claude/rag` cannot redirect these outside.
  await writeFileInRoot(root, join(root, RAG_REL, ".gitignore"), "*\n");
  await writeFileInRoot(root, join(root, RAG_REL, "engine.mjs"), RAG_ENGINE_MJS);
  await writeFileInRoot(root, join(root, RUNTIME_REL, "package.json"), `${JSON.stringify(RUNTIME_PACKAGE, null, 2)}\n`);
  await writeFileInRoot(root, join(root, RUNTIME_REL, "package-lock.json"), `${JSON.stringify(runtimeLock, null, 2)}\n`);
}

/** The quoted path of the cli's own `node` (the engine runs with it, as the agent). */
function nodeBin(): string {
  return `"${process.execPath.replace(/"/g, "")}"`;
}

/** The node command line that runs the engine. */
function engineCmd(): string {
  return `${nodeBin()} --disable-warning=ExperimentalWarning "${RAG_REL}/engine.mjs"`;
}

/** Spawn a detached background shell job in the project, as the agent, under the `rag` egress grant. */
function spawnBackground(root: string, script: string, env: Record<string, string>): void {
  const job = withEgressRun({ grants: ["rag"] }, () =>
    projectSpawnArgs("bash", ["-c", script], root, { ...process.env, NODE_USE_ENV_PROXY: "1", ...env }),
  );
  const child = spawn(job.cmd, job.args, { cwd: root, env: job.env, detached: true, stdio: "ignore" });
  child.unref();
}

/** rag.install — background: `npm ci` the pinned runtime, then download the model. Returns started. */
export async function ragInstall(root: string, model: string): Promise<RagInstallReply> {
  // The model id reaches a shell as an env var and transformers.js as a repo id: plain HF ids only.
  if (!/^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,120}$/.test(model)) return { ok: false, started: false, error: "invalid model name" };
  if (!nodeOk(process.version)) return { ok: false, started: false, error: `Node ${process.version} is too old (22.13+ needed)` };
  if (existsSync(join(root, RAG_REL, ".installing"))) return { ok: true, started: true };
  try {
    await mkdirInRoot(root, join(root, RAG_REL));
    await ensureFiles(root);
  } catch (err) {
    // A linked rag folder leading outside the project is refused (ADR-0430).
    return { ok: false, started: false, error: err instanceof PathEscapeError ? err.message : String(err) };
  }
  const script = `
set +e
R="${RAG_REL}"
touch "$R/.installing"
rm -f "$R/.installed" "$R/.install-failed"
{
  echo "[install] $(date) npm ci (pinned runtime, no install scripts)"
  npm ci --prefix "$R/runtime" --ignore-scripts --no-audit --no-fund --cache "$R/.npm-cache" 2>&1
  ok=$?
  rm -rf "$R/.npm-cache"
  if [ $ok -eq 0 ]; then
    # Prune what this worker never loads: the browser runtime + other platforms' native binaries.
    RT="$R/runtime/node_modules"
    PLAT=$(${nodeBin()} -p process.platform); ARCH=$(${nodeBin()} -p process.arch)
    rm -rf "$RT/onnxruntime-web"
    for d in "$RT"/onnxruntime-node/bin/napi-v*/*; do [ "$(basename "$d")" = "$PLAT" ] || rm -rf "$d"; done
    for d in "$RT"/onnxruntime-node/bin/napi-v*/"$PLAT"/*; do [ "$(basename "$d")" = "$ARCH" ] || rm -rf "$d"; done
    echo "[install] runtime ready ($(du -sh "$RT" | cut -f1))"
  fi
  if [ $ok -eq 0 ]; then
    echo "[install] downloading model: $RAG_MODEL"
    ${engineCmd()} warm "$RAG_MODEL" 2>&1
    ok=$?
  fi
  if [ $ok -eq 0 ]; then printf '%s' "$RAG_MODEL" > "$R/.installed"; echo "[install] DONE"; else touch "$R/.install-failed"; echo "[install] FAILED"; fi
} >> "$R/install.log" 2>&1
# A new model makes the old index stale: reindex right away (ADR-0496).
if [ -f "$R/.installed" ]; then
  touch "$R/.indexing"
  rm -f "$R/.installing"
  { echo "[reindex] $(date)"; ${engineCmd()} reindex 2>&1; } > "$R/index.log" 2>&1
  rm -f "$R/.indexing"
fi
rm -f "$R/.installing"
`;
  spawnBackground(root, script, { RAG_MODEL: model });
  return { ok: true, started: true };
}

/** rag.reindex — (re)build the vector index in the background. Returns started. */
export async function ragReindex(root: string): Promise<RagReindexReply> {
  const status = await ragStatus(root);
  if (!status.installed) return { ok: false, started: false, error: "RAG is not installed" };
  if (status.index.indexing) return { ok: true, started: true };
  try {
    await ensureFiles(root);
  } catch (err) {
    return { ok: false, started: false, error: err instanceof Error ? err.message : String(err) };
  }
  const script = `
set +e
R="${RAG_REL}"
touch "$R/.indexing"
{ echo "[reindex] $(date)"; ${engineCmd()} reindex 2>&1; } > "$R/index.log" 2>&1
rm -f "$R/.indexing"
`;
  spawnBackground(root, script, {});
  return { ok: true, started: true };
}

/** One result as the engine prints it (agent-written ⇒ validated + clamped). */
const queryReplySchema = z.object({
  results: z
    .array(
      z.object({
        path: z.string().max(500),
        snippet: z.string().max(5000),
        score: z.number().finite(),
        title: z.string().max(300).optional(),
        kind: z.string().max(40).optional(),
        hits: z.number().int().min(1).max(1000).optional(),
        more: z.array(z.object({ snippet: z.string().max(5000), score: z.number().finite() })).max(3).optional(),
      }),
    )
    .max(50),
});

/**
 * rag.query — semantic search over the index (synchronous, ≤ 30 s), optional Doc Header kinds; one
 * result per file. `k` defaults to the machine's `topK`; chunks below `minScore` are dropped.
 */
export async function ragQuery(root: string, queryText: string, k?: number, kinds?: string[]): Promise<RagQueryReply> {
  const settings = await readSettings(root);
  const kk = Math.min(Math.max(Math.floor(k ?? settings.topK) || settings.topK, 1), 20);
  const kindList = (kinds ?? []).filter((x) => /^[a-z][a-z0-9-]{0,31}$/.test(x)).slice(0, 24);
  if (!existsSync(join(root, RAG_REL, "index.db"))) return { results: [], error: "no index — reindex first" };
  try {
    await ensureFiles(root);
    const { stdout } = await withEgressRun({ grants: ["rag"] }, () =>
      execInProject(process.execPath, ["--disable-warning=ExperimentalWarning", `${RAG_REL}/engine.mjs`, "query", String(kk), kindList.join(","), String(settings.minScore)], {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, RAG_QUERY: queryText.slice(0, 2000) },
      }),
    );
    const parsed = queryReplySchema.parse(JSON.parse(stdout.trim() || '{"results":[]}'));
    const results: RagQueryResult[] = parsed.results
      // Only project-relative Markdown paths (no absolute / parent escapes).
      .filter((r) => /\.md$/i.test(r.path) && !r.path.startsWith("/") && !r.path.split("/").includes(".."))
      .slice(0, kk)
      .map((r) => ({
        path: r.path,
        snippet: r.snippet.slice(0, 600),
        score: Math.round(r.score * 10000) / 10000,
        ...(r.title ? { title: r.title } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        hits: r.hits ?? 1,
        ...(r.more?.length ? { more: r.more.map((m) => ({ snippet: m.snippet.slice(0, 600), score: Math.round(m.score * 10000) / 10000 })) } : {}),
      }));
    return { results };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}
