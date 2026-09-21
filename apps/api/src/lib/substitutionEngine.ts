import {
  convertQuantity,
  quantitiesAreCompatible,
  type CraftType,
  type StockUnit,
  type SubstitutionRejectCode
} from "@handcraft/contracts";

/**
 * 材料替代推荐引擎（纯函数，不访问数据库，方便单元测试与规则改版重算）。
 *
 * 排序维度：工艺、颜色、单位、显式兼容性、库存。
 * 每个候选都会产出 0-100 的综合分；被硬性规则拒绝的候选仍然保留各维度分数，
 * 并附带结构化拒绝原因，供界面解释“为什么不推荐”。
 */

export type SubstitutionRule = {
  version: number;
  name: string;
  requireCraftOverlap: boolean;
  requireColorMatch: boolean;
  requireUnitFamily: boolean;
  requireStock: boolean;
  colorDistanceThreshold: number;
  weightCraft: number;
  weightColor: number;
  weightUnit: number;
  weightCompatibility: number;
  weightStock: number;
};

export const DEFAULT_SUBSTITUTION_RULE: Omit<SubstitutionRule, "version" | "name"> = {
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

export const rejectReasonMessages: Record<SubstitutionRejectCode, string> = {
  CRAFT_MISMATCH: "适用工艺与所需工艺完全不重叠",
  COLOR_MISMATCH: "颜色超出规则允许的色差范围，或候选缺少颜色信息",
  UNIT_INCOMPATIBLE: "计量单位不属于同一量纲，无法换算使用",
  COMPATIBILITY_EXCLUDED: "兼容性矩阵已明确标注两种材料不可互相替代",
  INSUFFICIENT_STOCK: "可用库存不满足所需数量",
  CANDIDATE_ARCHIVED: "候选材料已归档"
};

export type EngineColor = { name: string | null; hex: string | null };

export type EngineMaterial = {
  id: string;
  name: string;
  code: string | null;
  craftTypes: CraftType[];
  stockUnit: StockUnit;
  archived: boolean;
  color: EngineColor;
  /** 非归档批次在材料自身库存单位下的聚合剩余量（十进制字符串）。 */
  remainingQuantity: string;
};

export type EngineTarget = {
  material: Omit<EngineMaterial, "remainingQuantity">;
  requiredQuantity?: string;
  requiredUnit?: StockUnit;
};

/** 查询 (fromMaterialId, toMaterialId) 得到的显式兼容判定。 */
export type CompatibilityLookup = (fromMaterialId: string, toMaterialId: string) => boolean | null;

export type DimensionScore = {
  score: number;
  level: string;
  detail: string;
};

export type CandidateEvaluation = {
  candidateId: string;
  verdict: "RECOMMENDED" | "REJECTED";
  totalScore: number;
  rejectedReasons: { code: SubstitutionRejectCode; message: string }[];
  dimensions: {
    craft: DimensionScore;
    color: DimensionScore;
    unit: DimensionScore;
    compatibility: DimensionScore;
    stock: DimensionScore;
  };
  /** 折算到候选库存单位后的可用库存与需求量；无法换算时为 null。 */
  stock: { availableQuantity: string; requiredQuantity: string | null; ratio: number | null };
};

export type EvaluationResult = {
  recommended: CandidateEvaluation[];
  rejected: CandidateEvaluation[];
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function colorDistance(left: string, right: string): number {
  const parse = (hex: string): [number, number, number] => {
    const normalized = hex.replace("#", "");
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16)
    ];
  };
  const [r1, g1, b1] = parse(left);
  const [r2, g2, b2] = parse(right);
  const meanR = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  // redmean 近似，比朴素欧氏距离更接近人眼感知
  return Math.sqrt((2 + meanR / 256) * dr * dr + 4 * dg * dg + (2 + (255 - meanR) / 256) * db * db);
}

