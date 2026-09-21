import { describe, expect, it } from "vitest";
import { evaluateCandidates, planRecomputation, type EngineMaterial, type EngineRules } from "../src/lib/substitutionEngine.js";

const rules: EngineRules = {
  requireSameCraft: true,
  requireUnitCompatibility: true,
  requireInStock: false,
  includeArchived: false,
  maxColorDistance: null,
  craftWeight: 0.35,
  colorWeight: 0.25,
  unitWeight: 0.2,
  stockWeight: 0.2,
  allowBonus: 0.1
};

function material(overrides: Partial<EngineMaterial> & { id: string; name: string }): EngineMaterial {
  return {
    craftTypes: ["DYEING"],
    stockUnit: "g",
    defaultColorHex: null,
    archived: false,
    remainingQuantity: "0",
    ...overrides
  };
}

const source = material({ id: "src", name: "源材料", defaultColorHex: "#ff0000", remainingQuantity: "0" });

describe("substitution engine ranking", () => {
  it("ranks same-craft, same-unit, similar-color, higher-stock candidates first", () => {
    const candidates = [
      material({ id: "far", name: "远色", defaultColorHex: "#0000ff", remainingQuantity: "500" }),
      material({ id: "near", name: "近色", defaultColorHex: "#f80000", remainingQuantity: "900" }),
      material({ id: "mid", name: "中色", defaultColorHex: "#aa0000", remainingQuantity: "300" })
    ];
    const results = evaluateCandidates(source, candidates, [], rules);

    expect(results.map((row) => row.candidateId)).toEqual(["near", "mid", "far"]);
    expect(results[0]?.rankPosition).toBe(1);
    expect(results[1]?.rankPosition).toBe(2);
    expect(results[2]?.rankPosition).toBe(3);
    expect(results.every((row) => row.status === "SUGGESTED")).toBe(true);
    expect((results[0]?.score ?? 0) > (results[2]?.score ?? 0)).toBe(true);
  });

  it("prefers an exact unit match over a compatible family unit", () => {
    const candidates = [
      material({ id: "in-kg", name: "千克装", stockUnit: "kg", defaultColorHex: "#ff0000", remainingQuantity: "0.5" }),
      material({ id: "in-g", name: "克装", stockUnit: "g", defaultColorHex: "#ff0000", remainingQuantity: "500" })
    ];
    const results = evaluateCandidates(source, candidates, [], rules);
    // 两者归一化库存相同（0.5kg = 500g）、颜色相同、工艺相同，单位完全一致者胜出
    expect(results[0]?.candidateId).toBe("in-g");
    expect(results[0]?.dimensions.unit.exactMatch).toBe(true);
  });

  it("never evaluates the source itself", () => {
    const results = evaluateCandidates(source, [source], [], rules);
    expect(results).toHaveLength(0);
  });

  it("applies the ALLOWED bonus and records it as a positive reason", () => {
    const candidates = [
      material({ id: "a", name: "甲", defaultColorHex: "#ff0000", remainingQuantity: "50" }),
      material({ id: "b", name: "乙", defaultColorHex: "#ff0000", remainingQuantity: "100" })
    ];
    const plain = evaluateCandidates(source, candidates, [], rules);
    const allowed = evaluateCandidates(
      source,
      candidates,
      [{ candidateId: "a", decision: "ALLOWED", note: "工作室验证过" }],
      rules
    );
    const allowedA = allowed.find((row) => row.candidateId === "a");
    const plainA = plain.find((row) => row.candidateId === "a");
    expect((allowedA?.score ?? 0)).toBeGreaterThan(plainA?.score ?? 0);
    expect(allowedA?.dimensions.compatibility.bonusApplied).toBeCloseTo(0.1, 5);
    expect(allowedA?.reasons.map((reason) => reason.code)).toContain("COMPATIBILITY_ALLOWED");
  });
});

