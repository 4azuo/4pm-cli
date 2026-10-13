// GENERATED from the 4PM cli (src/core/docs/doc-model.ts) by scripts/emit-doc-lint.mjs — do not edit.
/**
 * The 4PM Doc Header model — one dependency-free module shared by the cli's `graph.build` and the
 * `4pm-doc-lint` skill (emitted to `doc-model.mjs` by `scripts/emit-doc-lint.mjs`; a test keeps the two
 * in sync). It parses the YAML frontmatter of docs and the header comment + imports of source files,
 * then builds the typed graph, the tree, the depth score and the lint issues. Pure: the caller walks
 * the tree and reads the files (the cli symlink-safe, the skill with plain `fs`).
 *
 * Everything here parses agent-writable text inside the cli process, so it is deliberately small:
 * a YAML subset (no anchors, aliases, tags or merge keys), string-only import resolution, size caps.
 * @adr 0488
 */
/** Standard doc kinds (§1). */
export const DOC_KINDS = ["req", "adr", "arch", "flow", "api", "page", "component", "data", "guide", "test", "report", "other"];
/** Standard code kinds (§2). */
export const CODE_KINDS = ["entry", "route", "service", "component", "model", "util", "test", "config", "other"];
/** Typed `refs` keys (§1). */
export const REF_TYPES = ["implements", "uses", "extends", "supersedes", "tests", "related"];
/** Code header tags that point at docs: `@api x` ⇒ `api.x`. */
export const DOC_TAGS = ["api", "adr", "arch", "page", "flow", "req", "data", "guide", "test"];
/** Default files that are not project docs (books, agent guides). Extend with `docs.ignore`. */
export const DEFAULT_DOC_IGNORE = ["AI_*.md", "USER_*.md", "CLAUDE.md", "AGENT.md", "AGENTS.md", "CHANGELOG.md", ".claude/**", ".4pm/**"];
/** Header block size cap (bytes). */
const MAX_HEADER = 8192;
/** Issue cap per build. */
const MAX_ISSUES = 1000;
/** Default ideal nesting depth. */
const DEFAULT_IDEAL_DEPTH = 3;
// ─────────────────────────────── small helpers ───────────────────────────────
/** Strip matching quotes and a trailing ` # comment` from a YAML scalar. */
function scalar(raw) {
    let v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
        return v.slice(1, -1).trim();
    }
    const hash = v.search(/\s#/);
    if (hash >= 0)
        v = v.slice(0, hash).trim();
    return v;
}
/** Parse a YAML flow list `[a, b]` (no nesting). */
function flowList(raw) {
    const inner = raw.trim().replace(/^\[/, "").replace(/\].*$/, "");
    return inner
        .split(",")
        .map((s) => scalar(s))
        .filter((s) => s.length > 0);
}
/** True when a value starts a YAML construct this subset refuses (anchors, aliases, tags, merge keys). */
function unsafeYaml(raw) {
    const v = raw.trim();
    return v.startsWith("&") || v.startsWith("*") || v.startsWith("!") || v.startsWith("<<") || v.startsWith("|") || v.startsWith(">");
}
/** Glob (`*` within a segment, `**` across) → RegExp. */
function globRe(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            re += ".*";
            i++;
            if (glob[i + 1] === "/")
                i++;
        }
        else if (c === "*")
            re += "[^/]*";
        else if (c === "?")
            re += "[^/]";
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}
/** True when `path` matches one of the ignore globs (a bare name matches at any depth). */
export function isIgnored(path, globs) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return globs.some((g) => (g.includes("/") ? globRe(g).test(path) : globRe(g).test(base)));
}
/** Normalize a project path: `./a/../b` → `b`; returns null when it escapes the root. */
function normPath(p) {
    const out = [];
    for (const seg of p.split("/")) {
        if (seg === "" || seg === ".")
            continue;
        if (seg === "..") {
            if (!out.length)
                return null;
            out.pop();
        }
        else
            out.push(seg);
    }
    return out.join("/");
}
/** Directory of a project path (`a/b.md` → `a`, `b.md` → ``). */
function dirOf(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
}
/** Join + normalize. */
function joinPath(dir, rel) {
    return normPath(dir ? `${dir}/${rel}` : rel);
}
/** JSON with comments / trailing commas (tsconfig) → value, or null. */
export function parseJsonc(text) {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (c === "\\") {
                out += text[i + 1] ?? "";
                i++;
            }
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
        }
        else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n")
                i++;
            out += "\n";
        }
        else if (c === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i++;
            i++;
        }
        else
            out += c;
    }
    try {
        return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    }
    catch {
        return null;
    }
}
/**
 * Parse the YAML frontmatter at the top of a Markdown file (the 4PM Doc Header, ADR-0488 §1). Only the
 * subset the standard needs: scalars, flow lists, block lists, and one nested map for `refs`.
 */
