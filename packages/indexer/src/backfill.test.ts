import { describe, expect, test } from "vitest";
import { assertEvalsComplete, MAX_BACKFILL_ROWS, planBackfill, type BackfillEval } from "./backfill.js";
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

  test("windows span each system's first and last eval", () => {
    const plan = planBackfill([evalOf(12, ["tool"]), evalOf(10, []), evalOf(14, [])], new Map());
    expect(plan.windows).toEqual([{ system: SYSTEM, firstSeq: 10, lastSeq: 14 }]);
  });
});

describe("assertEvalsComplete", () => {
  const OTHER = "aarch64-linux";
  const expected = [
    { seq: 10, hash: "1".repeat(40), systems: [OTHER, SYSTEM] },
    { seq: 11, hash: "2".repeat(40), systems: [SYSTEM] },
  ];
  const withOther = (e: BackfillEval): BackfillEval => ({ ...e, system: OTHER });

  test("passes when every commit and system has an eval", () => {
    expect(assertEvalsComplete(expected, [evalOf(10, []), withOther(evalOf(10, [])), evalOf(11, [])])).toEqual([]);
  });

  test("refuses a missing (commit, system), naming it", () => {
    expect(() => assertEvalsComplete(expected, [evalOf(10, []), evalOf(11, [])])).toThrow(
      /1 of 3 expected evals are missing[\s\S]*seq 10\/aarch64-linux \(111111111111\)[\s\S]*--allow-failed-evals/,
    );
  });

  test("refuses a failed tail batch: evals that stop early", () => {
    expect(() => assertEvalsComplete(expected, [evalOf(10, []), withOther(evalOf(10, []))])).toThrow(
      /seq 11\/x86_64-linux/,
    );
  });

  test("with the override, returns what is missing instead", () => {
    expect(assertEvalsComplete(expected, [evalOf(10, [])], { allowFailedEvals: true })).toEqual([
      { seq: 10, hash: "1".repeat(40), system: OTHER },
      { seq: 11, hash: "2".repeat(40), system: SYSTEM },
    ]);
  });
});
