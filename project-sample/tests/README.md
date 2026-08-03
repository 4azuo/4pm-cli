# Tests

Tests are organized in **two levels**:

- **Unit Test (UT)** — test each **unit** (function/module) in isolation; fast, no browser. Lives in
  `tests/UT/`.
- **Integration Test (IT)** — test **real integration flows**, optionally capturing **evidence**
  (before/after) per test case. Lives in `tests/IT/`.

```
tests/
├── UT/                         # Unit Test — isolated unit tests
│   └── README.md               #   naming & conventions
└── IT/                         # Integration Test — real-flow tests (+ evidence)
    ├── senarios/<senario>/     #   one folder per scenario: testcase specs (.md) + testcases.json + senario.json
    ├── tools/                  #   your test runner / helpers
    └── evidence/               #   before/after + logs (generated)
```

This sample ships the folder **structure** only — no test cases yet. Pick the test tooling that fits your
project (e.g. Node's `node:test`, Jest, Vitest, Pytest, Playwright…) and wire your own run command
(reference it from the project `CLAUDE.md`). See `tests/UT/README.md` and `tests/IT/README.md`.
