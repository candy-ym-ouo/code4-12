import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBSTITUTION_RULE,
  colorDistance,
  evaluateSubstitutions,
  rejectReasonMessages,
  type CompatibilityLookup,
  type EngineMaterial
} from "../src/lib/substitutionEngine.js";

const target = {
  material: {
    id: "m-target",
    name: "苏木染材",
    code: null,
    craftTypes: ["DYEING"] as const,
    stockUnit: "g" as const,
    archived: false,
    color: { name: "原木棕", hex: "#8B5A2B" }
  },
  requiredQuantity: "500",
  requiredUnit: "g" as const
};

function material(partial: Partial<EngineMaterial> & Pick<EngineMaterial, "id" | "name">): EngineMaterial {
  return {
    code: null,
    craftTypes: ["DYEING"],
    stockUnit: "g",
    archived: false,
    color: { name: null, hex: null },
    remainingQuantity: "1000.000000",
    ...partial
  };
}

const noRules: CompatibilityLookup = () => null;

describe("substitution engine", () => {
  it("ranks a full match above a weak match", () => {
    const exact = material({
      id: "m-exact",
      name: "同类染材",
      color: { name: "原木棕", hex: "#8B5A2B" }
    });
    const weak = material({
      id: "m-weak",
      name: "别的染材",
      craftTypes: ["DYEING", "POTTERY"],
      color: { name: "冷灰", hex: "#303030" },
      remainingQuantity: "10.000000"
    });
    const { recommended } = evaluateSubstitutions(target, [weak, exact], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(recommended.map((item) => item.candidateId)).toEqual(["m-exact", "m-weak"]);
    expect(recommended[0]?.totalScore).toBeGreaterThan(recommended[1]?.totalScore ?? 0);
    expect(recommended[0]?.dimensions.color.level).toBe("EXACT");
  });

  it("rejects craft mismatch with an explainable reason when craft overlap is required", () => {
    const otherCraft = material({ id: "m-metal", name: "铜片", craftTypes: ["METALWORKING"] });
    const { recommended, rejected } = evaluateSubstitutions(target, [otherCraft], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(recommended).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.rejectedReasons.map((reason) => reason.code)).toContain("CRAFT_MISMATCH");
    expect(rejected[0]?.rejectedReasons[0]?.message).toBe(rejectReasonMessages.CRAFT_MISMATCH);
    expect(rejected[0]?.dimensions.craft.score).toBe(0);
  });

  it("keeps craft-only mismatch as recommended when the rule does not require overlap", () => {
    const relaxed = { ...DEFAULT_SUBSTITUTION_RULE, requireCraftOverlap: false };
    const otherCraft = material({ id: "m-metal", name: "铜片", craftTypes: ["METALWORKING"] });
    const { recommended } = evaluateSubstitutions(target, [otherCraft], relaxed, noRules);
    expect(recommended).toHaveLength(1);
  });

  it("rejects incompatible units by default and converts compatible families for stock comparison", () => {
    const pieces = material({ id: "m-pcs", name: "按件卖的染材", stockUnit: "pcs" });
    const kilos = material({ id: "m-kg", name: "公斤装染材", stockUnit: "kg", remainingQuantity: "1.000000" });
    const { recommended, rejected } = evaluateSubstitutions(target, [pieces, kilos], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(recommended.map((item) => item.candidateId)).toEqual(["m-kg"]);
    expect(rejected[0]?.rejectedReasons.map((reason) => reason.code)).toContain("UNIT_INCOMPATIBLE");
    // 需求量折算到候选单位：500 g = 0.5 kg；库存 1 kg 充足
    expect(recommended[0]?.stock.requiredQuantity).toBe("0.500000");
    expect(recommended[0]?.dimensions.stock.level).toBe("SUFFICIENT");
  });

  it("marks partial stock as PARTIAL and only rejects it when requireStock is on", () => {
    const scarce = material({ id: "m-scarce", name: "少量染材", remainingQuantity: "250.000000" });
    const soft = evaluateSubstitutions(target, [scarce], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(soft.recommended).toHaveLength(1);
    expect(soft.recommended[0]?.dimensions.stock.level).toBe("PARTIAL");

    const strict = evaluateSubstitutions(
      target,
      [scarce],
      { ...DEFAULT_SUBSTITUTION_RULE, requireStock: true },
      noRules
    );
    expect(strict.rejected[0]?.rejectedReasons.map((reason) => reason.code)).toContain("INSUFFICIENT_STOCK");
  });

  it("explicit exclusion overrides neutral compatibility and explains the rejection", () => {
    const banned = material({ id: "m-banned", name: "禁用替代品" });
    const lookup: CompatibilityLookup = (from, to) =>
      from === "m-target" && to === "m-banned" ? false : null;
    const { rejected } = evaluateSubstitutions(target, [banned], DEFAULT_SUBSTITUTION_RULE, lookup);
    expect(rejected[0]?.rejectedReasons.map((reason) => reason.code)).toContain("COMPATIBILITY_EXCLUDED");
    expect(rejected[0]?.dimensions.compatibility.level).toBe("EXCLUDED");
  });

  it("explicit approval raises the compatibility score", () => {
    const approved = material({ id: "m-approved", name: "人工确认可替代" });
    const lookup: CompatibilityLookup = (from, to) =>
      from === "m-target" && to === "m-approved" ? true : null;
    const { recommended } = evaluateSubstitutions(target, [approved], DEFAULT_SUBSTITUTION_RULE, lookup);
    expect(recommended[0]?.dimensions.compatibility.level).toBe("APPROVED");
  });

  it("rejects archived candidates", () => {
    const archived = material({ id: "m-old", name: "已归档材料", archived: true });
    const { rejected } = evaluateSubstitutions(target, [archived], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(rejected[0]?.rejectedReasons.map((reason) => reason.code)).toContain("CANDIDATE_ARCHIVED");
  });

  it("excludes the target itself from candidates", () => {
    const self = material({ id: "m-target", name: "自己" });
    const result = evaluateSubstitutions(target, [self], DEFAULT_SUBSTITUTION_RULE, noRules);
    expect(result.recommended).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("computes redmean color distance", () => {
    expect(colorDistance("#000000", "#000000")).toBe(0);
    expect(colorDistance("#000000", "#ffffff")).toBeGreaterThan(400);
    expect(colorDistance("#8B5A2B", "#8B5A2B")).toBe(0);
  });

  it("always explains every rejection in Chinese", () => {
    for (const message of Object.values(rejectReasonMessages)) {
      expect(message.length).toBeGreaterThan(2);
    }
  });
});
