/**
 * Project ER model — the pure half of the per-module Mermaid `erDiagram` files: parse a diagram (entities,
 * attributes with type / keys / comment, relationships with cardinality and label), serialize it back,
 * union the module files into the master model (each entity owned by exactly one module), focus on one
 * entity and its neighbours, and the folder / id helpers shared by the cli, the server and the web.
 * @adr 0453 @arch 0053
 */

/** Default repo-relative folder of the ER module files (`erDir`). */
export const ER_ROOT = ".4pm/er";
/** Default repo-relative folder of the task / question sequence diagrams (`sequenceDir`). */
export const SEQUENCE_ROOT = ".4pm/sequences";
/** An ER module name — also its file name `<erDir>/<module>.md`. */
export const ER_MODULE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A numbered ER change request id. */
export const ERC_ID_RE = /^ERC-[1-9]\d{0,5}$/;
/** A placeholder ERC file written by an agent (numbered by the cli at publish). */
export const ERC_NEW_FILE_RE = /^ERC-NEW-[A-Za-z0-9_-]{1,40}\.md$/;
/** An entity name the parser accepts. */
const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A relationship line: `A <card> B : label` (cardinality per Mermaid crow's-foot notation). */
const REL_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s+(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/;
/** An attribute line: `type name [PK|FK|UK[, …]] ["comment"]`. */
const ATTR_RE = /^([A-Za-z_][A-Za-z0-9_\-[\]()]*)\s+([A-Za-z_][A-Za-z0-9_\-[\]()]*)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)(?:\s+"([^"]*)")?$/;

/** One attribute of an entity. */
export interface ErAttribute {
  type: string;
  name: string;
  /** `PK` / `FK` / `UK`, in source order. */
  keys: string[];
  comment: string;
}

/** One entity: name + attributes in source order. */
export interface ErEntity {
  name: string;
  attributes: ErAttribute[];
}

/** One relationship: `a <left><line><right> b : label`. */
export interface ErRelation {
  a: string;
  b: string;
  /** The full cardinality token, e.g. `||--o{`. */
  card: string;
  label: string;
}

/** A parsed diagram: declared entities (with an attribute block or a bare line) and relationships. */
export interface ErModel {
  entities: ErEntity[];
  relations: ErRelation[];
}

/** A parse problem (1-based line in the parsed text). */
export interface ErParseError {
  line: number;
  message: string;
}

/** An empty model. */
export function emptyErModel(): ErModel {
  return { entities: [], relations: [] };
}

/** The identity of a relationship (a pair + label — the cardinality is its value). */
export function erRelationKey(r: Pick<ErRelation, "a" | "b" | "label">): string {
  return `${r.a}|${r.b}|${r.label}`;
}

/** Is `a` the same attribute value as `b` (type, keys, comment)? */
export function sameErAttribute(a: ErAttribute | undefined, b: ErAttribute | undefined): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type && a.comment === b.comment && a.keys.join(",") === b.keys.join(",");
}

/**
 * The text of the first ```` ```mermaid ```` block whose diagram is an `erDiagram` (or the text itself when
 * it starts with `erDiagram`), with the 1-based line offset of the block in `md`; null when there is none.
 */
export function erDiagramBlock(md: string): { text: string; offset: number } | null {
  const lines = md.split(/\r?\n/);
  if (lines.find((l) => l.trim())?.trim().startsWith("erDiagram")) return { text: lines.join("\n"), offset: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```+\s*mermaid\b/.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*```+\s*$/.test(lines[j]!)) j++;
    const body = lines.slice(i + 1, j);
    if (body.find((l) => l.trim())?.trim().startsWith("erDiagram")) return { text: body.join("\n"), offset: i + 1 };
    i = j;
  }
  return null;
}

/** Is the brace at `i` part of a cardinality (`o{` / `|{` on the right, `}o` / `}|` on the left)? */
function cardinalityBrace(src: string, i: number): boolean {
  return src[i] === "{" ? /(--|\.\.)[o|]$/.test(src.slice(0, i)) : /^[o|](--|\.\.)/.test(src.slice(i + 1));
}

