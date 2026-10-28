/**
 * Pure helpers that attribute autonomous work to people on GitHub / GitLab: the host login syntax checks, the
 * noreply e-mail of a `Co-authored-by` trailer (and back to a login), trailer parsing, display-name sanitising
 * for PR text, and the commit identity 4PM writes with. Shared by the cli (writes) and the identity sync (reads).
 * @adr 0671
 */
import type { GitAccountRef } from "./autonomous-policy";

/** The commit identity of the commits the cli makes itself. */
export const FOURPM_COMMIT_NAME = "4PM";
export const FOURPM_COMMIT_EMAIL = "noreply@4pm.app";
/** The synthetic login the identity sync records 4PM's own commits under (a bot). */
export const FOURPM_COMMIT_LOGIN = "4pm";

/** At most this many co-authors / assignees per commit or PR. */
export const HOST_PEOPLE_MAX = 5;
/** At most this many requested reviewers per PR. */
export const HOST_REVIEWERS_MAX = 3;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITLAB_LOGIN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;
const HOST_NAME = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** True when `login` has the host's login syntax (never starts with `-`, no spaces / newlines). */
export function isValidGitLogin(provider: "github" | "gitlab", login: string): boolean {
  return (provider === "github" ? GITHUB_LOGIN : GITLAB_LOGIN).test(login);
}

/** True when the whole account reference is safe to write into a trailer / command argument. */
export function isValidGitAccountRef(a: GitAccountRef): boolean {
  return (
    (a.provider === "github" || a.provider === "gitlab") &&
    HOST_NAME.test(a.host) &&
    isValidGitLogin(a.provider, a.login) &&
    /^\d{1,20}$/.test(a.providerUserId)
  );
}

/** The host's noreply e-mail of an account (GitHub `id+login@users.noreply.github.com`, GitLab `id-login@users.noreply.<host>`). */
export function gitNoreplyEmail(a: GitAccountRef): string {
  if (a.provider === "github") {
    const domain = a.host === "github.com" ? "users.noreply.github.com" : `users.noreply.${a.host}`;
    return `${a.providerUserId}+${a.login}@${domain}`;
  }
  return `${a.providerUserId}-${a.login}@users.noreply.${a.host}`;
}

/** The `Co-authored-by` trailer line of an account. */
export function coAuthorTrailer(a: GitAccountRef): string {
  return `Co-authored-by: ${a.login} <${gitNoreplyEmail(a)}>`;
}

/** The login a noreply e-mail names (null for any other address). */
export function loginFromNoreplyEmail(email: string): string | null {
  const m = /^\d+[+-]([A-Za-z0-9_.-]+)@users\.noreply\./i.exec(email.trim());
  return m?.[1] ?? null;
}

/** The co-author e-mails of a commit message (`Co-authored-by: Name <email>` lines, case-insensitive). */
export function coAuthorEmails(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const m = /^\s*co-authored-by:\s*[^<\n]*<([^>\s]+)>\s*$/i.exec(line);
    if (m?.[1] && !out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
  }
  return out;
}

/** A 4PM display name as plain PR text: one line, no `@` / markdown / HTML, at most 64 characters. */
export function plainPersonName(name: string): string {
  return name
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[@<>`*_[\]()#|!~\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/** True for a host login that is a bot: GitHub `[bot]`, GitLab group / project access-token users, 4PM's own. */
export function isBotGitLogin(login: string): boolean {
  return login.endsWith("[bot]") || /^(group|project)_\d+_bot(_[0-9a-f]+)?$/i.test(login) || login === FOURPM_COMMIT_LOGIN;
}
