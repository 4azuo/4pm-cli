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
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // auth
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_USED: "TOKEN_USED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  /** The session is idle-locked (ADR-0204) — re-authenticate to continue (HTTP 423). */
  SESSION_LOCKED: "SESSION_LOCKED",
  PASSWORD_POLICY_VIOLATION: "PASSWORD_POLICY_VIOLATION",
  PASSWORD_CONFIRM_MISMATCH: "PASSWORD_CONFIRM_MISMATCH",
  PASSWORD_CURRENT_INVALID: "PASSWORD_CURRENT_INVALID",
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
  PACKAGE_ALREADY_INSTALLED: "PACKAGE_ALREADY_INSTALLED",
  // org total hosted storage cap (ADR-0122) — blocks template + community attachment uploads
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
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
  // command-0001 pick:"idle" (ADR-0171) — no idle cli in the project's pool
  ALL_CLIS_BUSY: "ALL_CLIS_BUSY",
  // worker · physic project
  WORKER_NOT_FOUND: "WORKER_NOT_FOUND",
  PHYSIC_PROJECT_NOT_FOUND: "PHYSIC_PROJECT_NOT_FOUND",
  PHYSIC_PATH_OCCUPIED: "PHYSIC_PATH_OCCUPIED",
  AUTONOMOUS_CONFLICT: "AUTONOMOUS_CONFLICT",
  CLI_VERSION_UNSUPPORTED: "CLI_VERSION_UNSUPPORTED",
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
  MEMO_TOO_LONG: "MEMO_TOO_LONG",
  // plan entitlements (ADR-0105) — resource caps + feature gates per plan tier
  PLAN_USER_LIMIT: "PLAN_USER_LIMIT",
  PLAN_PROJECT_LIMIT: "PLAN_PROJECT_LIMIT",
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
  // credit wallet & coupons (ADR-0118/0119/0120) — served by payment-server
  CREDIT_INSUFFICIENT: "CREDIT_INSUFFICIENT",
  COUPON_NOT_FOUND: "COUPON_NOT_FOUND",
  COUPON_EXPIRED: "COUPON_EXPIRED",
  COUPON_DISABLED: "COUPON_DISABLED",
  COUPON_EXHAUSTED: "COUPON_EXHAUSTED",
  COUPON_ALREADY_REDEEMED: "COUPON_ALREADY_REDEEMED",
  // support tickets (ADR-0167) + AI help agent (ADR-0168)
  SUPPORT_TICKET_NOT_FOUND: "SUPPORT_TICKET_NOT_FOUND",
  SUPPORT_TICKET_CLOSED: "SUPPORT_TICKET_CLOSED",
  HELP_POOL_UNAVAILABLE: "HELP_POOL_UNAVAILABLE",
  HELP_RATE_LIMITED: "HELP_RATE_LIMITED",
} as const;

/** Union type of error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
