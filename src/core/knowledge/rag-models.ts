/**
 * The RAG model catalog: each embedding model's Hugging Face repo, how the engine embeds with it (pooling, query /
 * document prefixes), what it reads, its licence and what the worker needs to run it. Only models whose licence allows
 * commercial use without extra terms (MIT / Apache-2.0) are listed. The engine gets the profiles embedded; the panel's
 * options are computed from the machine's RAM / disk.
 * @adr 0642 @adr 0489
 */
import type { RagMachine, RagOption } from "@4pm/ws";

/** How a model's token vectors become one vector. */
export type RagPooling = "mean" | "cls";

/** One catalog model. */
export interface RagModelProfile {
  id: string;
  label: string;
  model: string;
  sizeMB: number;
  languages: "en" | "multi" | "code";
  license: "MIT" | "Apache-2.0";
  pooling: RagPooling;
  /** Prepended to a search query. */
  queryPrefix: string;
  /** Prepended to an indexed chunk. */
  docPrefix: string;
  /** Also index source files (kind `code`). */
  indexesCode: boolean;
  /** Offered only with at least this much RAM / free disk. */
  minRamGB: number;
  minDiskGB: number;
  note: string;
}

/** bge v1.5's recommended instruction for short queries. */
const BGE_QUERY = "Represent this sentence for searching relevant passages: ";

/** The catalog, in display order. */
export const RAG_MODELS: readonly RagModelProfile[] = [
  {
    id: "e5-small",
    label: "Multilingual · e5-small (~100 languages)",
    model: "Xenova/multilingual-e5-small",
    sizeMB: 118,
    languages: "multi",
    license: "MIT",
    pooling: "mean",
    queryPrefix: "query: ",
    docPrefix: "passage: ",
    indexesCode: false,
    minRamGB: 0,
    minDiskGB: 1,
    note: "Good multilingual search at a small size.",
  },
  {
    id: "e5-base",
    label: "Multilingual · e5-base (~100 languages)",
    model: "Xenova/multilingual-e5-base",
    sizeMB: 280,
    languages: "multi",
    license: "MIT",
    pooling: "mean",
    queryPrefix: "query: ",
    docPrefix: "passage: ",
    indexesCode: false,
    minRamGB: 8,
    minDiskGB: 2,
    note: "Better multilingual search, needs ≥ 8 GB RAM.",
  },
  {
    id: "multilingual",
    label: "Multilingual · MiniLM-L12 (50+ languages)",
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    sizeMB: 130,
    languages: "multi",
    license: "Apache-2.0",
    pooling: "mean",
    queryPrefix: "",
    docPrefix: "",
    indexesCode: false,
    minRamGB: 0,
    minDiskGB: 1.5,
    note: "Best for content in several languages.",
  },
  {
    id: "small",
    label: "Small · bge-small (English)",
    model: "Xenova/bge-small-en-v1.5",
    sizeMB: 35,
    languages: "en",
    license: "MIT",
    pooling: "cls",
    queryPrefix: BGE_QUERY,
    docPrefix: "",
    indexesCode: false,
    minRamGB: 0,
    minDiskGB: 0,
    note: "Lightweight, low RAM.",
  },
  {
    id: "base",
    label: "Base · bge-base (English)",
    model: "Xenova/bge-base-en-v1.5",
    sizeMB: 110,
    languages: "en",
    license: "MIT",
    pooling: "cls",
    queryPrefix: BGE_QUERY,
    docPrefix: "",
    indexesCode: false,
    minRamGB: 8,
    minDiskGB: 2,
    note: "Higher-quality English, needs ≥ 8 GB RAM.",
  },
  {
    id: "code",
    label: "Code · jina-v2-base-code (code + English)",
    model: "jinaai/jina-embeddings-v2-base-code",
    sizeMB: 160,
    languages: "code",
    license: "Apache-2.0",
    pooling: "mean",
    queryPrefix: "",
    docPrefix: "",
    indexesCode: true,
    minRamGB: 8,
    minDiskGB: 2,
    note: "Searches source files too, needs ≥ 8 GB RAM.",
  },
  {
    id: "m3",
    label: "Large · bge-m3 (100+ languages)",
    model: "Xenova/bge-m3",
    sizeMB: 570,
    languages: "multi",
    license: "MIT",
    pooling: "cls",
    queryPrefix: "",
    docPrefix: "",
    indexesCode: false,
    minRamGB: 12,
    minDiskGB: 3,
    note: "Strong on long documents, needs ≥ 12 GB RAM.",
  },
  {
    id: "arctic-l",
    label: "Large · Arctic Embed L v2.0 (multilingual)",
    model: "Snowflake/snowflake-arctic-embed-l-v2.0",
    sizeMB: 570,
    languages: "multi",
    license: "Apache-2.0",
    pooling: "cls",
    queryPrefix: "query: ",
    docPrefix: "",
    indexesCode: false,
    minRamGB: 12,
    minDiskGB: 3,
    note: "Top retrieval quality, needs ≥ 12 GB RAM.",
  },
];

/** The reranker the optional `rerank` setting downloads (cross-encoder, MIT). */
export const RAG_RERANKER = { model: "Xenova/bge-reranker-base", sizeMB: 280, license: "MIT" } as const;

/** The profile of a model repo, or null for one outside the catalog. */
export function profileOf(model: string): RagModelProfile | null {
  return RAG_MODELS.find((m) => m.model === model) ?? null;
}

/** The install options for a machine: the models it can hold, one recommended (e5-base from 8 GB RAM, else e5-small). */
export function ragOptionsFor(m: RagMachine): RagOption[] {
  const recommended = m.ramGB >= 8 && m.diskFreeGB > 2 ? "e5-base" : "e5-small";
  return RAG_MODELS.filter((p) => m.ramGB >= p.minRamGB && m.diskFreeGB > p.minDiskGB).map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
    sizeMB: p.sizeMB,
    recommended: p.id === recommended,
    note: p.note,
    languages: p.languages,
    license: p.license,
    indexesCode: p.indexesCode,
  }));
}

/** The profiles the engine needs, keyed by repo (embedded into the generated engine). */
export function engineProfiles(): Record<string, { pooling: RagPooling; queryPrefix: string; docPrefix: string; indexesCode: boolean }> {
  return Object.fromEntries(RAG_MODELS.map((p) => [p.model, { pooling: p.pooling, queryPrefix: p.queryPrefix, docPrefix: p.docPrefix, indexesCode: p.indexesCode }]));
}