/** Split a diagram into logical lines, breaking at block braces outside quotes (so one-line blocks parse too). */
function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const src = raw.replace(/%%.*$/, "");
    let cur = "";
    let quoted = false;
    for (let k = 0; k < src.length; k++) {
      const ch = src[k]!;
      if (ch === '"') quoted = !quoted;
      if (!quoted && (ch === "{" || ch === "}") && !cardinalityBrace(src, k)) {
        if (ch === "{") cur += " {";
        out.push({ line: i + 1, text: cur.trim() });
        if (ch === "}") out.push({ line: i + 1, text: "}" });
        cur = "";
      } else cur += ch;
    }
    out.push({ line: i + 1, text: cur.trim() });
  });
  return out.filter((l) => l.text.length > 0);
}

/** Strip a Mermaid alias (`NAME["Display"]` / `NAME[Display]`) from an entity token. */
function bareName(token: string): string {
  return token.replace(/\[.*\]$/, "").trim();
}

/**
 * Parse `erDiagram` text — a bare diagram or a Markdown file holding one ```` ```mermaid ```` block. Entity
 * blocks may span lines or sit on one line; a repeated block merges its attributes; `classDef` / `class` /
 * `style` / `direction` / `title` lines are ignored. Never throws — problems come back as `errors`.
 */
export function parseErDiagram(source: string): { model: ErModel; errors: ErParseError[] } {
  const block = erDiagramBlock(source);
  const model = emptyErModel();
  const errors: ErParseError[] = [];
  if (!block) return { model, errors: source.trim() ? [{ line: 1, message: "no erDiagram block" }] : [] };
  const byName = new Map<string, ErEntity>();
  const declare = (name: string): ErEntity => {
    let e = byName.get(name);
    if (!e) {
      e = { name, attributes: [] };
      byName.set(name, e);
      model.entities.push(e);
    }
    return e;
  };
  let open: ErEntity | null = null;
  for (const { line, text } of logicalLines(block.text)) {
    const at = line + block.offset;
    if (text === "erDiagram" || /^(direction|title|classDef|class|style|accTitle|accDescr)\b/.test(text)) continue;
    if (open) {
      if (text === "}") {
        open = null;
        continue;
      }
      const m = ATTR_RE.exec(text);
      if (!m) {
        errors.push({ line: at, message: `invalid attribute "${text}"` });
        continue;
      }
      const attr: ErAttribute = {
        type: m[1]!,
        name: m[2]!,
        keys: (m[3] ?? "").split(/[\s,]+/).filter(Boolean),
        comment: m[4] ?? "",
      };
      const i = open.attributes.findIndex((x) => x.name === attr.name);
      if (i >= 0) open.attributes[i] = attr;
      else open.attributes.push(attr);
      continue;
    }
    const blockStart = /^(\S+)\s*\{$/.exec(text);
    if (blockStart) {
      const name = bareName(blockStart[1]!);
      if (!ENTITY_RE.test(name)) errors.push({ line: at, message: `invalid entity name "${name}"` });
      open = declare(name);
      continue;
    }
    const rel = REL_RE.exec(text);
    if (rel) {
      const label = rel[6]!.trim().replace(/^"(.*)"$/, "$1");
      const r: ErRelation = { a: rel[1]!, b: rel[5]!, card: `${rel[2]}${rel[3]}${rel[4]}`, label };
      const k = erRelationKey(r);
      const i = model.relations.findIndex((x) => erRelationKey(x) === k);
      if (i >= 0) model.relations[i] = r;
      else model.relations.push(r);
      continue;
    }
    const bare = bareName(text);
    if (ENTITY_RE.test(bare)) {
      declare(bare);
      continue;
    }
    errors.push({ line: at, message: `unrecognized line "${text}"` });
  }
  if (open) errors.push({ line: block.offset + block.text.split(/\r?\n/).length, message: `entity "${open.name}" is not closed` });
  return { model, errors };
}

/** Quote a comment / label for Mermaid (double quotes are not escapable — they become single quotes). */
function quote(s: string): string {
  return `"${s.replace(/"/g, "'")}"`;
}

/** One attribute line. */
export function erAttributeLine(a: ErAttribute): string {
  return [a.type, a.name, a.keys.join(", "), a.comment ? quote(a.comment) : ""].filter(Boolean).join(" ");
}

/** One relationship line. */
export function erRelationLine(r: ErRelation): string {
  return `${r.a} ${r.card} ${r.b} : ${quote(r.label)}`;
}

/** Serialize a model as `erDiagram` text (no fence): entity blocks, then relationships. */
export function serializeErDiagram(model: ErModel): string {
  const lines = ["erDiagram"];
  for (const e of model.entities) {
    if (e.attributes.length === 0) {
      lines.push(`  ${e.name} {`, "  }");
      continue;
    }
    lines.push(`  ${e.name} {`, ...e.attributes.map((a) => `    ${erAttributeLine(a)}`), "  }");
  }
  for (const r of model.relations) lines.push(`  ${erRelationLine(r)}`);
  return lines.join("\n");
}

/**
 * Replace the first `erDiagram` mermaid block of a Markdown file with `model` (or append a block when the
 * file has none) — the notes around it are kept byte-for-byte.
 */
export function replaceErDiagramBlock(md: string, model: ErModel, title?: string): string {
  const fenced = "```mermaid\n" + serializeErDiagram(model) + "\n```";
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```+\s*mermaid\b/.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*```+\s*$/.test(lines[j]!)) j++;
    if (lines.slice(i + 1, j).find((l) => l.trim())?.trim().startsWith("erDiagram")) {
      lines.splice(i, j - i + 1, ...fenced.split("\n"));
      return lines.join("\n");
    }
    i = j;
  }
  const head = md.trim() ? md.replace(/\s*$/, "\n\n") : `# ${title ?? "ER"}\n\n`;
  return `${head}${fenced}\n`;
}

