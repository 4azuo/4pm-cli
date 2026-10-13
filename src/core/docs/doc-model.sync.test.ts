/**
 * Keeps the `4pm-doc-lint` skill's emitted `doc-model.mjs` in sync with `doc-model.ts` (one source for the
 * cli and the skill). Fix a failure with `pnpm --filter @4pm/cli docs-lint:emit`.
 * @adr 0488
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("4pm-doc-lint skill", () => {
  it("ships the current doc-model", async () => {
    const script = fileURLToPath(new URL("../../../scripts/emit-doc-lint.mjs", import.meta.url));
    const { emitDocModel } = (await import(script)) as { emitDocModel: () => Promise<string> };
    const emitted = await readFile(new URL("../../../project-sample/.claude/skills/4pm-doc-lint/doc-model.mjs", import.meta.url), "utf8");
    expect(emitted).toBe(await emitDocModel());
  });
});
