import { describe, expect, it } from "vitest";
import { buildEvaluationPlan, type ExistingCandidateRow } from "../src/lib/substitutionStore.js";
import type { CandidateEvaluation } from "../src/lib/substitutionEngine.js";

function evaluation(candidateId: string, verdict: "RECOMMENDED" | "REJECTED" = "RECOMMENDED"): CandidateEvaluation {
  return {
    candidateId,
    verdict,
    totalScore: 50,
    rejectedReasons: [],
    dimensions: {
      craft: { score: 1, level: "EXACT", detail: "" },
      color: { score: 1, level: "EXACT", detail: "" },
      unit: { score: 1, level: "EXACT", detail: "" },
      compatibility: { score: 0.5, level: "UNSPECIFIED", detail: "" },
      stock: { score: 0.5, level: "NEUTRAL", detail: "" }
    },
    stock: { availableQuantity: "0", requiredQuantity: null, ratio: null }
  };
}

describe("substitution recompute plan", () => {
  it("never overwrites locked candidates, even when the new rule changes their verdict", () => {
    const existing: ExistingCandidateRow[] = [
      { candidate_material_id: "m-lock", locked_by: "user-1" },
      { candidate_material_id: "m-auto", locked_by: null },
      { candidate_material_id: "m-gone", locked_by: null }
    ];
    // 新规则下 m-lock 变成了 REJECTED；m-gone 不再出现；新候选 m-new 加入
    const evaluations = [evaluation("m-lock", "REJECTED"), evaluation("m-auto"), evaluation("m-new")];

    const plan = buildEvaluationPlan(existing, evaluations, 2);

    expect(plan.lockedSkipped.map((item) => item.candidateMaterialId)).toEqual(["m-lock"]);
    expect(plan.upserts.some((item) => item.evaluation.candidateId === "m-lock")).toBe(false);
    expect(plan.upserts.map((item) => item.evaluation.candidateId)).toEqual(["m-auto", "m-new"]);
    // 锁定项不参与自动排名，所以 m-auto 仍然是 rank 1
    expect(plan.upserts[0]?.rank).toBe(1);
    expect(plan.upserts.every((item) => item.ruleVersion === 2)).toBe(true);
    expect(plan.deletes.map((item) => item.candidateMaterialId)).toEqual(["m-gone"]);
  });

  it("keeps stale locked rows instead of deleting them", () => {
    const existing: ExistingCandidateRow[] = [{ candidate_material_id: "m-locked-gone", locked_by: "user-1" }];
    const plan = buildEvaluationPlan(existing, [evaluation("m-new")], 3);
    expect(plan.deletes).toEqual([]);
    expect(plan.lockedSkipped.map((item) => item.candidateMaterialId)).toEqual(["m-locked-gone"]);
    expect(plan.upserts.map((item) => item.evaluation.candidateId)).toEqual(["m-new"]);
  });

  it("ranks fresh evaluations from 1 when nothing is locked", () => {
    const existing: ExistingCandidateRow[] = [];
    const plan = buildEvaluationPlan(existing, [evaluation("a"), evaluation("b"), evaluation("c")], 1);
    expect(plan.upserts.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(plan.deletes).toEqual([]);
  });
});
