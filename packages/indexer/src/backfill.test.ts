import { describe, expect, test } from "vitest";
import { MAX_BACKFILL_ROWS, planBackfill, type BackfillEval } from "./backfill.js";
import { evalRows } from "./import.js";

const SYSTEM = "x86_64-linux";
const HASH = "a".repeat(40);

function evalOf(seq: number, attrPaths: string[]): BackfillEval {
  const json = Object.fromEntries(
    attrPaths.map((a) => [
      a,
      {
        name: a,
        pname: a,
        version: "",
        system: SYSTEM,
        outputs: { out: `/nix/store/${"b".repeat(32)}-${a}` },
        meta: { _devboxSearchVersion: "1" },
      },
    ]),
  );
  return { system: SYSTEM, seq, rows: evalRows(json, HASH, new Date(), SYSTEM) };
}

describe("planBackfill", () => {
  test("nextSeq is the system's next imported seq, so a run can join the live range", () => {
    const plan = planBackfill([evalOf(10, ["tool"]), evalOf(12, ["tool"])], new Map([[SYSTEM, [10, 12, 15, 16]]]));
    expect(plan.ranges).toEqual([
      { system: SYSTEM, nameKey: "tool", version: "1", attrPath: "tool", firstSeq: 10, lastSeq: 12, nextSeq: 15 },
    ]);
    expect(plan.variants.map((v) => [v.row.pkg.attrPath, v.commitSeq])).toEqual([["tool", 10]]);
  });

  test("nextSeq is null when the run ends at the system's head", () => {
    const plan = planBackfill([evalOf(16, ["tool"])], new Map([[SYSTEM, [15, 16]]]));
    expect(plan.ranges[0]!.nextSeq).toBeNull();
  });

  test("refuses a full eval, which would write history for every package", () => {
    const names = Array.from({ length: MAX_BACKFILL_ROWS + 1 }, (_, i) => `p${i}`);
    expect(() => planBackfill([evalOf(1, names)], new Map())).toThrow(/not a hidden-only eval/);
  });

  test("refuses two evals of the same commit and system", () => {
    expect(() => planBackfill([evalOf(1, ["tool"]), evalOf(1, ["tool"])], new Map())).toThrow(/two evals of seq 1/);
  });
});
