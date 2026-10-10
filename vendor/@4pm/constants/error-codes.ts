/**
 * Catalog of errorCodes returned in BaseResponse when success=false
 * (ADR-0009, spec 21-api/02-error-codes.md — the source of truth at implementation time).
 */

/** Application error codes — SCREAMING_SNAKE_CASE, grouped by domain. */
export const ErrorCode = {
  // Common
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  IP_NOT_ALLOWED: "IP_NOT_ALLOWED",
  // A user's IP allowlist entry falls outside the org allowlist (ADR-0044).
  IP_OUTSIDE_ORG_ALLOWLIST: "IP_OUTSIDE_ORG_ALLOWLIST",
  // An allowlist entry falls outside its parent tier: a team/project outside the
  // org, or a user outside the union of their teams'/projects' allowlists (ADR-0050).
  IP_OUTSIDE_PARENT_ALLOWLIST: "IP_OUTSIDE_PARENT_ALLOWLIST",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_AVAILABLE: "FEATURE_NOT_AVAILABLE",
  // Request body exceeded the HTTP gateway's JSON size limit (see HTTP_JSON_BODY_LIMIT_BYTES).
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  // Unified composer attachments (ADR-0388): an upload over ATTACHMENT_MAX_BYTES, a MIME outside the
  // image + file lists, or a submit carrying more than ATTACHMENT_MAX_COUNT refs.
  ATTACHMENT_TOO_LARGE: "ATTACHMENT_TOO_LARGE",
  ATTACHMENT_TYPE_UNSUPPORTED: "ATTACHMENT_TYPE_UNSUPPORTED",
  ATTACHMENT_LIMIT_EXCEEDED: "ATTACHMENT_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // auth
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_USED: "TOKEN_USED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  /** The session is idle-locked — re-authenticate to continue (HTTP 423). @adr 0204 */
  SESSION_LOCKED: "SESSION_LOCKED",
  PASSWORD_POLICY_VIOLATION: "PASSWORD_POLICY_VIOLATION",
  PASSWORD_CONFIRM_MISMATCH: "PASSWORD_CONFIRM_MISMATCH",
  PASSWORD_CURRENT_INVALID: "PASSWORD_CURRENT_INVALID",
  /** The new password appears in a known data breach (Have I Been Pwned). @adr 0426 */
  PASSWORD_BREACHED: "PASSWORD_BREACHED",
  IDENTITY_REQUIRED: "IDENTITY_REQUIRED",
  MFA_CODE_INVALID: "MFA_CODE_INVALID",
  MFA_CODE_EXPIRED: "MFA_CODE_EXPIRED",
  // org · user · team · project
  USER_NOT_FOUND: "USER_NOT_FOUND",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  ORG_NOT_FOUND: "ORG_NOT_FOUND",
  // org login alias (ADR-0111): alias already used by another org, or a reserved word
  ORG_ALIAS_TAKEN: "ORG_ALIAS_TAKEN",
  // org template files (ADR-0113)
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  TEMPLATE_QUOTA_EXCEEDED: "TEMPLATE_QUOTA_EXCEEDED",
  TEMPLATE_FILE_TOO_LARGE: "TEMPLATE_FILE_TOO_LARGE",
  // skill/subagent marketplace (ADR-0185)
  MARKET_PACKAGE_NOT_FOUND: "MARKET_PACKAGE_NOT_FOUND",
  MARKET_VERSION_NOT_FOUND: "MARKET_VERSION_NOT_FOUND",
  MARKET_PACKAGE_EXISTS: "MARKET_PACKAGE_EXISTS",
  MARKET_VERSION_EXISTS: "MARKET_VERSION_EXISTS",
  MARKET_INVALID_PACKAGE: "MARKET_INVALID_PACKAGE",
  MARKET_SCOPE_FORBIDDEN: "MARKET_SCOPE_FORBIDDEN",
  MARKET_SCOPE_UNSUPPORTED: "MARKET_SCOPE_UNSUPPORTED",
  MARKET_VERSION_NOT_APPROVED: "MARKET_VERSION_NOT_APPROVED",
  MARKET_NOT_MODERATABLE: "MARKET_NOT_MODERATABLE",
  MARKET_UNAVAILABLE: "MARKET_UNAVAILABLE",
  MARKET_REVIEW_NOT_ELIGIBLE: "MARKET_REVIEW_NOT_ELIGIBLE",
  MARKET_PAYMENT_REQUIRED: "MARKET_PAYMENT_REQUIRED",
  MARKET_ORDER_NOT_FOUND: "MARKET_ORDER_NOT_FOUND",
  MARKET_ALREADY_PURCHASED: "MARKET_ALREADY_PURCHASED",
  KNOWLEDGE_POST_NOT_FOUND: "KNOWLEDGE_POST_NOT_FOUND",
  KNOWLEDGE_SCOPE_FORBIDDEN: "KNOWLEDGE_SCOPE_FORBIDDEN",
  // 4rum post / Messenger message missing or not visible — also a cursor anchor (ADR-0341/0361)
  POST_NOT_FOUND: "POST_NOT_FOUND",
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  PACKAGE_ALREADY_INSTALLED: "PACKAGE_ALREADY_INSTALLED",
  // org total hosted storage cap (ADR-0122/0365) — blocks text writes, uploads, memo/book writes and new AI runs
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  // Self-managed storage clear (ADR-0365): typed org-name confirmation mismatch; a kind the service
  // cannot clear; a clear already running for the org.
  STORAGE_CLEAR_CONFIRM_MISMATCH: "STORAGE_CLEAR_CONFIRM_MISMATCH",
  STORAGE_CLEAR_KIND_INVALID: "STORAGE_CLEAR_KIND_INVALID",
  STORAGE_CLEAR_RUNNING: "STORAGE_CLEAR_RUNNING",
  // project lifecycle (ADR-0092): invalid transition / operation on a paused|closed project
  PROJECT_STATE_INVALID: "PROJECT_STATE_INVALID",
  PROJECT_NOT_ACTIVE: "PROJECT_NOT_ACTIVE",
  // user pause (ADR-0093): user is paused (blocks login/API/token/WS) / invalid pause transition
  USER_PAUSED: "USER_PAUSED",
  USER_STATE_INVALID: "USER_STATE_INVALID",
  // org pause (ADR-0094 admin-0013): whole org paused ⇒ blocks all its users' login/API/token
  ORG_PAUSED: "ORG_PAUSED",
  // project-membership pause (ADR-0093): invalid membership pause transition
  MEMBER_STATE_INVALID: "MEMBER_STATE_INVALID",
  // soft-delete restore (ADR-0109): restore a record that is not currently deleted
  PROJECT_NOT_DELETED: "PROJECT_NOT_DELETED",
  TEAM_NOT_DELETED: "TEAM_NOT_DELETED",
  USER_NOT_DELETED: "USER_NOT_DELETED",
  USERNAME_TAKEN: "USERNAME_TAKEN",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  // email omitted while the org disallows sub-accounts without email (ADR-0039)
  EMAIL_REQUIRED: "EMAIL_REQUIRED",
  // contact-change (self email/phone) verification (ADR-0046)
  // email and phone cannot be changed in the same request
  CONTACT_CHANGE_BOTH: "CONTACT_CHANGE_BOTH",
  // a contact-change is already pending — resolve it before editing again
  CONTACT_CHANGE_PENDING: "CONTACT_CHANGE_PENDING",
  // the verifying channel is missing (e.g. no phone on file to OTP an email change)
  CONTACT_CHANGE_CHANNEL_MISSING: "CONTACT_CHANGE_CHANNEL_MISSING",
  // the submitted OTP / link token is invalid or expired
  CONTACT_CHANGE_INVALID: "CONTACT_CHANGE_INVALID",
  // self email/phone must go through the contact-change flow (not a direct update)
  CONTACT_CHANGE_REQUIRED: "CONTACT_CHANGE_REQUIRED",
  ROLE_EXCLUSIVE: "ROLE_EXCLUSIVE",
  ROOT_IMMUTABLE: "ROOT_IMMUTABLE",
  // ADMIN role is reserved for the org root; it cannot be granted to sub-accounts
  ADMIN_ROLE_RESERVED: "ADMIN_ROLE_RESERVED",
  // a PM may only assign roles below PM (never PM/ADMIN/MACHINE) — anti-escalation (ADR-0051)
  USER_ROLE_ASSIGN_FORBIDDEN: "USER_ROLE_ASSIGN_FORBIDDEN",
  // an ADMIN account manages the org only — it cannot be attached to teams/projects
  ADMIN_NOT_ASSIGNABLE: "ADMIN_NOT_ASSIGNABLE",
  // a MACHINE account is a worker — it cannot be a project manager (ADR-0041)
  MACHINE_NOT_MANAGER: "MACHINE_NOT_MANAGER",
  // a MACHINE account may be a member of at most one project (ADR-0041)
  MACHINE_ALREADY_IN_PROJECT: "MACHINE_ALREADY_IN_PROJECT",
  // a MACHINE account is a worker, not a human member — it cannot join a team (ADR-0041)
  MACHINE_NOT_TEAM_MEMBER: "MACHINE_NOT_TEAM_MEMBER",
  ALREADY_ATTACHED: "ALREADY_ATTACHED",
  NOT_ATTACHED: "NOT_ATTACHED",
  SELF_DELETE_FORBIDDEN: "SELF_DELETE_FORBIDDEN",
  SELF_SET_PASSWORD_FORBIDDEN: "SELF_SET_PASSWORD_FORBIDDEN",
  AVATAR_INVALID_TYPE: "AVATAR_INVALID_TYPE",
  AVATAR_TOO_LARGE: "AVATAR_TOO_LARGE",
  // permission
  PERMISSION_CODE_INVALID: "PERMISSION_CODE_INVALID",
  SUBJECT_INVALID: "SUBJECT_INVALID",
  // machine
  HASHCODE_INVALID: "HASHCODE_INVALID",
  HASHCODE_EXPIRED: "HASHCODE_EXPIRED",
  LINK_REVOKED: "LINK_REVOKED",
  LINK_NOT_FOUND: "LINK_NOT_FOUND",
  WORKER_OFFLINE: "WORKER_OFFLINE",
  // Two AI profiles in a worker config name the same profile dir (ADR-0409).
  PROFILE_DIR_DUPLICATE: "PROFILE_DIR_DUPLICATE",
  // command-0001 pick:"idle" (ADR-0171) — no idle cli in the project's pool
  ALL_CLIS_BUSY: "ALL_CLIS_BUSY",
  // worker pools (ADR-0284)
  WORKER_POOL_NOT_FOUND: "WORKER_POOL_NOT_FOUND",
  WORKER_POOL_NAME_TAKEN: "WORKER_POOL_NAME_TAKEN",
  WORKER_POOL_ATTACHED: "WORKER_POOL_ATTACHED",
  WORKER_POOL_ALREADY_ATTACHED: "WORKER_POOL_ALREADY_ATTACHED",
  // A pool can't be both a project pool and the org AI pool (ADR-0376 mutual exclusivity).
  AI_POOL_CONFLICT: "AI_POOL_CONFLICT",
  // No org AI pool configured (Settings) for a project-less org AI task (ADR-0376).
  AI_POOL_NOT_CONFIGURED: "AI_POOL_NOT_CONFIGURED",
  // The serving worker has no CLI for the spec's AI provider — create/add refused (ADR-0396).
  AI_CLI_MISSING: "AI_CLI_MISSING",
  // Change-request (ADR-0379) not found / already resolved.
  CHANGE_REQUEST_NOT_FOUND: "CHANGE_REQUEST_NOT_FOUND",
  CHANGE_REQUEST_ALREADY_RESOLVED: "CHANGE_REQUEST_ALREADY_RESOLVED",
  // org AI Research (ADR-0380): question refused by the content policy / research-guard; row not found.
  RESEARCH_REFUSED: "RESEARCH_REFUSED",
  RESEARCH_NOT_FOUND: "RESEARCH_NOT_FOUND",
  MACHINE_ALREADY_IN_POOL: "MACHINE_ALREADY_IN_POOL",
  NOT_MACHINE_USER: "NOT_MACHINE_USER",
  // worker · physic project
  WORKER_NOT_FOUND: "WORKER_NOT_FOUND",
  PHYSIC_PROJECT_NOT_FOUND: "PHYSIC_PROJECT_NOT_FOUND",
  PHYSIC_PATH_OCCUPIED: "PHYSIC_PATH_OCCUPIED",
  AUTONOMOUS_CONFLICT: "AUTONOMOUS_CONFLICT",
  // A disruptive worker op (repo (re)provision / CLI update) was refused because the target
  // worker's autonomous mode is armed (installed && !paused) — stop it first (ADR-0317).
  AUTONOMOUS_ACTIVE: "AUTONOMOUS_ACTIVE",
  // Separation of duties (ADR-0320): a non-ADMIN tried to approve a row they wrote — the writer can't
  // be the approver of their own row (ADMIN may self-approve).
  APPROVAL_SELF: "APPROVAL_SELF",
  // Signed approvals (ADR-0438): the row changed after the approver read it — its content hash no longer
  // matches the book the approval targets; reload and approve again. meta.id = the row.
  APPROVAL_STALE: "APPROVAL_STALE",
  // Networks (ADR-0439): a deny rule / block request names a system host (always allowed).
  NETWORK_RULE_SYSTEM_HOST: "NETWORK_RULE_SYSTEM_HOST",
  // An allow request / approval matches the org denylist, which a project cannot override.
  NETWORK_ORG_DENIED: "NETWORK_ORG_DENIED",
  // The network request was already decided or cancelled.
  NETWORK_REQUEST_NOT_PENDING: "NETWORK_REQUEST_NOT_PENDING",
  // A non-ADMIN tried to approve their own network request.
  NETWORK_REQUEST_SELF: "NETWORK_REQUEST_SELF",
  CLI_VERSION_UNSUPPORTED: "CLI_VERSION_UNSUPPORTED",
  // The worker runs an update-locked image (ADR-0432/0434): a cli update is refused — pull a newer image.
  CLI_UPDATE_LOCKED: "CLI_UPDATE_LOCKED",
  // Admin cli version policy rejected (ADR-0363) — meta.reason: minAboveLatest | latestNotBlockable |
  // deadlinePast | invalidVersion.
  CLI_VERSION_POLICY_INVALID: "CLI_VERSION_POLICY_INVALID",
  ORCHESTRATOR_OFFLINE: "ORCHESTRATOR_OFFLINE",
  WS_TOKEN_INVALID: "WS_TOKEN_INVALID",
  // A newer cli session for the same link took over ⇒ the older one stops (ADR-0047).
  SESSION_REPLACED: "SESSION_REPLACED",
  PATH_INVALID: "PATH_INVALID",
  // project create/add
  SPEC_INVALID: "SPEC_INVALID",
  PATH_OCCUPIED: "PATH_OCCUPIED",
  GIT_ENV_MISSING: "GIT_ENV_MISSING",
  CLAUDE_CLI_MISSING: "CLAUDE_CLI_MISSING",
  SCAFFOLD_FAILED: "SCAFFOLD_FAILED",
  GIT_OPERATION_FAILED: "GIT_OPERATION_FAILED",
  AI_INIT_FAILED: "AI_INIT_FAILED",
  // AI spec-assist (suggest/review/compose) run failed on the worker cli (ADR-0100).
  AI_ASSIST_FAILED: "AI_ASSIST_FAILED",
  // Client-side guard (ADR-0255): the built AI prompt is longer than AI_PROMPT_MAX_LEN, so the
  // web blocks the dispatch and shows an actionable "spec too large" message instead of letting
  // the server reject it as a confusing VALIDATION_FAILED.
  AI_PROMPT_TOO_LARGE: "AI_PROMPT_TOO_LARGE",
  // Server-managed prompt catalog (ADR-0381): the key is not in the @4pm/constants registry.
  AI_PROMPT_KEY_UNKNOWN: "AI_PROMPT_KEY_UNKNOWN",
  // The submitted template is missing a required `{{var}}` the builder depends on.
  AI_PROMPT_TEMPLATE_INVALID: "AI_PROMPT_TEMPLATE_INVALID",
  // Prompt editing is disabled by the AI_PROMPTS_READONLY env flag (use the defaults).
  AI_PROMPTS_READONLY: "AI_PROMPTS_READONLY",
  // Terms & policies editing is disabled by the LEGAL_READONLY env flag.
  LEGAL_READONLY: "LEGAL_READONLY",
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
  // invitation
  INVITATION_TOKEN_INVALID: "INVITATION_TOKEN_INVALID",
  INVITATION_ALREADY_ACCEPTED: "INVITATION_ALREADY_ACCEPTED",
  INVITATION_ROLE_FORBIDDEN: "INVITATION_ROLE_FORBIDDEN",
  // notification
  NOTIFICATION_NOT_FOUND: "NOTIFICATION_NOT_FOUND",
  // sso (ADR-0024)
  SSO_IDENTITY_NOT_LINKED: "SSO_IDENTITY_NOT_LINKED",
  SSO_PROVIDER_INVALID: "SSO_PROVIDER_INVALID",
  // Cannot unlink the last remaining login method (SSO-only user, ADR-0161)
  SSO_LAST_LOGIN_METHOD: "SSO_LAST_LOGIN_METHOD",
  PASSWORD_NOT_SET: "PASSWORD_NOT_SET",
  // command · memo
  COMMAND_NOT_FOUND: "COMMAND_NOT_FOUND",
  // Stop requested for a command that already settled (done/failed/cancelled — ADR-0362).
  COMMAND_ALREADY_FINISHED: "COMMAND_ALREADY_FINISHED",
  COMMAND_DISPATCH_LIMITED: "COMMAND_DISPATCH_LIMITED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  // A single prompt's estimated tokens exceed project `settings.tokens.perPromptTokenLimit` (ADR-0081).
  PROMPT_TOKEN_LIMIT_EXCEEDED: "PROMPT_TOKEN_LIMIT_EXCEEDED",
  // An outbound cli evaluated the input as NG (secret/path/repo/environment) — ADR-0082.
  OUTBOUND_REVIEW_REJECTED: "OUTBOUND_REVIEW_REJECTED",
  // No outbound cli available (offline/busy/out-of-token) while review is on — ADR-0082.
  OUTBOUND_REVIEW_UNAVAILABLE: "OUTBOUND_REVIEW_UNAVAILABLE",
  // A saved outbound rule regex fails to compile or is ReDoS-unsafe (ADR-0087).
  OUTBOUND_RULE_INVALID: "OUTBOUND_RULE_INVALID",
  // Console image attachment blocked because the project has `outboundReview.blockImages` (ADR-0257).
  IMAGE_UPLOAD_BLOCKED: "IMAGE_UPLOAD_BLOCKED",
  MEMO_TOO_LONG: "MEMO_TOO_LONG",
  // plan entitlements (ADR-0105) — resource caps + feature gates per plan tier
  PLAN_USER_LIMIT: "PLAN_USER_LIMIT",
  PLAN_PROJECT_LIMIT: "PLAN_PROJECT_LIMIT",
  // Plan memo-item cap reached (`maxMemoItems` — ADR-0365).
  PLAN_MEMO_LIMIT: "PLAN_MEMO_LIMIT",
  // An autonomous book reached its monthly `autonomousRequestsPerMonth` cap (ADR-0365).
  AUTONOMOUS_BOOK_CAP_REACHED: "AUTONOMOUS_BOOK_CAP_REACHED",
  PLAN_FEATURE_UNAVAILABLE: "PLAN_FEATURE_UNAVAILABLE",
  // deployment license ceiling (ADR-0135) — a self-host license bounds orgs/seats/projects/
  // storage across the whole deployment, above the per-org plan caps
  LICENSE_LIMIT_EXCEEDED: "LICENSE_LIMIT_EXCEEDED",
  // billing add-ons & rented machine-users (ADR-0123/0126) — payment-server · admin-server
  // buying an add-on without an active paid plan (ADR-0123)
  ADDON_REQUIRES_PLAN: "ADDON_REQUIRES_PLAN",
  // renting a machine-user with no free pool slot (ADR-0126) — the org may be waitlisted
  NO_HOSTED_SLOT_AVAILABLE: "NO_HOSTED_SLOT_AVAILABLE",
  // admin changing a rented hosted slot without forceRelease (ADR-0126)
  SLOT_RENTED: "SLOT_RENTED",
  // re-renting a machine whose rental is already `releasing` — too late to undo (ADR-0210)
  RENTED_MACHINE_RELEASING: "RENTED_MACHINE_RELEASING",
  // credit wallet & coupons (ADR-0118/0119/0120) — served by payment-server
  CREDIT_INSUFFICIENT: "CREDIT_INSUFFICIENT",
  COUPON_NOT_FOUND: "COUPON_NOT_FOUND",
  COUPON_EXPIRED: "COUPON_EXPIRED",
  COUPON_DISABLED: "COUPON_DISABLED",
  COUPON_EXHAUSTED: "COUPON_EXHAUSTED",
  COUPON_ALREADY_REDEEMED: "COUPON_ALREADY_REDEEMED",
  // payment-server catalog completion (ADR-0207) — credit/addon/plan errors that previously
  // threw raw strings or literals duplicated inside payment-server; now first-class codes.
  // credit mutation validation (credit.service)
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_DELTA: "INVALID_DELTA",
  TOPUP_NOT_FOUND: "TOPUP_NOT_FOUND",
  // storage add-on SKU management (addon.service — admin-0031/0032)
  STORAGE_SKU_INVALID: "STORAGE_SKU_INVALID",
  STORAGE_SKU_NOT_FOUND: "STORAGE_SKU_NOT_FOUND",
  STORAGE_SIZE_INVALID: "STORAGE_SIZE_INVALID",
  ADDON_CODE_EXISTS: "ADDON_CODE_EXISTS",
  ADDON_PRICE_INVALID: "ADDON_PRICE_INVALID",
  ADDON_PRODUCT_UNKNOWN: "ADDON_PRODUCT_UNKNOWN",
  ADDON_QUANTITY_INVALID: "ADDON_QUANTITY_INVALID",
  ADDON_NOT_FOUND: "ADDON_NOT_FOUND",
  // plan / subscription lifecycle (billing.service — ADR-0163/0142)
  PLAN_CODE_REQUIRED: "PLAN_CODE_REQUIRED",
  PLAN_UNCHANGED: "PLAN_UNCHANGED",
  PLAN_CHANGE_INVALID: "PLAN_CHANGE_INVALID",
  NO_ACTIVE_SUBSCRIPTION: "NO_ACTIVE_SUBSCRIPTION",
  NO_PROVIDER_SUBSCRIPTION: "NO_PROVIDER_SUBSCRIPTION",
  ENTERPRISE_PLAN_NOT_ASSIGNABLE: "ENTERPRISE_PLAN_NOT_ASSIGNABLE",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  // support tickets (ADR-0167) + AI help agent (ADR-0170)
  SUPPORT_TICKET_NOT_FOUND: "SUPPORT_TICKET_NOT_FOUND",
  // managed legal documents (ADR-0350): unknown/disabled document; accepting a version that is not current
  LEGAL_DOCUMENT_NOT_FOUND: "LEGAL_DOCUMENT_NOT_FOUND",
  LEGAL_VERSION_OUTDATED: "LEGAL_VERSION_OUTDATED",
  SUPPORT_TICKET_CLOSED: "SUPPORT_TICKET_CLOSED",
  // public (guest) support create (ADR-0279): the self-hosted captcha answer was wrong/expired.
  CAPTCHA_INVALID: "CAPTCHA_INVALID",
  HELP_POOL_UNAVAILABLE: "HELP_POOL_UNAVAILABLE",
  // AI Help daily cap reached (ADR-0286): the asker (or their org) exceeded the per-day question
  // cap; meta carries { scope, limit, used, resetAt }. Thrown before any dispatch (0 token cost).
  HELP_RATE_LIMITED: "HELP_RATE_LIMITED",
  // AI Help admin moderation (ADR-0237): the user/org is blocked from the channel, or the whole
  // AI support service is toggled off platform-wide.
  HELP_BLOCKED: "HELP_BLOCKED",
  HELP_DISABLED: "HELP_DISABLED",
  // Project GitHub-App git-auth (ADR-0356): method set without a credential; a rejected credential
  // (App ID / PEM / host / CA); an ssh repo URL under the App method; the primary repo's host differs
  // from the credential host; the server has no SECRETS_ENC_KEY to store/read secrets.
  GIT_CREDENTIAL_MISSING: "GIT_CREDENTIAL_MISSING",
  GIT_CREDENTIAL_INVALID: "GIT_CREDENTIAL_INVALID",
  GIT_AUTH_REQUIRES_HTTPS: "GIT_AUTH_REQUIRES_HTTPS",
  GIT_HOST_MISMATCH: "GIT_HOST_MISMATCH",
  /** An origin commit cannot be read server-side (no GitHub App / not GitHub / GitHub refused) — project-0083/0084, ADR-0397. */
  GIT_ORIGIN_UNAVAILABLE: "GIT_ORIGIN_UNAVAILABLE",
  SECRETS_KEY_NOT_CONFIGURED: "SECRETS_KEY_NOT_CONFIGURED",
  // Org announcements (ADR-0367): a target outside the sender's PM/TL scope; targets resolving to
  // nobody; the org's daily recipient cap (`announcementDailyRecipients`); unknown history row /
  // draft; the per-user draft cap.
  ANNOUNCEMENT_TARGET_FORBIDDEN: "ANNOUNCEMENT_TARGET_FORBIDDEN",
  ANNOUNCEMENT_NO_RECIPIENTS: "ANNOUNCEMENT_NO_RECIPIENTS",
  ANNOUNCEMENT_DAILY_LIMIT: "ANNOUNCEMENT_DAILY_LIMIT",
  ANNOUNCEMENT_NOT_FOUND: "ANNOUNCEMENT_NOT_FOUND",
  ANNOUNCEMENT_DRAFT_NOT_FOUND: "ANNOUNCEMENT_DRAFT_NOT_FOUND",
  ANNOUNCEMENT_DRAFT_LIMIT: "ANNOUNCEMENT_DRAFT_LIMIT",
  // Worker-cli operation failures surfaced to the web/admin so they localize via `errors.*`
  // (see CLI_ERROR_CODE_MAP below): filesystem guards, RAG, agent/content validation, support
  // answer, FAQ compose, git host, autonomous base push.
  WORKER_PATH_ESCAPES_ROOT: "WORKER_PATH_ESCAPES_ROOT",
  WORKER_NO_PROJECT: "WORKER_NO_PROJECT",
  WORKER_PATH_EXISTS: "WORKER_PATH_EXISTS",
  WORKER_ROOT_PROTECTED: "WORKER_ROOT_PROTECTED",
  WORKER_NOT_A_FILE: "WORKER_NOT_A_FILE",
  WORKER_INVALID_PAYLOAD: "WORKER_INVALID_PAYLOAD",
  WORKER_INVALID_NAME: "WORKER_INVALID_NAME",
  WORKER_CONTENT_REQUIRED: "WORKER_CONTENT_REQUIRED",
  RAG_PYTHON_MISSING: "RAG_PYTHON_MISSING",
  RAG_NOT_INSTALLED: "RAG_NOT_INSTALLED",
  RAG_NO_INDEX: "RAG_NO_INDEX",
  RAG_INVALID_MODEL: "RAG_INVALID_MODEL",
  SUPPORT_KB_EMPTY: "SUPPORT_KB_EMPTY",
  SUPPORT_EMPTY_ANSWER: "SUPPORT_EMPTY_ANSWER",
  FAQ_NO_WRITE_TOKEN: "FAQ_NO_WRITE_TOKEN",
  GIT_UNKNOWN_HOST: "GIT_UNKNOWN_HOST",
  AUTONOMOUS_BASE_PUSH_FAILED: "AUTONOMOUS_BASE_PUSH_FAILED",
} as const;

