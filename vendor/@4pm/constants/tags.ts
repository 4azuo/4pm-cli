/**
 * Custom tags: the code format, the color palette a tag may use, and the book metadata cell formats
 * (`Tags` = comma-separated codes, `Due` = an ISO date), and the areas a tag is offered in.
 * @adr 0543 @adr 0648
 */

/** A tag code: lowercase letters, digits and `-`, starting with a letter or digit, at most 32 chars. */
export const TAG_CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The palette tokens a tag color is picked from (the web maps each to theme-aware chip tones). */
export const TAG_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"] as const;

/** One tag color token. */
export type TagColor = (typeof TAG_COLORS)[number];

/** True when `value` is a palette token. */
export function isTagColor(value: string): value is TagColor {
  return (TAG_COLORS as readonly string[]).includes(value);
}

/** Where a tag is defined: the org catalog or one project. */
export const TagScope = {
  ORG: "org",
  PROJECT: "project",
} as const;
export type TagScope = (typeof TagScope)[keyof typeof TagScope];

/** A `Due` value: `YYYY-MM-DD`. */
export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The longest book row `Title` (one line, plain text — metadata like `Tags` / `Due`). @adr 0549 */
export const BOOK_TITLE_MAX = 80;

/** Limits of the tag fields. */
export const TAG_NAME_MAX = 40;
export const TAG_GROUP_MAX = 40;
/** The description is markdown (RichComposer). @adr 0648 */
export const TAG_DESCRIPTION_MAX = 2000;

/**
 * The areas a tag is offered in: `work` — books, discussions, My work, Content Overview; `marketing` — photo sets and
 * videos. Each picker offers only its area's tags. @adr 0648
 */
export const TAG_USAGES = ["work", "marketing"] as const;
export type TagUsage = (typeof TAG_USAGES)[number];

/** The label of a tag: `<group> - <name>`, or the name alone. @adr 0648 */
export function tagLabel(tag: { name: string; group?: string | null }): string {
  return tag.group ? `${tag.group} - ${tag.name}` : tag.name;
}
/** At most this many tags on one row / discussion. */
export const TAGS_PER_ITEM_MAX = 10;

/**
 * System request tags (not part of any tag catalog): put on a USER_TODO row, they limit what intake makes from it —
 * `docs-only` ⇒ only the DOC row of its group, no task; `asset-only` ⇒ only the AST row (generated assets), no task.
 * @adr 0613 @adr 0615
 */
export const REQUEST_SCOPE_TAGS = ["docs-only", "asset-only"] as const;
export type RequestScopeTag = (typeof REQUEST_SCOPE_TAGS)[number];

/** The scope tags present in a `Tags` cell. */
export function requestScopeTags(tagsCell: string): RequestScopeTag[] {
  const codes = tagsCell.split(/[,\s]+/).map((c) => c.trim());
  return REQUEST_SCOPE_TAGS.filter((t) => codes.includes(t));
}
