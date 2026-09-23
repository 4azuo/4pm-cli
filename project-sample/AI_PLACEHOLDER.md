# AI_PLACEHOLDER — Placeholder table (key + explanation)

> Lists **placeholders** the AI understands: each has a **key** and an **explanation**. Reference them in
> docs/config as `${key}$` (e.g. `${ai_dev_branch}$`); the tool substitutes the real **value** at runtime.
>
> **Where values live:** the real value of each key is stored in `project.secrets.json` (same folder). This
> file holds only keys + explanations, so it is **safe to commit** and the AI can read it for context.
>
> **Why two files:**
> - `AI_PLACEHOLDER.md` (this file) — keys + explanations. Safe to commit; not gitignored.
> - `project.secrets.json` — key → real value. **Gitignored** (never committed / pushed), so secret
>   values stay on the worker. The AI **can** read this file to use the values while running/testing a
>   task — so enter **test values only**; do **not** put high-sensitivity secrets here. Manage values
>   from the web (Placeholder tab) — they are write-only (never shown back).

| Key | Explanation |
|-----|-------------|
| api_base_url | Base URL of the internal API the AI calls during integration tests. |
| api_key | Key for the internal API (real value in project.secrets.json, NOT committed). |
