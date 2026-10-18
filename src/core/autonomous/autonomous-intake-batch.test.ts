/**
 * Intake batch size: one run takes at most `intakeBatchSize` ids, and an answered question rides with the
 * request it depends on.
 * @adr 0554
 */
import { describe, expect, it } from "vitest";
import { intakeBatch } from "./autonomous-tasks";

const QA = `# User QA

| ID | Group | Depends | Original request | Question / options | Answer |
|---|---|---|---|---|---|
| QA-000009-001 | 000009 | REQ-000002-001 | Add a menu | Which items? | Home, Orders |
| QA-000010-001 | 000010 | | Add a footer | Links? | About |
`;

describe("intakeBatch", () => {
  it("takes the first `size` ids in order", () => {
    expect(intakeBatch(["REQ-000001-001", "REQ-000002-001", "REQ-000003-001"], 1, QA)).toEqual(["REQ-000001-001"]);
    expect(intakeBatch(["REQ-000001-001", "REQ-000003-001"], 5, QA)).toEqual(["REQ-000001-001", "REQ-000003-001"]);
  });

  it("adds an answered question that depends on a picked request", () => {
    expect(intakeBatch(["REQ-000002-001", "QA-000010-001", "QA-000009-001"], 1, QA)).toEqual(["REQ-000002-001", "QA-000009-001"]);
  });

  it("treats a size below 1 as 1", () => {
    expect(intakeBatch(["QA-000010-001", "REQ-000001-001"], 0, QA)).toEqual(["QA-000010-001"]);
  });
});