function normalizeColorName(name: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

function scoreColor(target: EngineColor, candidate: EngineColor, threshold: number): DimensionScore {
  if (target.hex && candidate.hex) {
    const distance = colorDistance(target.hex, candidate.hex);
    if (distance === 0) return { score: 1, level: "EXACT", detail: "色值完全一致" };
    if (distance <= threshold) {
      return {
        score: clamp01(1 - 0.3 * (distance / threshold)),
        level: "CLOSE",
        detail: `色值色差 ${distance.toFixed(1)}，在阈值 ${threshold} 以内`
      };
    }
    return { score: 0, level: "FAR", detail: `色值色差 ${distance.toFixed(1)}，超过阈值 ${threshold}` };
  }
  const targetName = normalizeColorName(target.name);
  const candidateName = normalizeColorName(candidate.name);
  if (targetName && candidateName) {
    if (targetName === candidateName) return { score: 1, level: "EXACT", detail: "颜色名称完全一致" };
    if (targetName.includes(candidateName) || candidateName.includes(targetName)) {
      return { score: 0.4, level: "CLOSE", detail: "颜色名称相近" };
    }
    return { score: 0.2, level: "FAR", detail: "颜色名称不一致" };
  }
  if (target.hex && !candidate.hex && !candidateName) {
    return { score: 0, level: "UNKNOWN", detail: "候选材料未记录颜色" };
  }
  if (!targetName && !target.hex) {
    return { score: 0.5, level: "NEUTRAL", detail: "目标材料未指定颜色，按中性处理" };
  }
  return { score: 0.5, level: "NEUTRAL", detail: "颜色信息不足，按中性处理" };
}

function ratioOfQuantities(available: string, required: string): number {
  const toScaled = (value: string): bigint => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  const av = toScaled(available);
  const rv = toScaled(required);
  if (rv <= 0n || av <= 0n) return 0;
  const scaled = Number((av * 1_000_000n) / rv) / 1_000_000;
  return clamp01(scaled);
}

/**
 * 评估单个候选材料。
 */
export function evaluateCandidate(
  target: EngineTarget,
  candidate: EngineMaterial,
  rule: Omit<SubstitutionRule, "version" | "name">,
  compatibility: CompatibilityLookup
): CandidateEvaluation {
  const reasons: CandidateEvaluation["rejectedReasons"] = [];
  const reject = (code: SubstitutionRejectCode): void => {
    reasons.push({ code, message: rejectReasonMessages[code] });
  };

  if (candidate.archived) reject("CANDIDATE_ARCHIVED");

  // 1) 工艺
  const overlap = target.material.craftTypes.filter((craft) => candidate.craftTypes.includes(craft));
  const craftScore: DimensionScore =
    target.material.craftTypes.length > 0
      ? overlap.length > 0
        ? {
            score: overlap.length / target.material.craftTypes.length,
            level: overlap.length === target.material.craftTypes.length ? "EXACT" : "PARTIAL",
            detail: `覆盖 ${overlap.length}/${target.material.craftTypes.length} 种所需工艺`
          }
        : { score: 0, level: "NONE", detail: "没有任何共同适用工艺" }
      : { score: 0.5, level: "NEUTRAL", detail: "目标未限定工艺" };
  if (rule.requireCraftOverlap && overlap.length === 0) reject("CRAFT_MISMATCH");

  // 2) 颜色
  const colorScore = scoreColor(target.material.color, candidate.color, rule.colorDistanceThreshold);
  if (rule.requireColorMatch && colorScore.level === "FAR") reject("COLOR_MISMATCH");
  if (rule.requireColorMatch && colorScore.level === "UNKNOWN") reject("COLOR_MISMATCH");

  // 3) 单位（量纲）
  let unitScore: DimensionScore;
  if (target.material.stockUnit === candidate.stockUnit) {
    unitScore = { score: 1, level: "EXACT", detail: `计量单位一致（${candidate.stockUnit}）` };
  } else if (quantitiesAreCompatible(target.material.stockUnit, candidate.stockUnit)) {
    unitScore = {
      score: 0.6,
      level: "CONVERTIBLE",
      detail: `${target.material.stockUnit} 与 ${candidate.stockUnit} 同量纲，可换算`
    };
  } else {
    unitScore = {
      score: 0,
      level: "INCOMPATIBLE",
      detail: `${target.material.stockUnit} 与 ${candidate.stockUnit} 量纲不同，无法换算`
    };
    if (rule.requireUnitFamily) reject("UNIT_INCOMPATIBLE");
  }

  // 4) 显式兼容性矩阵
  const explicit = compatibility(target.material.id, candidate.id);
  let compatibilityScore: DimensionScore;
  if (explicit === true) {
    compatibilityScore = { score: 1, level: "APPROVED", detail: "兼容性矩阵明确标注可替代" };
  } else if (explicit === false) {
    compatibilityScore = { score: 0, level: "EXCLUDED", detail: "兼容性矩阵明确标注不可替代" };
    reject("COMPATIBILITY_EXCLUDED");
  } else {
    compatibilityScore = { score: 0.5, level: "UNSPECIFIED", detail: "兼容性矩阵未标注，按中性处理" };
  }

  // 5) 库存（折算到候选库存单位比较）
  let stockScore: DimensionScore;
  let stock: CandidateEvaluation["stock"] = {
    availableQuantity: candidate.remainingQuantity,
    requiredQuantity: null,
    ratio: null
  };
  const requiredInTargetUnit = target.requiredQuantity ?? null;
  const requiredUnit = target.requiredUnit ?? target.material.stockUnit;
  if (requiredInTargetUnit && !candidate.archived) {
    let requiredInCandidateUnit: string | null = null;
    if (quantitiesAreCompatible(requiredUnit, candidate.stockUnit)) {
      try {
        requiredInCandidateUnit = convertQuantity(requiredInTargetUnit, requiredUnit, candidate.stockUnit);
      } catch {
        requiredInCandidateUnit = null;
      }
    }
    if (requiredInCandidateUnit === null) {
      stockScore = { score: 0, level: "UNMEASURABLE", detail: "需求量与候选库存量纲不同，无法比较" };
    } else {
      const ratio = ratioOfQuantities(candidate.remainingQuantity, requiredInCandidateUnit);
      stock = { availableQuantity: candidate.remainingQuantity, requiredQuantity: requiredInCandidateUnit, ratio };
      if (ratio === 0) {
        stockScore = {
          score: 0,
          level: "EMPTY",
          detail: `可用 ${candidate.remainingQuantity} ${candidate.stockUnit}，需要 ${requiredInCandidateUnit} ${candidate.stockUnit}`
        };
        if (rule.requireStock) reject("INSUFFICIENT_STOCK");
      } else if (ratio < 1) {
        stockScore = {
          score: ratio,
          level: "PARTIAL",
          detail: `仅能满足约 ${(ratio * 100).toFixed(1)}% 的需求`
        };
        if (rule.requireStock) reject("INSUFFICIENT_STOCK");
      } else {
        stockScore = { score: 1, level: "SUFFICIENT", detail: "库存满足需求" };
      }
    }
  } else if (candidate.archived) {
    stockScore = { score: 0, level: "UNAVAILABLE", detail: "材料已归档，无可用库存" };
  } else {
    stockScore = {
      score: 0.5,
      level: "NEUTRAL",
      detail: `未提供需求量，按当前库存 ${candidate.remainingQuantity} ${candidate.stockUnit} 中性处理`
    };
  }

  const weighted =
    craftScore.score * rule.weightCraft +
    colorScore.score * rule.weightColor +
    unitScore.score * rule.weightUnit +
    compatibilityScore.score * rule.weightCompatibility +
    stockScore.score * rule.weightStock;
  const totalScore = Math.round((weighted / 100) * 100);

  return {
    candidateId: candidate.id,
    verdict: reasons.length === 0 ? "RECOMMENDED" : "REJECTED",
    totalScore,
    rejectedReasons: reasons,
    dimensions: {
      craft: craftScore,
      color: colorScore,
      unit: unitScore,
      compatibility: compatibilityScore,
      stock: stockScore
    },
    stock
  };
}

/**
 * 评估整个候选集合，推荐项按综合分降序，拒绝项按分数降序附在后面并解释原因。
 */
export function evaluateSubstitutions(
  target: EngineTarget,
  candidates: EngineMaterial[],
  rule: Omit<SubstitutionRule, "version" | "name">,
  compatibility: CompatibilityLookup
): EvaluationResult {
  const evaluations = candidates
    .filter((candidate) => candidate.id !== target.material.id)
    .map((candidate) => evaluateCandidate(target, candidate, rule, compatibility));
  return {
    recommended: evaluations
      .filter((item) => item.verdict === "RECOMMENDED")
      .sort((a, b) => b.totalScore - a.totalScore || a.candidateId.localeCompare(b.candidateId)),
    rejected: evaluations
      .filter((item) => item.verdict === "REJECTED")
      .sort((a, b) => b.totalScore - a.totalScore || a.candidateId.localeCompare(b.candidateId))
  };
}
