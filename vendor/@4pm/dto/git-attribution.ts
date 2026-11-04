/**
 * Vendored from @4pm/dto (git-attribution.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { GitAccountRef } from "./autonomous-policy";
export const FOURPM_COMMIT_NAME = "4PM";
export const FOURPM_COMMIT_EMAIL = "noreply@4pm.app";
export const FOURPM_COMMIT_LOGIN = "4pm";
export const HOST_PEOPLE_MAX = 5;
export const HOST_REVIEWERS_MAX = 3;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITLAB_LOGIN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;
const HOST_NAME = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
export function isValidGitLogin(provider: "github" | "gitlab", login: string): boolean {
    return (provider === "github" ? GITHUB_LOGIN : GITLAB_LOGIN).test(login);
}
export function isValidGitAccountRef(a: GitAccountRef): boolean {
    return ((a.provider === "github" || a.provider === "gitlab") &&
        HOST_NAME.test(a.host) &&
        isValidGitLogin(a.provider, a.login) &&
        /^\d{1,20}$/.test(a.providerUserId));
}
export function gitNoreplyEmail(a: GitAccountRef): string {
    if (a.provider === "github") {
        const domain = a.host === "github.com" ? "users.noreply.github.com" : `users.noreply.${a.host}`;
        return `${a.providerUserId}+${a.login}@${domain}`;
    }
    return `${a.providerUserId}-${a.login}@users.noreply.${a.host}`;
}
export function coAuthorTrailer(a: GitAccountRef): string {
    return `Co-authored-by: ${a.login} <${gitNoreplyEmail(a)}>`;
}
export function loginFromNoreplyEmail(email: string): string | null {
    const m = /^\d+[+-]([A-Za-z0-9_.-]+)@users\.noreply\./i.exec(email.trim());
    return m?.[1] ?? null;
}
export function coAuthorEmails(message: string): string[] {
    const out: string[] = [];
    for (const line of message.split(/\r?\n/)) {
        const m = /^\s*co-authored-by:\s*[^<\n]*<([^>\s]+)>\s*$/i.exec(line);
        if (m?.[1] && !out.includes(m[1].toLowerCase()))
            out.push(m[1].toLowerCase());
    }
    return out;
}
export function plainPersonName(name: string): string {
    return name
        .replace(/[\r\n\t]+/g, " ")
        .replace(/[@<>`*_[\]()#|!~\\]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);
}
export function isBotGitLogin(login: string): boolean {
    return login.endsWith("[bot]") || /^(group|project)_\d+_bot(_[0-9a-f]+)?$/i.test(login) || login === FOURPM_COMMIT_LOGIN;
}
