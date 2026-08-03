# Unit Test (UT)

**Unit** tests: check each function/module in isolation — fast, deterministic, **no browser/render**.
Complements the Integration Tests in `tests/IT/`.

> This sample ships no UT cases — the folder is a skeleton. Add UT here following the conventions below.

## Conventions
- One test file per module in `tests/UT/`, named to mirror the module under `src/` (e.g. `<module>.test.*`).
- Tests should run via your chosen runner (Node `node:test`, Jest, Vitest, Pytest, …) and **exit
  non-zero on failure** so CI/the runner detects it.
- Keep UT **fast & isolated**: no network, no writes outside the test dir, no dependence on real time or
  global state.

## Add a test case
1. Create `tests/UT/<module>.test.*`.
2. Import the module under test from `src/`, assert each branch + edge case.
3. Run your test command to confirm everything is green.