/** The master model: the union of the module models, with each entity's owning module. */
export interface ErMaster {
  model: ErModel;
  /** Entity name → the module that declares it. */
  owner: Record<string, string>;
  /** Entities declared in more than one module (an invalid ER) — `[name, modules…]`. */
  duplicates: [string, ...string[]][];
}

/** Union module models into the master (module order = `order`, then by name). */
export function erMasterOf(modules: Record<string, ErModel>, order: readonly string[] = []): ErMaster {
  const names = [...new Set([...order.filter((m) => modules[m]), ...Object.keys(modules).sort()])];
  const model = emptyErModel();
  const owner: Record<string, string> = {};
  const dupes = new Map<string, string[]>();
  const rels = new Map<string, ErRelation>();
  for (const m of names) {
    for (const e of modules[m]!.entities) {
      if (owner[e.name] !== undefined) {
        dupes.set(e.name, [...(dupes.get(e.name) ?? [owner[e.name]!]), m]);
        continue;
      }
      owner[e.name] = m;
      model.entities.push(e);
    }
    for (const r of modules[m]!.relations) rels.set(erRelationKey(r), r);
  }
  model.relations = [...rels.values()];
  return { model, owner, duplicates: [...dupes.entries()].map(([n, ms]) => [n, ...ms] as [string, ...string[]]) };
}

/** Every entity name a model mentions (declared or only referenced by a relationship). */
export function erEntityNames(model: ErModel): string[] {
  return [...new Set([...model.entities.map((e) => e.name), ...model.relations.flatMap((r) => [r.a, r.b])])];
}

/**
 * The sub-model around `names`: those entities in full, their relationships, and the one-hop neighbours
 * (referenced only — they render as name-only boxes). `neighbours` lists them.
 */
export function erFocus(model: ErModel, names: readonly string[]): { model: ErModel; neighbours: string[] } {
  const keep = new Set(names);
  const relations = model.relations.filter((r) => keep.has(r.a) || keep.has(r.b));
  const neighbours = [...new Set(relations.flatMap((r) => [r.a, r.b]).filter((n) => !keep.has(n)))];
  return { model: { entities: model.entities.filter((e) => keep.has(e.name)), relations }, neighbours };
}

/** A sequence diagram path for a task / question id (`<sequenceDir>/<ID>.md`). */
export function sequencePathOf(sequenceDir: string, id: string): string {
  return `${sequenceDir}/${id}.md`;
}

/** The ERC id of a change-request path (`<erDir>/changes/ERC-<n>.md`), or null. */
export function ercIdOfPath(path: string): string | null {
  const m = /(?:^|\/)changes\/(ERC-[1-9]\d{0,5})\.md$/.exec(path);
  return m ? m[1]! : null;
}
