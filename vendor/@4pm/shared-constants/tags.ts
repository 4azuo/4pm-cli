/**
 * Vendored from @4pm/shared-constants (tags.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const TAG_CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TAG_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export function isTagColor(value: string): value is TagColor {
    return (TAG_COLORS as readonly string[]).includes(value);
}
export const TagScope = {
    ORG: "org",
    PROJECT: "project",
} as const;
export type TagScope = (typeof TagScope)[keyof typeof TagScope];
export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const BOOK_TITLE_MAX = 80;
export const TAG_NAME_MAX = 40;
export const TAG_GROUP_MAX = 40;
export const TAG_DESCRIPTION_MAX = 2000;
export const TAG_USAGES = ["work", "marketing"] as const;
export type TagUsage = (typeof TAG_USAGES)[number];
export function tagLabel(tag: {
    name: string;
    group?: string | null;
}): string {
    return tag.group ? `${tag.group} - ${tag.name}` : tag.name;
}
export const TAGS_PER_ITEM_MAX = 10;
export const REQUEST_SCOPE_TAGS = ["docs-only", "asset-only"] as const;
export type RequestScopeTag = (typeof REQUEST_SCOPE_TAGS)[number];
export function requestScopeTags(tagsCell: string): RequestScopeTag[] {
    const codes = tagsCell.split(/[,\s]+/).map((c) => c.trim());
    return REQUEST_SCOPE_TAGS.filter((t) => codes.includes(t));
}