/** Union type of error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Maps a worker-cli failure reply's `error` string to the ErrorCode + HTTP status the web/admin
 * localize via the `errors.*` namespace. The cli `error` strings are the contract here (they also
 * remain the English log/fallback on the reply); an unmapped string falls back to `VALIDATION_FAILED`.
 * Shared by `@4pm/server` (wraps the reply into `AppException`) and `@4pm/web` / `@4pm/admin-web`
 * (wrap it into `ApiError`) so a single table keeps both boundaries in sync.
 */
export const CLI_ERROR_CODE_MAP: Record<string, { code: ErrorCode; status: number }> = {
  "path escapes the project root": { code: ErrorCode.WORKER_PATH_ESCAPES_ROOT, status: 422 },
  "no project served": { code: ErrorCode.WORKER_NO_PROJECT, status: 409 },
  "no project": { code: ErrorCode.WORKER_NO_PROJECT, status: 409 },
  "This worker has no project folder.": { code: ErrorCode.WORKER_NO_PROJECT, status: 409 },
  "already exists": { code: ErrorCode.WORKER_PATH_EXISTS, status: 409 },
  "destination already exists": { code: ErrorCode.WORKER_PATH_EXISTS, status: 409 },
  "cannot move the project root": { code: ErrorCode.WORKER_ROOT_PROTECTED, status: 422 },
  "cannot delete the project root": { code: ErrorCode.WORKER_ROOT_PROTECTED, status: 422 },
  "not a file": { code: ErrorCode.WORKER_NOT_A_FILE, status: 422 },
  "invalid base64 payload": { code: ErrorCode.WORKER_INVALID_PAYLOAD, status: 422 },
  "invalid name": { code: ErrorCode.WORKER_INVALID_NAME, status: 422 },
  "content is required": { code: ErrorCode.WORKER_CONTENT_REQUIRED, status: 422 },
  "invalid slug": { code: ErrorCode.MARKET_INVALID_PACKAGE, status: 422 },
  "artifact not found": { code: ErrorCode.MARKET_PACKAGE_NOT_FOUND, status: 404 },
  "not installed": { code: ErrorCode.MARKET_PACKAGE_NOT_FOUND, status: 404 },
  "python3 not found": { code: ErrorCode.RAG_PYTHON_MISSING, status: 422 },
  "python3 not found on the worker": { code: ErrorCode.RAG_PYTHON_MISSING, status: 422 },
  "RAG is not installed": { code: ErrorCode.RAG_NOT_INSTALLED, status: 409 },
  "no index — reindex first": { code: ErrorCode.RAG_NO_INDEX, status: 409 },
  "invalid model name": { code: ErrorCode.RAG_INVALID_MODEL, status: 422 },
  "KB repo has no documentation": { code: ErrorCode.SUPPORT_KB_EMPTY, status: 422 },
  "empty answer": { code: ErrorCode.SUPPORT_EMPTY_ANSWER, status: 422 },
  "no write token": { code: ErrorCode.FAQ_NO_WRITE_TOKEN, status: 422 },
  "Unknown git host — no pull request opened.": { code: ErrorCode.GIT_UNKNOWN_HOST, status: 422 },
  "could not push the change to the base branch (retry)": { code: ErrorCode.AUTONOMOUS_BASE_PUSH_FAILED, status: 422 },
  "self-approval blocked": { code: ErrorCode.APPROVAL_SELF, status: 409 },
  "approval stale": { code: ErrorCode.APPROVAL_STALE, status: 409 },
};

/** Resolve a cli reply's `error` string to its ErrorCode + status, or `null` when unmapped. */
export function cliErrorToCode(error: string | null | undefined): { code: ErrorCode; status: number } | null {
  return (error && CLI_ERROR_CODE_MAP[error]) || null;
}
