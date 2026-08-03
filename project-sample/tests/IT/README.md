# Integration Test (IT)

Integration tests exercise **real end-to-end flows** and (optionally) capture **evidence** (before/after)
per test case, so a reviewer can see what changed.

## Layout
| Folder | Role |
|--------|------|
| `senarios/<senario>/` | One folder per scenario: a spec per test case (`TC-00x-*.md`) + `testcases.json` (manifest of case ids/titles/params) + `senario.json` (name, description) |
| `tools/`     | Your test runner / orchestrator + any helpers (choose the tooling that fits the project) |
| `evidence/`  | Generated results per case: `<TC>/{before,after}` captures + logs + a summary |

## Idea
For each relevant test case, capture the state **before** a change, make the change, capture **after**,
then gather the pair into a reviewable report. Capture only the cases relevant to the task.

## Add a test case
1. Pick/create a scenario `senarios/<senario>/`. Write `senarios/<senario>/TC-00x-*.md` (keep the
   sections: Preconditions · Steps · Expected result · Evidence).
2. Add an entry to `senarios/<senario>/testcases.json` (id, title, params your runner needs).
3. Run your IT runner for that case to generate evidence.

> This sample ships the structure only — plug in the IT tooling appropriate for your stack (a browser
> harness like Playwright/Puppeteer for web UIs, an API test runner for services, etc.). Reference the
> run command from the project `CLAUDE.md`.
