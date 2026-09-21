import { describe, expect, it } from "vitest";
import {
  analysisInputSchema,
  compatibilityInputSchema,
  substitutionRuleInputSchema
} from "@handcraft/contracts";

const validRule = {
  name: "测试规则",
  requireCraftOverlap: true,
  requireColorMatch: false,
  requireUnitFamily: true,
  requireStock: false,
  colorDistanceThreshold: 60,
  weightCraft: 30,
  weightColor: 20,
  weightUnit: 15,
  weightCompatibility: 25,
  weightStock: 10
};

describe("substitution contract schemas", () => {
  it("accepts a balanced rule", () => {
    expect(substitutionRuleInputSchema.safeParse(validRule).success).toBe(true);
  });

  it("rejects rules whose weights do not sum to 100", () => {
    const result = substitutionRuleInputSchema.safeParse({ ...validRule, weightStock: 20 });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range color threshold and weights", () => {
    expect(substitutionRuleInputSchema.safeParse({ ...validRule, colorDistanceThreshold: 500 }).success).toBe(false);
    expect(substitutionRuleInputSchema.safeParse({ ...validRule, weightCraft: -1 }).success).toBe(false);
  });

  it("rejects a unit without required quantity", () => {
    const result = analysisInputSchema.safeParse({
      materialId: "00000000-0000-0000-0000-000000000001",
      unit: "g"
    });
    expect(result.success).toBe(false);
  });

  it("accepts quantity and unit together", () => {
    const result = analysisInputSchema.safeParse({
      materialId: "00000000-0000-0000-0000-000000000001",
      requiredQuantity: "500",
      unit: "g"
    });
    expect(result.success).toBe(true);
  });

  it("validates compatibility payloads", () => {
    const valid = compatibilityInputSchema.safeParse({
      otherMaterialId: "00000000-0000-0000-0000-000000000002",
      direction: "BIDIRECTIONAL",
      compatible: false
    });
    expect(valid.success).toBe(true);
    expect(
      compatibilityInputSchema.safeParse({
        otherMaterialId: "not-uuid",
        direction: "SIDEWAYS",
        compatible: true
      }).success
    ).toBe(false);
  });
});