export function parseFrontmatter(text) {
    const src = text.startsWith("﻿") ? text.slice(1) : text;
    const all = src.slice(0, MAX_HEADER * 2).split(/\r?\n/);
    if (all[0]?.trim() !== "---")
        return { present: false, header: null, errors: [] };
    const endIdx = all.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (endIdx < 0)
        return { present: true, header: null, errors: ["frontmatter is not closed with --- (or is larger than 8 KB)"] };
    const lines = all.slice(1, endIdx);
    if (lines.join("\n").length > MAX_HEADER)
        return { present: true, header: null, errors: ["frontmatter is larger than 8 KB"] };
    const errors = [];
    const h = { feature: [], refs: [] };
    let listKey = null; // a top-level key collecting `- item` lines
    let inRefs = false;
    let refKey = null; // a refs type collecting `- item` lines
    const setTop = (key, value) => {
        const one = Array.isArray(value) ? (value[0] ?? "") : value;
        switch (key) {
            case "id":
                h.id = one;
                break;
            case "kind":
                h.kind = one;
                break;
            case "title":
                h.title = one;
                break;
            case "parent":
                h.parent = one;
                break;
            case "status":
                h.status = one;
                break;
            case "feature":
                h.feature = Array.isArray(value) ? value : value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
                break;
            default:
                break; // unknown keys are allowed and ignored
        }
    };
    const addRefs = (type, ids) => {
        const known = REF_TYPES.includes(type);
        const t = known ? type : "related";
        if (!known)
            errors.push(`unknown refs key "${type}" (kept as related)`);
        for (const to of ids)
            h.refs.push({ type: t, to });
    };
    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith("#"))
            continue;
        const indent = line.length - line.trimStart().length;
        const t = line.trim();
        if (indent === 0) {
            listKey = null;
            inRefs = false;
            refKey = null;
            const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(t);
            if (!m) {
                errors.push(`cannot read line "${t.slice(0, 40)}"`);
                continue;
            }
            const key = m[1];
            const rest = m[2] ?? "";
            if (unsafeYaml(rest)) {
                errors.push(`"${key}" uses YAML features the Doc Header does not allow`);
                continue;
            }
            if (key === "refs") {
                if (rest.trim())
                    errors.push("refs must be a map of type: [ids]");
                inRefs = true;
            }
            else if (!rest.trim())
                listKey = key;
            else if (rest.trim().startsWith("["))
                setTop(key, flowList(rest));
            else
                setTop(key, scalar(rest));
            continue;
        }
        if (inRefs) {
            const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(t);
            if (m && indent <= 4 && !t.startsWith("-")) {
                refKey = m[1];
                const rest = m[2] ?? "";
                if (rest.trim().startsWith("["))
                    addRefs(refKey, flowList(rest));
                else if (rest.trim())
                    addRefs(refKey, [scalar(rest)]);
                continue;
            }
            if (t.startsWith("- ") && refKey) {
                addRefs(refKey, [scalar(t.slice(2))]);
                continue;
            }
            errors.push(`cannot read refs line "${t.slice(0, 40)}"`);
            continue;
        }
        if (listKey && t.startsWith("- ")) {
            const v = scalar(t.slice(2));
            if (listKey === "feature")
                h.feature.push(v);
            else
                setTop(listKey, v);
            continue;
        }
        errors.push(`unexpected indented line "${t.slice(0, 40)}"`);
    }
    return { present: true, header: h, errors };
}
/** True when a Doc Header id is well-formed: `<kind>.<slug>`, `[a-z0-9.-]`. */
export function validDocId(id) {
    return /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/.test(id) && id.length <= 120;
}
// ─────────────────────────────── code headers + imports ───────────────────────────────
/** Source extensions the code graph reads. */
export const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"];
const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
/** Extension of a path (`.ts`), lower-case. */
function extOf(p) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const i = base.lastIndexOf(".");
    return i <= 0 ? "" : base.slice(i).toLowerCase();
}
/**
 * Read the header comment of a source file (the first block comment / docstring / leading `#` or `//`
 * lines, within the first 60 lines): `@kind`, `@feature`, the doc tags and `@er`.
 */
