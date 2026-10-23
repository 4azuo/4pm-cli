/**
 * The asset phase's pure-ish helpers: an `AST-…` row's plan (from the docs sidecar, else a JSON list in the
 * row's Notes), the provider parameters of one asset (its description + the reviewer's instruction + the
 * `## Assets` style of `EVIDENCE_GUIDE.md`), and where its images are written under the spec's `asset_dir`.
 * @adr 0615 @adr 0614
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_ASSET_DIR, parseAssetItems, readSpecAssetDir, type AssetItem } from "@4pm/dto";
import type { GeneratorImage, GeneratorParams } from "@4pm/ws";
import { gitQuiet } from "./autonomous-git";

/** At most this many assets are generated per round; the rest wait for the next one. */
export const ASSET_MAX_PER_ROUND = 10;
/** The longest description sent to a provider. */
const DESCRIPTION_MAX = 1500;

/** A plan written by a person in the row's Notes: the first JSON array (inside a ```json fence or bare). */
export function planFromNotes(notes: string): AssetItem[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(notes)?.[1];
  const text = fenced ?? notes.slice(notes.indexOf("["), notes.lastIndexOf("]") + 1);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parseAssetItems(Array.isArray(parsed) ? parsed : (parsed as { items?: unknown })?.items);
  } catch {
    return [];
  }
}

/** Which assets this round generates: every one in round 1, else those marked for regeneration — capped. */
export function assetsToGenerate(items: readonly AssetItem[], round: number): AssetItem[] {
  const todo = round <= 1 ? items.filter((a) => a.files.length === 0 || a.regenerate) : items.filter((a) => a.regenerate || a.files.length === 0);
  // An animation needs its source first: sources before the items that animate them.
  const order = [...todo].sort((a, b) => Number(Boolean(a.from)) - Number(Boolean(b.from)));
  return order.slice(0, ASSET_MAX_PER_ROUND);
}

/** The provider-neutral parameters of one asset. */
export function assetParams(item: AssetItem, style: string, firstFrame?: string): GeneratorParams {
  const parts = [item.description];
  if (item.regenerate) parts.push(`Change from the previous version: ${item.regenerate}`);
  if (style) parts.push(`Project style: ${style}`);
  return {
    description: parts.join("\n").slice(0, DESCRIPTION_MAX),
    width: item.width,
    height: item.height,
    ...(item.directions ? { directions: item.directions } : {}),
    ...(item.frames ? { frames: item.frames } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(item.view ? { view: item.view } : {}),
    ...(item.lower ? { lower: item.lower } : {}),
    ...(item.upper ? { upper: item.upper } : {}),
    noBackground: true,
  };
}

/** A file-name-safe version of an image label. */
function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

/**
 * Repo paths of an asset's images: one image ⇒ `<assetDir>/<path>` (`.png` added); several ⇒ a folder
 * `<assetDir>/<path without .png>/<label>.png`.
 */
export function assetFilePaths(assetDir: string, item: AssetItem, images: readonly GeneratorImage[]): string[] {
  const base = `${assetDir}/${item.path}`.replace(/\/+/g, "/");
  if (images.length === 1) return [base.endsWith(".png") ? base : `${base}.png`];
  const folder = base.replace(/\.png$/, "");
  const seen = new Map<string, number>();
  return images.map((img) => {
    const name = safeLabel(img.label);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return `${folder}/${n > 1 ? `${name}-${n}` : name}.png`;
  });
}

/** Write the images (base64 PNG) at their repo paths under `root`. */
export async function writeAssetFiles(root: string, paths: readonly string[], images: readonly GeneratorImage[]): Promise<void> {
  for (let i = 0; i < paths.length; i++) {
    const abs = join(root, paths[i]!);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(images[i]!.base64, "base64"));
  }
}

/** The spec's `asset_dir` on `origin/<base>` (the default when there is no spec). */
export async function specAssetDirAt(root: string, base: string | null): Promise<string> {
  if (!base) return DEFAULT_ASSET_DIR;
  const text = await gitQuiet(root, ["show", `origin/${base}:project.spec.json`]).catch(() => "");
  try {
    return readSpecAssetDir(JSON.parse(text || "{}"));
  } catch {
    return DEFAULT_ASSET_DIR;
  }
}
