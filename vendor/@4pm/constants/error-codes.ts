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
  // The caller's IP is outside the deployment's platform allowlist (APP_/ADMIN_/CLI_IP_ALLOWLIST —
  // ADR-0519); `meta.ip` carries the IP. Distinct from IP_NOT_ALLOWED (org / user / project tiers).
  PLATFORM_IP_NOT_ALLOWED: "PLATFORM_IP_NOT_ALLOWED",
  // The deploy's site password gate (SITE_PASSWORD / ADMIN_SITE_PASSWORD — ADR-0523) is on and the
  // browser has no valid gate cookie; the web / admin-web move to `/site-gate`.
  SITE_GATE_REQUIRED: "SITE_GATE_REQUIRED",
  // Wrong password on the site password gate (ADR-0523).
  SITE_GATE_PASSWORD_INVALID: "SITE_GATE_PASSWORD_INVALID",
  // A user's IP allowlist entry falls outside the org allowlist (ADR-0044).
  IP_OUTSIDE_ORG_ALLOWLIST: "IP_OUTSIDE_ORG_ALLOWLIST",
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
  /** The new password equals the current one (forced change at login). @adr 0476 */
  PASSWORD_REUSED: "PASSWORD_REUSED",
  IDENTITY_REQUIRED: "IDENTITY_REQUIRED",
  MFA_CODE_INVALID: "MFA_CODE_INVALID",
  MFA_CODE_EXPIRED: "MFA_CODE_EXPIRED",
  /** The chosen second-factor method is not available for this challenge/user. @adr 0446 */
  MFA_METHOD_UNAVAILABLE: "MFA_METHOD_UNAVAILABLE",
  /** The passkey assertion/registration did not verify. @adr 0446 */
  MFA_PASSKEY_INVALID: "MFA_PASSKEY_INVALID",
  /** TOTP needs the server secret box (`SECRETS_ENC_KEY`), which is not configured. @adr 0446 */
  MFA_TOTP_UNAVAILABLE: "MFA_TOTP_UNAVAILABLE",
  /** No pending TOTP setup to confirm (expired or never started). @adr 0446 */
  MFA_TOTP_NOT_PENDING: "MFA_TOTP_NOT_PENDING",
  /** TOTP is already enrolled — remove it before setting up a new one. @adr 0446 */
  MFA_TOTP_ALREADY_ENROLLED: "MFA_TOTP_ALREADY_ENROLLED",
  /** Can't remove the last second factor while the org policy requires MFA. @adr 0446 */
  MFA_LAST_FACTOR: "MFA_LAST_FACTOR",
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
  // project libraries (ADR-0456): an attached org entry is read-only inside a project — fork it to edit
  TEMPLATE_ORG_READONLY: "TEMPLATE_ORG_READONLY",
  CHECKLIST_ORG_READONLY: "CHECKLIST_ORG_READONLY",
  // doc types (ADR-0457)
  DOC_TYPE_KEY_TAKEN: "DOC_TYPE_KEY_TAKEN",
  // ADR-0564: a second enabled spec doc template of one spec type / a non-text or too big template file.
  DOC_TEMPLATE_DUPLICATE: "DOC_TEMPLATE_DUPLICATE",
  DOC_TEMPLATE_NOT_TEXT: "DOC_TEMPLATE_NOT_TEXT",
  DOC_TYPE_SYSTEM_READONLY: "DOC_TYPE_SYSTEM_READONLY",
  DOC_TYPE_SOURCE_READONLY: "DOC_TYPE_SOURCE_READONLY",
  DOC_TYPE_DISABLED: "DOC_TYPE_DISABLED",
  DOC_TYPE_RUN_FORBIDDEN: "DOC_TYPE_RUN_FORBIDDEN",
  DOC_TYPE_PARAM_INVALID: "DOC_TYPE_PARAM_INVALID",
  DOC_TYPE_TEMPLATE_NOT_ALLOWED: "DOC_TYPE_TEMPLATE_NOT_ALLOWED",
  DOC_TYPE_CLIENT_RUN: "DOC_TYPE_CLIENT_RUN",
  // automation rules (ADR-0458)
  RULE_EVENT_UNKNOWN: "RULE_EVENT_UNKNOWN",
  RULE_ACTION_INVALID: "RULE_ACTION_INVALID",
  RULE_ACTION_FORBIDDEN: "RULE_ACTION_FORBIDDEN",
  RULE_REGEX_UNSAFE: "RULE_REGEX_UNSAFE",
  RULE_ENFORCED: "RULE_ENFORCED",
  RULE_LIMIT_REACHED: "RULE_LIMIT_REACHED",
  // chained rules (ADR-0542)
  RULE_CHAIN_CYCLE: "RULE_CHAIN_CYCLE",
  RULE_CHAIN_TOO_DEEP: "RULE_CHAIN_TOO_DEEP",
  RULE_CHAIN_SOURCE_INVALID: "RULE_CHAIN_SOURCE_INVALID",
  RULE_HAS_FOLLOWERS: "RULE_HAS_FOLLOWERS",
  // Global 4rum feed: per-user pinned orgs cap (ADR-0492)
  COMMUNITY_ORG_PIN_LIMIT: "COMMUNITY_ORG_PIN_LIMIT",
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
  // DevOps / CI/CD (ADR-0605 / ADR-0606)
  DEVOPS_UNAVAILABLE: "DEVOPS_UNAVAILABLE",
  DEVOPS_PROVIDER_CREDENTIAL_REQUIRED: "DEVOPS_PROVIDER_CREDENTIAL_REQUIRED",
  DEVOPS_PROVIDER_PERMISSION_MISSING: "DEVOPS_PROVIDER_PERMISSION_MISSING",
  DEVOPS_PROVIDER_UNAVAILABLE: "DEVOPS_PROVIDER_UNAVAILABLE",
  DEVOPS_WORKFLOW_NOT_DISPATCHABLE: "DEVOPS_WORKFLOW_NOT_DISPATCHABLE",
  CI_LINT_UNSUPPORTED: "CI_LINT_UNSUPPORTED",
  CI_LOG_EXPIRED: "CI_LOG_EXPIRED",
  CI_PATH_NOT_ALLOWED: "CI_PATH_NOT_ALLOWED",
  CI_PROPOSE_FAILED: "CI_PROPOSE_FAILED",
  KNOWLEDGE_SCOPE_FORBIDDEN: "KNOWLEDGE_SCOPE_FORBIDDEN",
  // 4rum post / Messenger message missing or not visible — also a cursor anchor (ADR-0341/0361)
  POST_NOT_FOUND: "POST_NOT_FOUND",
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  // 4rum comment missing / not a live comment of that post — a comment-list parentId or cursor (ADR-0516)
  COMMENT_NOT_FOUND: "COMMENT_NOT_FOUND",
  PACKAGE_ALREADY_INSTALLED: "PACKAGE_ALREADY_INSTALLED",
  // Multi-target installer (ADR-0460/0461/0462)
  PACKAGE_PROVIDER_UNSUPPORTED: "PACKAGE_PROVIDER_UNSUPPORTED",
  PACKAGE_TASK_LABEL_CONFLICT: "PACKAGE_TASK_LABEL_CONFLICT",
  PACKAGE_REQUIRED_BY: "PACKAGE_REQUIRED_BY",
  PACKAGE_HOOKS_CHANGED: "PACKAGE_HOOKS_CHANGED",
  PACKAGE_HOOKS_FOREIGN: "PACKAGE_HOOKS_FOREIGN",
  PACKAGE_GUIDE_TARGET_EXISTS: "PACKAGE_GUIDE_TARGET_EXISTS",
  // org total hosted storage cap (ADR-0122/0365) — blocks text writes, uploads, memo/book writes and new AI runs
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  // market-server could not read the org storage quota from the server — write refused (fail-closed, ADR-0512)
  STORAGE_QUOTA_UNAVAILABLE: "STORAGE_QUOTA_UNAVAILABLE",
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
  // allow/deny for a code outside the target user's role cap (MACHINE / CLIENT — ADR-0472)
  PERMISSION_NOT_APPLICABLE: "PERMISSION_NOT_APPLICABLE",
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

  // A disruptive worker op (repo (re)provision / CLI update) was refused because the target
  // worker's autonomous mode is armed (its effective state — ADR-0317, ADR-0507) — stop it first.
  AUTONOMOUS_ACTIVE: "AUTONOMOUS_ACTIVE",
  // Separation of duties (ADR-0320): a non-ADMIN tried to approve a row they wrote — the writer can't
  // be the approver of their own row (ADMIN may self-approve).
  APPROVAL_SELF: "APPROVAL_SELF",
  // Signed approvals (ADR-0438): the row changed after the approver read it — its content hash no longer
  // matches the book the approval targets; reload and approve again. meta.id = the row.
  APPROVAL_STALE: "APPROVAL_STALE",
  // ADR-0440: the approval could not be signed (KMS unreachable, no active / readable key) — never written
  // unsigned once keys are published.
  APPROVAL_SIGNING_UNAVAILABLE: "APPROVAL_SIGNING_UNAVAILABLE",
  // Project ER (ADR-0453): an approved change request touches a field another applied one changed (meta
  // `conflictsWith`, `entities`) — the ERC is now `conflict`, nothing applied.
  ER_CHANGE_CONFLICT: "ER_CHANGE_CONFLICT",
  // An ER change request does not parse (meta `module`, `line`), declares an entity twice, or changes nothing.
  ER_CHANGE_INVALID: "ER_CHANGE_INVALID",
  // The ER change request is not in a state that allows this (e.g. revising an applied one, deciding a non-pending one).
  ER_CHANGE_STALE: "ER_CHANGE_STALE",
  // Project system diagram (ADR-0530): an SDC touches a cell field another applied one changed (meta
  // `conflictsWith`, `cells`) — the SDC is now `conflict`, nothing applied.
  DIAGRAM_CHANGE_CONFLICT: "DIAGRAM_CHANGE_CONFLICT",
  // A draw.io edit does not parse / is compressed (meta `module`), repeats a cell id, or changes nothing.
  DIAGRAM_INVALID: "DIAGRAM_INVALID",
  // The SDC is not in a state that allows this (revising an applied one, deciding a non-pending one, unknown base).
  DIAGRAM_CHANGE_STALE: "DIAGRAM_CHANGE_STALE",
  // No such system-diagram change request.
  DIAGRAM_CHANGE_NOT_FOUND: "DIAGRAM_CHANGE_NOT_FOUND",
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
  // The serving worker cli is draining for a restart / update and accepts no new work (ADR-0505).
  CLI_RESTARTING: "CLI_RESTARTING",
  // The worker's repo queue for the project is full while its working tree is held (ADR-0506).
  REPO_BUSY: "REPO_BUSY",
  // A queued job waited past `repoQueueTimeoutMin` for the project's working tree (ADR-0506).
  REPO_QUEUE_TIMEOUT: "REPO_QUEUE_TIMEOUT",
  // A worker settings write carries a project-scoped autonomous key, or the reverse (ADR-0507).
  AUTONOMOUS_SETTING_SCOPE: "AUTONOMOUS_SETTING_SCOPE",
  // A direct write dispatch on a ready project whose changes must go through autonomous (ADR-0511).
  AUTONOMOUS_PATH_ENFORCED: "AUTONOMOUS_PATH_ENFORCED",
  // A web file edit was based on a version of the file the remote base no longer holds (ADR-0511).
  FILE_CHANGED_UPSTREAM: "FILE_CHANGED_UPSTREAM",
  // The remote refused the push of a web file edit to the base branch (protected / no permission) (ADR-0511).
  BASE_PUSH_REJECTED: "BASE_PUSH_REJECTED",
  // "Run now" found no worker whose autonomous state is effective (ADR-0507).
  AUTONOMOUS_NOT_RUNNING: "AUTONOMOUS_NOT_RUNNING",
  // A customer (CLIENT) asked for `.git` or a gitignored path (ADR-0449).
  CLIENT_PATH_HIDDEN: "CLIENT_PATH_HIDDEN",
  // A CLIENT can only be a direct project member: not a team member, PM, TL or routing target (ADR-0449).
  CLIENT_ROLE_CONSTRAINT: "CLIENT_ROLE_CONSTRAINT",
  // A book save changed a row of a team the caller can't edit (old or new `Team` — ADR-0450). meta.ids.
  BOOK_TEAM_FORBIDDEN: "BOOK_TEAM_FORBIDDEN",
  // A customer changed a book row it didn't write (ADR-0450 §5). meta.ids.
  BOOK_ROW_NOT_OWNED: "BOOK_ROW_NOT_OWNED",
  // A USER_QA save added / deleted rows or changed a cell other than `Answer` (ADR-0454). meta.ids.
  USER_QA_ANSWER_ONLY: "USER_QA_ANSWER_ONLY",
  // A book save's rows were changed / deleted / taken by someone else meanwhile (ADR-0455). meta.ids, meta.kinds, meta.rest.
  BOOK_CONFLICT: "BOOK_CONFLICT",
  // A whole-file book save was edited from an older version of the book (ADR-0455).
  BOOK_STALE: "BOOK_STALE",
  // A book save deletes a row other rows still list in `Depends` (ADR-0538). meta.id, meta.dependents.
  BOOK_ROW_HAS_DEPENDENTS: "BOOK_ROW_HAS_DEPENDENTS",
  /** A `Depends` edit closes a dependency cycle (`meta.cycle`). @adr 0613 */
  BOOK_DEPENDS_CYCLE: "BOOK_DEPENDS_CYCLE",
  // A book save edits / deletes a row the AI is working on (live AI_PROGRESS claim — ADR-0538). meta.id, meta.worker.
  BOOK_ROW_CLAIMED: "BOOK_ROW_CLAIMED",
  // A book save edits / deletes a request or question kept as history (a `State` — taken in / done, ADR-0562). meta.id.
  BOOK_ROW_HISTORY: "BOOK_ROW_HISTORY",
  // A review of a DOC round that no longer waits for it (another round started, or it was reviewed — ADR-0536). meta.id.
  DOC_REVIEW_STALE: "DOC_REVIEW_STALE",
  // Only ADMIN / the project's PM may change this autonomous setting (`skipPullRequest` — ADR-0539). meta.key.
  AUTONOMOUS_SETTING_FORBIDDEN: "AUTONOMOUS_SETTING_FORBIDDEN",
  // A restore of a deleted branch whose name exists again on the remote (ADR-0540).
  BRANCH_EXISTS: "BRANCH_EXISTS",
  // A restore of a deleted branch whose commit no worker / the host still has (ADR-0540).
  BRANCH_RESTORE_UNAVAILABLE: "BRANCH_RESTORE_UNAVAILABLE",
  // Another live team of the org already uses this code (ADR-0450).
  TEAM_CODE_TAKEN: "TEAM_CODE_TAKEN",
  // A routing entry serves a team not attached to the project (ADR-0450). meta.teamId.
  ROUTING_TEAM_NOT_IN_PROJECT: "ROUTING_TEAM_NOT_IN_PROJECT",
  // Under the project's approval policy the caller is in none of the row's approver groups (ADR-0451). meta.id.
  APPROVAL_NOT_A_PARTY: "APPROVAL_NOT_A_PARTY",
  // The row has linked discussions not resolved yet (ADR-0454). meta.id, meta.discussionIds.
  APPROVAL_OPEN_QUESTIONS: "APPROVAL_OPEN_QUESTIONS",
  // An approval request may be re-sent at most once a day (ADR-0451).
  BOOK_REQUEST_RESEND_TOO_SOON: "BOOK_REQUEST_RESEND_TOO_SOON",
  // The approval request is not open any more (ADR-0451).
  BOOK_REQUEST_NOT_OPEN: "BOOK_REQUEST_NOT_OPEN",
  // A discussion link / reopen targets a row that is already approved (ADR-0454). meta.ids.
  DISCUSSION_LINK_APPROVED: "DISCUSSION_LINK_APPROVED",
  // Only the author, a TL of the author's team or the PM / ADMIN may resolve / reopen (ADR-0454).
  DISCUSSION_RESOLVE_FORBIDDEN: "DISCUSSION_RESOLVE_FORBIDDEN",
  // Custom tags (ADR-0543): the tag is not in this scope / deleted; the code is already used in the org or project;
  // a book save / discussion names a code the project doesn't offer (meta.codes); a Due is not a real
  // YYYY-MM-DD date (meta.ids for book rows).
  TAG_NOT_FOUND: "TAG_NOT_FOUND",
  TAG_CODE_TAKEN: "TAG_CODE_TAKEN",
  TAG_UNKNOWN: "TAG_UNKNOWN",
  DUE_INVALID: "DUE_INVALID",
  // A book save gives a row to someone who is not a person of the project, or a malformed / too long
  // `Assignees` cell (meta.ids — ADR-0585).
  ASSIGNEE_UNKNOWN: "ASSIGNEE_UNKNOWN",
  // A book row `Title` longer than BOOK_TITLE_MAX (meta.ids — ADR-0549).
  BOOK_TITLE_TOO_LONG: "BOOK_TITLE_TOO_LONG",
  // Issue links (ADR-0546): a malformed issue ref (meta.ids); the issue is linked to another live row (meta.ref,
  // meta.rowId); no held external change to apply / dismiss.
  ISSUE_REF_INVALID: "ISSUE_REF_INVALID",
  ISSUE_ALREADY_LINKED: "ISSUE_ALREADY_LINKED",
  ISSUE_NO_PENDING: "ISSUE_NO_PENDING",
  // Admin cli version policy rejected (ADR-0363) — meta.reason: minAboveLatest | latestNotBlockable |
  // deadlinePast | invalidVersion.
  CLI_VERSION_POLICY_INVALID: "CLI_VERSION_POLICY_INVALID",
  // Batch monitor operator actions (ADR-0599): unknown job / incident, a worker can't be run on demand, the job is
  // disabled, or no batch app of the job's service is deployed to consume the command.
  BATCH_JOB_NOT_FOUND: "BATCH_JOB_NOT_FOUND",
  BATCH_INCIDENT_NOT_FOUND: "BATCH_INCIDENT_NOT_FOUND",
  BATCH_JOB_NOT_RUNNABLE: "BATCH_JOB_NOT_RUNNABLE",
  BATCH_JOB_DISABLED: "BATCH_JOB_DISABLED",
  BATCH_SERVICE_NOT_DEPLOYED: "BATCH_SERVICE_NOT_DEPLOYED",
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
  // Client-side (ADR-0502): the worker's AI CLI is installed but its agent user cannot execute it — the web
  // throws it when a failed AI dispatch's output carries the cli's `[4PM] AI_CLI_NOT_RUNNABLE` line.
  AI_CLI_NOT_RUNNABLE: "AI_CLI_NOT_RUNNABLE",
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
  // TCC payment attempts (ADR-0600): a live attempt for the same thing exists (409); a card outcome is still
  // being confirmed by the provider (202-style, resolved by the reconciler); checkout on an active paid plan (409);
  // the subscription moved between the quote and the payment — nothing charged (409).
  PAYMENT_IN_PROGRESS: "PAYMENT_IN_PROGRESS",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  SUBSCRIPTION_ALREADY_ACTIVE: "SUBSCRIPTION_ALREADY_ACTIVE",
  SUBSCRIPTION_CHANGED: "SUBSCRIPTION_CHANGED",
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
  // Git tab Configuration (ADR-0441): another git-config job is running; the requested branch is missing or
  // protected on the host; a serving worker has a dirty tree (branch switch); the path isn't a declared submodule.
  GIT_CONFIG_BUSY: "GIT_CONFIG_BUSY",
  BRANCH_NOT_FOUND: "BRANCH_NOT_FOUND",
  BRANCH_PROTECTED: "BRANCH_PROTECTED",
  WORKER_DIRTY: "WORKER_DIRTY",
  SUBMODULE_NOT_FOUND: "SUBMODULE_NOT_FOUND",
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
  // The worker is draining for a restart / update (ADR-0505).
  CLI_RESTARTING: { code: ErrorCode.CLI_RESTARTING, status: 409 },
  // Web file edits committed to the remote base (ADR-0511).
  FILE_CHANGED_UPSTREAM: { code: ErrorCode.FILE_CHANGED_UPSTREAM, status: 409 },
  BASE_PUSH_REJECTED: { code: ErrorCode.BASE_PUSH_REJECTED, status: 409 },
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
  ALREADY_INSTALLED: { code: ErrorCode.PACKAGE_ALREADY_INSTALLED, status: 409 },
  TASK_LABEL_CONFLICT: { code: ErrorCode.PACKAGE_TASK_LABEL_CONFLICT, status: 409 },
  GUIDE_TARGET_EXISTS: { code: ErrorCode.PACKAGE_GUIDE_TARGET_EXISTS, status: 409 },
  REQUIRED_BY: { code: ErrorCode.PACKAGE_REQUIRED_BY, status: 409 },
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
  CLIENT_PATH_HIDDEN: { code: ErrorCode.CLIENT_PATH_HIDDEN, status: 403 },
  BOOK_TEAM_FORBIDDEN: { code: ErrorCode.BOOK_TEAM_FORBIDDEN, status: 403 },
  BOOK_ROW_NOT_OWNED: { code: ErrorCode.BOOK_ROW_NOT_OWNED, status: 403 },
  USER_QA_ANSWER_ONLY: { code: ErrorCode.USER_QA_ANSWER_ONLY, status: 422 },
  BOOK_CONFLICT: { code: ErrorCode.BOOK_CONFLICT, status: 409 },
  BOOK_STALE: { code: ErrorCode.BOOK_STALE, status: 409 },
  BOOK_ROW_HAS_DEPENDENTS: { code: ErrorCode.BOOK_ROW_HAS_DEPENDENTS, status: 422 },
  BOOK_DEPENDS_CYCLE: { code: ErrorCode.BOOK_DEPENDS_CYCLE, status: 422 },
  BOOK_ROW_CLAIMED: { code: ErrorCode.BOOK_ROW_CLAIMED, status: 409 },
  BOOK_ROW_HISTORY: { code: ErrorCode.BOOK_ROW_HISTORY, status: 409 },
  DOC_REVIEW_STALE: { code: ErrorCode.DOC_REVIEW_STALE, status: 409 },
  AUTONOMOUS_SETTING_FORBIDDEN: { code: ErrorCode.AUTONOMOUS_SETTING_FORBIDDEN, status: 403 },
  BRANCH_EXISTS: { code: ErrorCode.BRANCH_EXISTS, status: 409 },
  BRANCH_RESTORE_UNAVAILABLE: { code: ErrorCode.BRANCH_RESTORE_UNAVAILABLE, status: 410 },
  ER_CHANGE_CONFLICT: { code: ErrorCode.ER_CHANGE_CONFLICT, status: 409 },
  ER_CHANGE_INVALID: { code: ErrorCode.ER_CHANGE_INVALID, status: 422 },
  ER_CHANGE_STALE: { code: ErrorCode.ER_CHANGE_STALE, status: 409 },
  DIAGRAM_CHANGE_CONFLICT: { code: ErrorCode.DIAGRAM_CHANGE_CONFLICT, status: 409 },
  DIAGRAM_INVALID: { code: ErrorCode.DIAGRAM_INVALID, status: 422 },
  DIAGRAM_CHANGE_STALE: { code: ErrorCode.DIAGRAM_CHANGE_STALE, status: 409 },
};

/** Resolve a cli reply's `error` string to its ErrorCode + status, or `null` when unmapped. */
export function cliErrorToCode(error: string | null | undefined): { code: ErrorCode; status: number } | null {
  return (error && CLI_ERROR_CODE_MAP[error]) || null;
}