export function parseCodeHeader(text) {
    const head = text.split(/\r?\n/).slice(0, 60).join("\n");
    const block = /^\s*(?:#![^\n]*\n\s*)?(?:"use [a-z]+";?\s*)?\/\*\*?([\s\S]*?)\*\//.exec(head)?.[1] ??
        /^\s*(?:#![^\n]*\n\s*)?(?:[ru]?"""([\s\S]*?)""")/.exec(head)?.[1] ??
        /^\s*((?:(?:\/\/|#)[^\n]*\n\s*)+)/.exec(head)?.[1] ??
        null;
    if (block === null)
        return null;
    const h = { feature: [], refs: [] };
    for (const m of block.matchAll(/@([a-z]+)[ \t]+([^\n@]*)/g)) {
        const tag = m[1];
        const value = (m[2] ?? "").replace(/\*\/.*$/, "").trim();
        if (!value)
            continue;
        if (tag === "kind")
            h.kind = value.split(/\s+/)[0];
        else if (tag === "feature")
            h.feature.push(...value.split(/[\s,]+/).filter(Boolean));
        else if (tag === "er") {
            for (const e of value.split(/[\s,]+/).filter(Boolean))
                h.refs.push(`er.${e}`);
        }
        else if (DOC_TAGS.includes(tag)) {
            const first = value.split(/\s+/)[0] ?? "";
            if (/^[A-Za-z0-9][\w.-]*$/.test(first))
                h.refs.push(`${tag}.${first.toLowerCase()}`);
        }
    }
    return h;
}
/** Import specifiers of a source file (strings only — never resolved by loading). */
export function importSpecifiers(path, text) {
    const ext = extOf(path);
    const out = new Set();
    if (JS_EXT.includes(ext)) {
        for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*["']([^"'\n]+)["']/g))
            out.add(m[1]);
        for (const m of text.matchAll(/(?:^|[\s;])import\s*["']([^"'\n]+)["']/g))
            out.add(m[1]);
        for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g))
            out.add(m[1]);
    }
    else if (ext === ".py") {
        for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)/gm)) {
            const mod = m[1];
            // `from . import a, b` names submodules.
            if (/^\.+$/.test(mod))
                for (const n of (m[2] ?? "").replace(/[()]/g, "").split(","))
                    out.add(`${mod}${n.trim()}`);
            else
                out.add(mod);
        }
        for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm))
            for (const n of m[1].split(","))
                out.add(n.trim());
    }
    else if (ext === ".go") {
        const blocks = [...text.matchAll(/import\s*\(([\s\S]*?)\)/g)].map((m) => m[1] ?? "");
        for (const b of blocks)
            for (const m of b.matchAll(/"([^"\n]+)"/g))
                out.add(m[1]);
        for (const m of text.matchAll(/import\s+(?:[\w.]+\s+)?"([^"\n]+)"/g))
            out.add(m[1]);
    }
    return [...out];
}
/** Build the resolver context from tsconfig*.json / package.json / go.mod files. */
function resolveCtx(files, configs) {
    const byPath = new Map(configs.map((c) => [c.path, c.text]));
    const tsconfigs = new Map();
    /** Read compilerOptions (following up to 3 relative `extends`). */
    const readTs = (p, hops) => {
        const raw = byPath.get(p);
        if (raw === undefined)
            return null;
        const j = parseJsonc(raw);
        if (!j || typeof j !== "object")
            return null;
        const dir = dirOf(p);
        let parent = null;
        if (hops < 3 && typeof j.extends === "string" && j.extends.startsWith(".")) {
            const ep = joinPath(dir, j.extends.endsWith(".json") ? j.extends : `${j.extends}.json`);
            if (ep)
                parent = readTs(ep, hops + 1);
        }
        const co = j.compilerOptions ?? {};
        const own = { dir };
        if (typeof co.baseUrl === "string")
            own.baseUrl = co.baseUrl;
        if (co.paths && typeof co.paths === "object")
            own.paths = co.paths;
        if (!own.paths && parent?.paths) {
            own.paths = parent.paths;
            own.dir = parent.dir;
            if (!own.baseUrl && parent.baseUrl)
                own.baseUrl = parent.baseUrl;
        }
        return own;
    };
    for (const c of configs) {
        if (!/(^|\/)tsconfig\.json$/.test(c.path))
            continue;
        const t = readTs(c.path, 0);
        if (!t?.paths)
            continue;
        const base = joinPath(t.dir, t.baseUrl ?? ".") ?? t.dir;
        const paths = Object.entries(t.paths).filter((e) => Array.isArray(e[1]));
        tsconfigs.set(dirOf(c.path), { base, paths });
    }
    const packages = new Map();
    let goModule = null;
    for (const c of configs) {
        if (/(^|\/)package\.json$/.test(c.path)) {
            const j = parseJsonc(c.text);
            if (j && typeof j.name === "string")
                packages.set(j.name, dirOf(c.path));
        }
        else if (/(^|\/)go\.mod$/.test(c.path) && !goModule) {
            const m = /^module\s+(\S+)/m.exec(c.text);
            if (m)
                goModule = { module: m[1], dir: dirOf(c.path) };
        }
    }
    return { files, tsconfigs, packages, goModule };
}
/** Try a JS/TS module path with extensions + index files. */
function tryJs(ctx, p) {
    if (p === null)
        return null;
    if (ctx.files.has(p))
        return p;
    // ESM TypeScript imports `./x.js` for `./x.ts`.
    const noExt = p.replace(/\.(m|c)?js$/, "");
    for (const e of JS_EXT)
        if (ctx.files.has(noExt + e))
            return noExt + e;
    for (const e of JS_EXT)
        if (ctx.files.has(`${p}/index${e}`))
            return `${p}/index${e}`;
    return null;
}
/** Resolve one import specifier of `from` to project file paths. */
function resolveImport(ctx, from, spec) {
    const ext = extOf(from);
    const dir = dirOf(from);
    if (JS_EXT.includes(ext)) {
        if (spec.startsWith(".")) {
            const r = tryJs(ctx, joinPath(dir, spec));
            return r ? [r] : [];
        }
        // tsconfig paths of the nearest tsconfig.json with paths.
        let d = dir;
        while (d !== null) {
            const ts = ctx.tsconfigs.get(d);
            if (ts) {
                for (const [pattern, targets] of ts.paths) {
                    const star = pattern.indexOf("*");
                    const hit = star < 0 ? (spec === pattern ? "" : null) : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
                    if (hit === null)
                        continue;
                    for (const t of targets) {
                        const r = tryJs(ctx, joinPath(ts.base, t.replace("*", hit)));
                        if (r)
                            return [r];
                    }
                }
                break;
            }
            d = d === "" ? null : dirOf(d);
        }
        // Workspace packages by name (`@scope/pkg/sub`).
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        const pkgDir = ctx.packages.get(name);
        if (pkgDir !== undefined) {
            const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
            const candidates = sub ? [joinPath(pkgDir, sub), joinPath(pkgDir, `src/${sub}`)] : [joinPath(pkgDir, "src/index"), joinPath(pkgDir, "index")];
            for (const c of candidates) {
                const r = tryJs(ctx, c);
                if (r)
                    return [r];
            }
        }
        return [];
    }
    if (ext === ".py") {
        const lead = /^\.+/.exec(spec)?.[0].length ?? 0;
        const mod = spec.slice(lead).replace(/\./g, "/");
        let base = dir;
        for (let i = 1; i < lead && base !== null; i++)
            base = base === "" ? null : dirOf(base);
        const roots = lead > 0 ? [base] : ["", "src"];
        for (const r of roots) {
            if (r === null)
                continue;
            const p = mod ? joinPath(r, mod) : r;
            if (p === null)
                continue;
            if (ctx.files.has(`${p}.py`))
                return [`${p}.py`];
            if (ctx.files.has(`${p}/__init__.py`))
                return [`${p}/__init__.py`];
        }
        return [];
    }
    if (ext === ".go" && ctx.goModule && (spec === ctx.goModule.module || spec.startsWith(`${ctx.goModule.module}/`))) {
        const sub = spec.slice(ctx.goModule.module.length).replace(/^\//, "");
        const pdir = joinPath(ctx.goModule.dir, sub) ?? "";
        const out = [];
        for (const f of ctx.files)
            if (dirOf(f) === pdir && f.endsWith(".go") && !f.endsWith("_test.go"))
                out.push(f);
        return out.slice(0, 50);
    }
    return [];
}
/** Infer a code kind when the header has none. */
function inferCodeKind(path) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (/\.(test|spec)\.[a-z]+$/.test(base) || /^test_.*\.py$/.test(base) || /_test\.go$/.test(base))
        return "test";
    if (/^(index|main)\.[a-z]+$/.test(base) || base === "__main__.py")
        return "entry";
    return "other";
}
/** Build the typed graph, tree, metrics and lint issues (ADR-0488 §3–§5). */
export function buildDocModel(input) {
    const opts = input.options ?? {};
    const ideal = typeof opts.maxDepth === "number" && opts.maxDepth >= 1 && opts.maxDepth <= 20 ? Math.floor(opts.maxDepth) : DEFAULT_IDEAL_DEPTH;
    const extraKinds = (opts.kinds ?? []).map((k) => k.key).filter((k) => /^[a-z][a-z0-9-]{0,31}$/.test(k));
    const docKinds = new Set([...DOC_KINDS, ...extraKinds]);
    const ignore = [...DEFAULT_DOC_IGNORE, ...(opts.ignore ?? []).filter((g) => typeof g === "string")];
    const issues = [];
    const issue = (i) => {
        if (issues.length < MAX_ISSUES)
            issues.push(i);
    };
    const nodes = new Map();
    const edges = [];
    const edgeKeys = new Set();
    const addEdge = (from, to, type) => {
        if (from === to)
            return;
        const key = `${from}>${to}>${type}`;
        if (edgeKeys.has(key))
            return;
        edgeKeys.add(key);
        edges.push({ from, to, type });
    };
    let brokenRefs = 0;
    const wantDocs = input.mode !== "code";
    const wantCode = input.mode !== "docs";
    // Docs: nodes first (ids), then edges.
    const docs = input.docs.filter((d) => !isIgnored(d.path, ignore));
    const pathToId = new Map();
    const parsed = [];
    let adopted = false;
    if (wantDocs || input.mode === "code") {
        for (const f of docs) {
            const fm = parseFrontmatter(f.text);
            if (fm.header?.id)
                adopted = true;
            parsed.push({ file: f, fm });
        }
    }
    if (wantDocs) {
        for (const { file, fm } of parsed) {
            const h = fm.header;
            const label = file.path.slice(file.path.lastIndexOf("/") + 1);
            let id = file.path;
            if (!fm.present)
                issue({ file: file.path, rule: "header-missing", severity: "warn", message: "No Doc Header (YAML frontmatter)." });
            for (const e of fm.errors)
                issue({ file: file.path, rule: "header-invalid", severity: "error", message: e });
            if (fm.present && h) {
                if (!h.id || !h.kind || !h.title) {
                    issue({ file: file.path, rule: "header-invalid", severity: "error", message: "id, kind and title are required." });
                }
                if (h.id && !validDocId(h.id)) {
                    issue({ file: file.path, rule: "header-invalid", severity: "error", message: `id "${h.id}" must look like <kind>.<slug> ([a-z0-9.-]).` });
                }
                else if (h.id && nodes.has(h.id)) {
                    issue({ id: h.id, file: file.path, rule: "id-duplicate", severity: "error", message: `id "${h.id}" is also used by ${nodes.get(h.id).file}.` });
                }
                else if (h.id)
                    id = h.id;
                if (h.kind && !docKinds.has(h.kind)) {
                    issue({ id, file: file.path, rule: "kind-unknown", severity: "error", message: `kind "${h.kind}" is not a standard kind nor in docs.kinds.` });
                }
            }
            const kind = h?.kind && docKinds.has(h.kind) ? h.kind : fm.present && h?.kind ? "other" : "unclassified";
            const node = { id, label, kind, file: file.path, layer: "doc", feature: h?.feature ?? [], depth: 0 };
            if (h?.title)
                node.title = h.title;
            if (h?.status)
                node.status = h.status;
            nodes.set(id, node);
            pathToId.set(file.path, id);
        }
        for (const { file, fm } of parsed) {
            const from = pathToId.get(file.path);
            if (!from)
                continue;
            const h = fm.header;
            if (h?.parent) {
                if (nodes.has(h.parent) && nodes.get(h.parent).layer === "doc") {
                    addEdge(from, h.parent, "parent");
                    nodes.get(from).parent = h.parent;
                }
                else {
                    brokenRefs++;
                    issue({ id: from, file: file.path, rule: "ref-broken", severity: "error", message: `parent "${h.parent}" is not a known doc id.` });
                }
            }
            for (const r of h?.refs ?? []) {
                if (r.to.startsWith("er.")) {
                    if (input.mode === "all") {
                        if (!nodes.has(r.to))
                            nodes.set(r.to, { id: r.to, label: r.to.slice(3), kind: "er", file: "", layer: "er", feature: [], depth: 0 });
                        addEdge(from, r.to, r.type);
                    }
                    continue;
                }
                if (nodes.has(r.to))
                    addEdge(from, r.to, r.type);
                else {
                    brokenRefs++;
                    issue({ id: from, file: file.path, rule: "ref-broken", severity: "error", message: `refs.${r.type} names "${r.to}", which no doc declares.` });
                }
            }
            // Plain markdown links between docs ⇒ `mentions`.
            const body = file.text.length > 1_000_000 ? file.text.slice(0, 1_000_000) : file.text;
            for (const m of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
                const href = (m[1] ?? "").split("#")[0].trim();
                if (!href || /^[a-z]+:/i.test(href) || !href.toLowerCase().endsWith(".md"))
                    continue;
                let decoded = href;
                try {
                    decoded = decodeURIComponent(href);
                }
                catch {
                    // keep the raw href
                }
                const target = decoded.startsWith("/") ? normPath(decoded) : joinPath(dirOf(file.path), decoded);
                if (target === null)
                    continue;
                const to = pathToId.get(target);
                if (to)
                    addEdge(from, to, "mentions");
                else if (!isIgnored(target, ignore) && docs.length > 0) {
                    brokenRefs++;
                    issue({ id: from, file: file.path, rule: "ref-broken", severity: "error", message: `link to ${decoded} — no such file.` });
                }
            }
        }
    }
    // Code: a node per file, imports + header tags.
    if (wantCode) {
        const codeFiles = new Set(input.code.map((c) => c.path));
        const ctx = resolveCtx(codeFiles, input.configs);
        const headers = new Map();
        for (const f of input.code) {
            const h = parseCodeHeader(f.text);
            headers.set(f.path, h);
            const label = f.path.slice(f.path.lastIndexOf("/") + 1);
            const kind = h?.kind && CODE_KINDS.includes(h.kind) ? h.kind : inferCodeKind(f.path);
            nodes.set(f.path, { id: f.path, label, kind, file: f.path, layer: "code", feature: h?.feature ?? [], depth: 0 });
            if (!h)
                issue({ id: f.path, file: f.path, rule: "code-header-missing", severity: "warn", message: "No header comment." });
            else if (!h.kind)
                issue({ id: f.path, file: f.path, rule: "code-header-missing", severity: "warn", message: "Header has no @kind." });
            else if (!CODE_KINDS.includes(h.kind))
                issue({ id: f.path, file: f.path, rule: "kind-unknown", severity: "error", message: `@kind "${h.kind}" is not a code kind.` });
        }
        for (const f of input.code) {
            for (const spec of importSpecifiers(f.path, f.text)) {
                for (const to of resolveImport(ctx, f.path, spec))
                    if (to !== f.path)
                        addEdge(f.path, to, "imports");
            }
            if (input.mode === "all") {
                for (const ref of headers.get(f.path)?.refs ?? []) {
                    if (ref.startsWith("er.")) {
                        if (!nodes.has(ref))
                            nodes.set(ref, { id: ref, label: ref.slice(3), kind: "er", file: "", layer: "er", feature: [], depth: 0 });
                        addEdge(f.path, ref, "implements");
                    }
                    else if (nodes.has(ref) && nodes.get(ref).layer === "doc")
                        addEdge(f.path, ref, "implements");
                    else if (adopted) {
                        brokenRefs++;
                        issue({ id: f.path, file: f.path, rule: "ref-broken", severity: "warn", message: `@${ref.split(".")[0]} ${ref.slice(ref.indexOf(".") + 1)} — no doc with id "${ref}".` });
                    }
                }
            }
        }
    }
    // Tree + depth: docs by `parent`, code by an import BFS from the roots.
    const roots = [];
    let cycles = 0;
    const docNodes = [...nodes.values()].filter((n) => n.layer === "doc");
    for (const n of docNodes) {
        const seen = new Set([n.id]);
        let cur = n;
        let depth = 0;
        while (cur.parent) {
            const p = nodes.get(cur.parent);
            if (!p)
                break;
            if (seen.has(p.id)) {
                // A cycle: count it once (at its smallest id) and cut it here.
                if ([...seen].sort()[0] === n.id) {
                    cycles++;
                    issue({ id: n.id, file: n.file, rule: "parent-cycle", severity: "error", message: `parent chain loops back to ${p.id}.` });
                }
                break;
            }
            seen.add(p.id);
            depth++;
            cur = p;
        }
        n.depth = depth;
        if (!n.parent)
            roots.push(n.id);
    }
    const codeNodes = [...nodes.values()].filter((n) => n.layer === "code");
    if (codeNodes.length) {
        const out = new Map();
        const inbound = new Set();
        for (const e of edges) {
            if (e.type !== "imports")
                continue;
            out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
            inbound.add(e.to);
        }
        const codeRoots = codeNodes.filter((n) => n.kind === "entry" || !inbound.has(n.id)).map((n) => n.id);
        const visited = new Set();
        const bfs = (start) => {
            const queue = [...start];
            for (const s of start)
                visited.add(s);
            while (queue.length) {
                const id = queue.shift();
                const node = nodes.get(id);
                for (const to of out.get(id) ?? []) {
                    if (visited.has(to))
                        continue;
                    visited.add(to);
                    const child = nodes.get(to);
                    child.depth = node.depth + 1;
                    child.parent = id;
                    queue.push(to);
                }
            }
        };
        bfs(codeRoots);
        roots.push(...codeRoots);
        // Files reachable only through an import cycle: start a tree at each.
        for (const n of codeNodes) {
            if (visited.has(n.id))
                continue;
            roots.push(n.id);
            bfs([n.id]);
        }
    }
    for (const n of nodes.values()) {
        if (n.layer === "er")
            roots.push(n.id);
        if (n.depth > ideal)
            issue({ id: n.id, file: n.file || n.id, rule: "too-deep", severity: "warn", message: `depth ${n.depth} is over the ideal ${ideal}.` });
    }
    // Orphans: no inbound and no outbound edge.
    const touched = new Set();
    for (const e of edges) {
        touched.add(e.from);
        touched.add(e.to);
    }
    const orphans = [...nodes.keys()].filter((id) => !touched.has(id));
    for (const id of orphans) {
        const n = nodes.get(id);
        if (n.layer === "doc")
            issue({ id, file: n.file, rule: "orphan", severity: "warn", message: "No link in or out." });
    }
    // Metrics.
    const scored = [...nodes.values()].filter((n) => n.layer !== "er");
    const score = (list, cyc) => {
        if (!list.length)
            return 100;
        const ex = list.map((n) => Math.max(0, n.depth - ideal));
        const avg = ex.reduce((a, b) => a + b, 0) / ex.length;
        const max = Math.max(...ex);
        return Math.min(100, Math.max(1, Math.round(100 - 20 * avg - 5 * max - 10 * cyc)));
    };
    const children = new Map();
    for (const n of scored)
        if (n.parent)
            children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
    const perRoot = roots
        .filter((r) => nodes.get(r)?.layer !== "er")
        .map((r) => {
        const sub = [];
        const stack = [r];
        const seen = new Set();
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id))
                continue;
            seen.add(id);
            const n = nodes.get(id);
            if (n)
                sub.push(n);
            for (const c of children.get(id) ?? [])
                stack.push(c);
        }
        const base = nodes.get(r)?.depth ?? 0;
        const rel = sub.map((n) => ({ ...n, depth: n.depth - base }));
        return { id: r, depthScore: score(rel, 0), maxDepth: Math.max(0, ...rel.map((n) => n.depth)), size: sub.length };
    })
        .filter((p) => p.size > 1)
        .sort((a, b) => a.depthScore - b.depthScore || b.maxDepth - a.maxDepth)
        .slice(0, 50)
        .map(({ id, depthScore, maxDepth }) => ({ id, depthScore, maxDepth }));
    const depths = scored.map((n) => n.depth);
    const metrics = {
        depthScore: score(scored, cycles),
        maxDepth: depths.length ? Math.max(...depths) : 0,
        avgDepth: depths.length ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10 : 0,
        idealDepth: ideal,
        cycles,
        unclassified: scored.filter((n) => n.kind === "unclassified").length,
        brokenRefs,
        perRoot,
    };
    return { nodes: [...nodes.values()], edges, orphans, roots, metrics, issues };
}
