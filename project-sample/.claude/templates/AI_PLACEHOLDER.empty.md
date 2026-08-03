# AI_PLACEHOLDER — Placeholder table (key + explanation)

> Lists **placeholders** the AI understands: each has a **key** and an **explanation**. Reference them in
> docs/config as `${key}$` (e.g. `${ai_dev_branch}$`); the tool substitutes the real **value** at runtime.
>
> **Where values live:** the real value of each key is stored in `project.secrets.json` (same folder). This
> file holds only keys + explanations, so it is **safe to commit** and the AI can read it for context.

| Key | Explanation |
|-----|-------------|
| ai_dev_branch | The shared dev branch the AI merges tasks into before the main branch. |