describe("substitution engine rejection reasons", () => {
  it("rejects craft mismatch", () => {
    const candidates = [material({ id: "wood", name: "木料", craftTypes: ["WOODWORKING"] })];
    const results = evaluateCandidates(source, candidates, [], rules);
    expect(results[0]?.status).toBe("REJECTED");
    expect(results[0]?.reasons.map((reason) => reason.code)).toEqual(["CRAFT_MISMATCH"]);
    expect(results[0]?.score).toBeNull();
    expect(results[0]?.rankPosition).toBeNull();
  });

  it("rejects incompatible units with a specific message", () => {
    const candidates = [material({ id: "pieces", name: "按件卖", craftTypes: ["DYEING"], stockUnit: "pcs" })];
    const results = evaluateCandidates(source, candidates, [], rules);
    const codes = results[0]?.reasons.map((reason) => reason.code) ?? [];
    expect(codes).toContain("UNIT_INCOMPATIBLE");
    expect(results[0]?.reasons[0]?.message).toContain("pcs");
  });

  it("rejects zero-stock candidates when requireInStock is enabled", () => {
    const strict: EngineRules = { ...rules, requireInStock: true };
    const candidates = [material({ id: "empty", name: "无货", remainingQuantity: "0" })];
    const results = evaluateCandidates(source, candidates, [], strict);
    expect(results[0]?.reasons.map((reason) => reason.code)).toContain("NO_STOCK");
  });

  it("rejects archived candidates by default but accepts them when includeArchived is on", () => {
    const candidates = [material({ id: "old", name: "归档料", archived: true })];
    expect(evaluateCandidates(source, candidates, [], rules)[0]?.reasons.map((r) => r.code)).toContain("CANDIDATE_ARCHIVED");
    const included = evaluateCandidates(source, candidates, [], { ...rules, includeArchived: true });
    expect(included[0]?.status).toBe("SUGGESTED");
  });

  it("rejects colors beyond the configured distance threshold", () => {
    const strict: EngineRules = { ...rules, maxColorDistance: 60 };
    const close = material({ id: "close", name: "接近", defaultColorHex: "#ff1010" });
    const far = material({ id: "far", name: "太远", defaultColorHex: "#0000ff" });
    const results = evaluateCandidates(source, [close, far], [], strict);
    const farResult = results.find((row) => row.candidateId === "far");
    expect(farResult?.status).toBe("REJECTED");
    expect(farResult?.reasons.map((r) => r.code)).toContain("COLOR_DISTANCE_EXCEEDED");
    expect(results.find((row) => row.candidateId === "close")?.status).toBe("SUGGESTED");
  });

  it("rejects BLOCKED candidates even when every other rule passes", () => {
    const candidates = [material({ id: "b", name: "禁止料", defaultColorHex: "#ff0000", remainingQuantity: "999" })];
    const results = evaluateCandidates(
      source,
      candidates,
      [{ candidateId: "b", decision: "BLOCKED", note: "会褪色" }],
      rules
    );
    expect(results[0]?.status).toBe("REJECTED");
    expect(results[0]?.reasons[0]).toMatchObject({ code: "COMPATIBILITY_BLOCKED" });
    expect(results[0]?.reasons[0]?.message).toContain("会褪色");
  });

  it("collects every applicable rejection reason at once", () => {
    const strict: EngineRules = { ...rules, requireInStock: true };
    const candidates = [
      material({ id: "bad", name: "全不符", craftTypes: ["POTTERY"], stockUnit: "l", remainingQuantity: "0", archived: true })
    ];
    const codes = evaluateCandidates(source, candidates, [], strict)[0]?.reasons.map((r) => r.code) ?? [];
    expect(codes).toEqual(
      expect.arrayContaining(["CANDIDATE_ARCHIVED", "CRAFT_MISMATCH", "UNIT_INCOMPATIBLE", "NO_STOCK"])
    );
  });
});

describe("substitution engine scoring details", () => {
  it("redistributes weights when color data is missing", () => {
    const noColorCandidate = material({ id: "a", name: "甲", stockUnit: "g", remainingQuantity: "100" });
    const results = evaluateCandidates(source, [noColorCandidate], [], rules);
    // 工艺 1.0、单位 1.0、库存 1.0；颜色权重 0.25 在三项间归一化
    expect(results[0]?.dimensions.color.score).toBeNull();
    expect(results[0]?.score).toBeCloseTo(1, 4);
  });

  it("normalizes stock relative to the largest compatible candidate", () => {
    const candidates = [
      material({ id: "big", name: "大库存", remainingQuantity: "1000" }),
      material({ id: "small", name: "小库存", remainingQuantity: "250" })
    ];
    const results = evaluateCandidates(source, candidates, [], rules);
    const small = results.find((row) => row.candidateId === "small");
    expect(small?.dimensions.stock.score).toBeCloseTo(0.25, 4);
    expect(small?.dimensions.stock.referenceQuantity).toBe(1000);
  });

  it("excludes stock dimension for incompatible unit families", () => {
    const strict: EngineRules = { ...rules, requireUnitCompatibility: false };
    const candidates = [material({ id: "pieces", name: "件", stockUnit: "pcs", remainingQuantity: "10" })];
    const results = evaluateCandidates(source, candidates, [], strict);
    expect(results[0]?.dimensions.stock.score).toBeNull();
  });

  it("returns a neutral score when every weighted dimension is missing data", () => {
    const colorOnly: EngineRules = { ...rules, craftWeight: 0, colorWeight: 1, unitWeight: 0, stockWeight: 0 };
    const noColorSource = material({ id: "src2", name: "无色源", defaultColorHex: null });
    const noColorCandidate = material({ id: "a", name: "甲", defaultColorHex: null });
    const results = evaluateCandidates(noColorSource, [noColorCandidate], [], colorOnly);
    expect(results[0]?.status).toBe("SUGGESTED");
    expect(results[0]?.score).toBe(0);
    expect(Number.isNaN(results[0]?.score ?? Number.NaN)).toBe(false);
  });
});

describe("recomputation plan with manual locks", () => {
  it("preserves locked candidates and drops unlocked rows", () => {
    const candidates = [
      material({ id: "a", name: "甲", remainingQuantity: "100" }),
      material({ id: "b", name: "乙", remainingQuantity: "200" })
    ];
    const existing = [
      { id: "rec-a", candidateId: "a", locked: true },
      { id: "rec-b", candidateId: "b", locked: false },
      { id: "rec-c", candidateId: "missing-material", locked: false }
    ];
    const plan = planRecomputation(source, candidates, [], rules, existing);

    expect(plan.locked.map((row) => row.id)).toEqual(["rec-a"]);
    expect(plan.toDeleteIds.sort()).toEqual(["rec-b", "rec-c"]);
    expect(plan.results.some((row) => row.candidateId === "a")).toBe(false);
    expect(plan.results.some((row) => row.candidateId === "b")).toBe(true);
  });

  it("keeps ranking gap-free after locked candidates are removed", () => {
    const candidates = [
      material({ id: "a", name: "甲", defaultColorHex: "#111111", remainingQuantity: "1" }),
      material({ id: "b", name: "乙", defaultColorHex: "#ff0000", remainingQuantity: "999" })
    ];
    const existing = [{ id: "rec-b", candidateId: "b", locked: true }];
    const plan = planRecomputation(source, candidates, [], rules, existing);
    expect(plan.results).toHaveLength(1);
    expect(plan.results[0]?.candidateId).toBe("a");
    expect(plan.results[0]?.rankPosition).toBe(1);
  });
});
