# AI_SECURITY — Security rules for the AI

This document describes the **security criteria** the AI (Claude Code) and users must follow when working
on the project. The AI reads this to know what data to protect, what to mask, and what must NEVER be
committed. Replace the sample rules below with your project's real policy.

## 1. Security criteria
- Sensitive information must NOT leak into source code, logs, reports, or docs.
- Every secret must be loaded from environment variables / a secret manager, NEVER hard-coded.
- Grant only the least privilege needed for keys, tokens, and accounts.

## 2. What to mask
When displaying, logging, or capturing evidence, mask the following (keep only a few leading/trailing chars):
- API keys, secret keys, access/refresh tokens, JWTs.
- Passwords, database connection strings, private keys.
- Personal data (PII): email, phone, national id, card numbers.
- `Authorization` headers, session cookies.

Example: `sk-ABCD…WXYZ` instead of the full key.

## 3. Commit rules
- NEVER commit: `.env`, `*.key` / `*.pem`, credentials, `secrets.json`, API keys, passwords, or tokens.
- Check `git diff` before committing; if a secret slipped in, **rotate** that key.
- Keep `.gitignore` covering sensitive files/dirs (e.g. `.env`, `*.local.json`, `node_modules/`).
- Never put real customer data into tests/evidence — use fixtures.

## 4. On a leak
1. Rotate the leaked key/secret immediately.
2. Remove the secret from git history if needed (e.g. `git filter-repo`).
3. Record the incident and notify the project manager.
