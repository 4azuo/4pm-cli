/**
 * RAG capability check + install on the worker (ADR-0156, rag.status/rag.install channels). Probes
 * whether the worker can run RAG (python3 + pip + fastembed + sqlite_vec + model/index present) and
 * reports RAM/CPU/disk/GPU so the dashboard can offer install options tuned to the machine. Install
 * runs in the **background** (a `.installing` marker + `install.log`); the web polls the status.
 * WSL/Linux assumed (the autonomous engine's environment). Never throws — errors map to a reply.
 */
import { readFile, writeFile, statfs, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { totalmem, cpus } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RagIndex,
  RagInstallReply,
  RagMachine,
  RagOption,
  RagQueryReply,
  RagReindexReply,
  RagStatusReply,
} from "@4pm/ws";

const run = promisify(execFile);
const RAG_REL = ".claude/rag";

/** Run a command; return `{ ok, out }` (never throws). */
async function tryRun(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 8000 });
    return { ok: true, out: stdout.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Find a working python3/python + its version. */
async function detectPython(): Promise<{ bin: string; found: boolean; version: string }> {
  for (const bin of ["python3", "python"]) {
    const r = await tryRun(bin, ["--version"]);
    if (r.ok) return { bin, found: true, version: r.out.replace(/^Python\s*/i, "") };
  }
  return { bin: "python3", found: false, version: "" };
}

/** Read `install.log` tail (last ~200 lines). */
async function installLog(root: string): Promise<string[]> {
  try {
    const text = await readFile(join(root, RAG_REL, "install.log"), "utf8");
    return text.split("\n").filter((l) => l.length > 0).slice(-200);
  } catch {
    return [];
  }
}

/** Compute install options (embedding models) tuned to the worker's RAM + free disk. */
function optionsFor(m: RagMachine): RagOption[] {
  const opts: RagOption[] = [
    {
      id: "small",
      label: "Small (bge-small, EN) · ~130 MB",
      model: "BAAI/bge-small-en-v1.5",
      sizeMB: 130,
      recommended: m.ramGB < 8,
      note: "Lightweight, low RAM.",
    },
  ];
  if (m.diskFreeGB > 1.5) {
    opts.push({
      id: "multilingual",
      label: "Multilingual (MiniLM, incl. Vietnamese) · ~470 MB",
      model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
      sizeMB: 470,
      recommended: m.ramGB >= 8 && m.diskFreeGB > 2,
      note: "Best for mixed VI/EN content.",
    });
  }
  if (m.ramGB >= 8 && m.diskFreeGB > 2) {
    opts.push({
      id: "base",
      label: "Base (bge-base, EN) · ~440 MB",
      model: "BAAI/bge-base-en-v1.5",
      sizeMB: 440,
      recommended: false,
      note: "Higher quality EN, needs ≥ 8 GB RAM.",
    });
  }
  return opts;
}

/** rag.status — probe capability + install state + tuned options. */
export async function ragStatus(root: string): Promise<RagStatusReply> {
  const py = await detectPython();
  const [pip, fastembed, sqliteVec] = py.found
    ? await Promise.all([
        tryRun(py.bin, ["-m", "pip", "--version"]).then((r) => r.ok),
        tryRun(py.bin, ["-c", "import fastembed"]).then((r) => r.ok),
        tryRun(py.bin, ["-c", "import sqlite_vec"]).then((r) => r.ok),
      ])
    : [false, false, false];
  // Machine specs (best-effort).
  let diskFreeGB = 0;
  try {
    const s = await statfs(root);
    diskFreeGB = Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
  } catch {
    diskFreeGB = 0;
  }
  const gpu = (await tryRun("nvidia-smi", ["-L"])).ok;
  const machine: RagMachine = {
    ramGB: Math.round((totalmem() / 1e9) * 10) / 10,
    cpus: cpus().length,
    diskFreeGB,
    gpu,
  };
  // Installed = deps present + a model marker written by a successful install.
  let modelName = "";
  try {
    modelName = (await readFile(join(root, RAG_REL, ".installed"), "utf8")).trim();
  } catch {
    modelName = "";
  }
  const modelPresent = modelName.length > 0;
  return {
    installed: fastembed && sqliteVec && modelPresent,
    installing: existsSync(join(root, RAG_REL, ".installing")),
    python: { found: py.found, version: py.version },
    deps: { pip, fastembed, sqliteVec },
    model: { present: modelPresent, name: modelName },
    machine,
    options: optionsFor(machine),
    installLog: await installLog(root),
    index: await readIndexMeta(root),
  };
}

/** Read the vector-index meta (`.index.json`) + the `.indexing` marker (ADR-0157). */
async function readIndexMeta(root: string): Promise<RagIndex> {
  const indexing = existsSync(join(root, RAG_REL, ".indexing"));
  try {
    const m = JSON.parse(await readFile(join(root, RAG_REL, ".index.json"), "utf8")) as {
      chunks?: number;
      indexedAt?: string;
    };
    return {
      present: true,
      indexing,
      chunks: typeof m.chunks === "number" ? m.chunks : 0,
      indexedAt: typeof m.indexedAt === "string" ? m.indexedAt : "",
    };
  } catch {
    return { present: false, indexing, chunks: 0, indexedAt: "" };
  }
}

/**
 * The RAG engine (Python): (re)index `.md` files into a sqlite-vec DB via the installed fastembed
 * model, and semantic-query it. Written to `.claude/rag/rag_engine.py` before use (self-healing).
 */
const RAG_ENGINE_PY = `import sys, os, json, glob, sqlite3, datetime
BASE = os.path.join(".claude", "rag")
DB = os.path.join(BASE, "index.db")
def model_name():
    return open(os.path.join(BASE, ".installed"), encoding="utf-8").read().strip()
def connect():
    import sqlite_vec
    db = sqlite3.connect(DB)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    return db
def embedder():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name())
def reindex():
    import sqlite_vec
    emb = embedder()
    chunks = []
    for p in glob.glob("**/*.md", recursive=True):
        parts = p.split(os.sep)
        if "node_modules" in parts or ".git" in parts: continue
        try: txt = open(p, encoding="utf-8").read()
        except Exception: continue
        for i in range(0, len(txt), 800):
            c = txt[i:i+1000].strip()
            if len(c) > 20: chunks.append((p, c))
        if len(chunks) >= 5000: break
    vectors = list(emb.embed([c for _, c in chunks])) if chunks else []
    dim = len(vectors[0]) if vectors else 384
    os.makedirs(BASE, exist_ok=True)
    db = connect()
    db.execute("DROP TABLE IF EXISTS chunks")
    db.execute("CREATE VIRTUAL TABLE chunks USING vec0(embedding float[%d], +path text, +snippet text)" % dim)
    for (p, c), v in zip(chunks, vectors):
        db.execute("INSERT INTO chunks(embedding, path, snippet) VALUES (?, ?, ?)",
                   (sqlite_vec.serialize_float32(list(v)), p, c[:400]))
    db.commit(); db.close()
    json.dump({"chunks": len(chunks), "indexedAt": datetime.datetime.now().isoformat(timespec="seconds"), "model": model_name()},
              open(os.path.join(BASE, ".index.json"), "w", encoding="utf-8"))
    print("[reindex] DONE %d chunks" % len(chunks))
def query(q, k):
    import sqlite_vec
    v = list(embedder().embed([q]))[0]
    db = connect()
    rows = db.execute("SELECT path, snippet, distance FROM chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
                      (sqlite_vec.serialize_float32(list(v)), k)).fetchall()
    db.close()
    out = [{"path": r[0], "snippet": r[1], "score": round(1.0/(1.0+float(r[2])), 4)} for r in rows]
    print(json.dumps({"results": out}, ensure_ascii=False))
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "reindex": reindex()
    elif cmd == "query": query(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 8)
`;

/** Ensure the RAG engine script exists on the worker (self-healing). */
async function ensureEngine(root: string): Promise<void> {
  await mkdir(join(root, RAG_REL), { recursive: true }).catch(() => undefined);
  await writeFile(join(root, RAG_REL, "rag_engine.py"), RAG_ENGINE_PY, "utf8");
}

/** rag.reindex — (re)build the vector index in the background. Returns started. */
export async function ragReindex(root: string): Promise<RagReindexReply> {
  const py = await detectPython();
  if (!py.found) return { ok: false, started: false, error: "python3 not found" };
  if (!existsSync(join(root, RAG_REL, ".installed"))) return { ok: false, started: false, error: "RAG is not installed" };
  if (existsSync(join(root, RAG_REL, ".indexing"))) return { ok: true, started: true };
  await ensureEngine(root);
  const script = `
set +e
touch "${RAG_REL}/.indexing"
{ echo "[reindex] $(date)"; "$RAG_PY" "${RAG_REL}/rag_engine.py" reindex 2>&1; } >> "${RAG_REL}/index.log" 2>&1
rm -f "${RAG_REL}/.indexing"
`;
  const child = spawn("bash", ["-c", script], {
    cwd: root,
    env: { ...process.env, RAG_PY: py.bin },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, started: true };
}

/** rag.query — semantic search over the index (synchronous). */
export async function ragQuery(root: string, queryText: string, k = 8): Promise<RagQueryReply> {
  const py = await detectPython();
  if (!py.found) return { results: [], error: "python3 not found" };
  if (!existsSync(join(root, RAG_REL, "index.db"))) return { results: [], error: "no index — reindex first" };
  await ensureEngine(root);
  try {
    const { stdout } = await run(
      py.bin,
      [join(RAG_REL, "rag_engine.py"), "query", queryText, String(Math.min(Math.max(k, 1), 20))],
      { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || '{"results":[]}') as RagQueryReply;
    return { results: Array.isArray(parsed.results) ? parsed.results : [] };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** rag.install — launch a background install of `model` (pip + model warm-up). Returns started. */
export async function ragInstall(root: string, model: string): Promise<RagInstallReply> {
  const py = await detectPython();
  if (!py.found) return { ok: false, started: false, error: "python3 not found on the worker" };
  if (existsSync(join(root, RAG_REL, ".installing"))) return { ok: true, started: true };
  try {
    await mkdir(join(root, RAG_REL), { recursive: true });
  } catch {
    // ignore
  }
  // Background: mark installing, pip the deps, warm (download) the model, then clear the marker.
  const script = `
set +e
touch "${RAG_REL}/.installing"
rm -f "${RAG_REL}/.installed"
{
  echo "[install] $(date) pip install fastembed sqlite-vec"
  "$RAG_PY" -m pip install --quiet --user fastembed sqlite-vec 2>&1
  echo "[install] warming model: $RAG_MODEL (first run downloads it)"
  "$RAG_PY" -c "from fastembed import TextEmbedding; TextEmbedding('$RAG_MODEL'); print('[install] model ready')" 2>&1
  if [ $? -eq 0 ]; then printf '%s' "$RAG_MODEL" > "${RAG_REL}/.installed"; echo "[install] DONE"; else echo "[install] FAILED"; fi
} >> "${RAG_REL}/install.log" 2>&1
rm -f "${RAG_REL}/.installing"
`;
  const child = spawn("bash", ["-c", script], {
    cwd: root,
    env: { ...process.env, RAG_PY: py.bin, RAG_MODEL: model },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, started: true };
}
