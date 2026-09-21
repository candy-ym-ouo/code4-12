import {
  MAX_COLOR_DISTANCE,
  colorDistance,
  quantitiesAreCompatible,
  unitFamilies,
  type CompatibilityDecisionValue,
  type CraftType,
  type RecommendationStatus,
  type StockUnit,
  type SubstitutionRejectionReason
} from "@handcraft/contracts";

export type EngineRules = {
  requireSameCraft: boolean;
  requireUnitCompatibility: boolean;
  requireInStock: boolean;
  includeArchived: boolean;
  maxColorDistance: number | null;
  craftWeight: number;
  colorWeight: number;
  unitWeight: number;
  stockWeight: number;
  allowBonus: number;
};

export type EngineMaterial = {
  id: string;
  name: string;
  craftTypes: CraftType[];
  stockUnit: StockUnit;
  defaultColorHex: string | null;
  archived: boolean;
  /** 以 stockUnit 表示的剩余库存，十进制字符串 */
  remainingQuantity: string;
};

export type CompatibilityEntry = {
  candidateId: string;
  decision: CompatibilityDecisionValue;
  note: string | null;
};

export type RecommendationReason = {
  code: SubstitutionRejectionReason | "COMPATIBILITY_ALLOWED";
  message: string;
};

export type DimensionDetail = {
  craft: { score: number; sharedCrafts: CraftType[]; sourceCrafts: CraftType[] };
  color: { score: number | null; distance: number | null; sourceHex: string | null; candidateHex: string | null };
  unit: { score: number; compatible: boolean; exactMatch: boolean; sourceUnit: StockUnit; candidateUnit: StockUnit };
  stock: { score: number | null; convertedQuantity: number | null; referenceQuantity: number | null };
  compatibility: { decision: CompatibilityDecisionValue | null; bonusApplied: number };
};

export type CandidateEvaluation = {
  candidateId: string;
  status: RecommendationStatus;
  score: number | null;
  rankPosition: number | null;
  reasons: RecommendationReason[];
  dimensions: DimensionDetail;
};

export type ExistingRecommendation = {
  id: string;
  candidateId: string;
  locked: boolean;
};

export type RecomputationPlan = {
  results: CandidateEvaluation[];
  /** 重算时需要删除的未锁定旧结果 */
  toDeleteIds: string[];
  /** 重算时保持不动的人工锁定结果 */
  locked: ExistingRecommendation[];
  suggestedCount: number;
  rejectedCount: number;
};

function remainingIsPositive(value: string): boolean {
  return Number(value) > 0;
}

/** 仅用于评分的宽松单位换算（允许精度损失，不用于库存记账） */
function convertForScoring(value: string, from: StockUnit, to: StockUnit): number {
  const fromFactor = Number(unitFamilies[from].factor);
  const toFactor = Number(unitFamilies[to].factor);
  return (Number(value) * fromFactor) / toFactor;
}

function buildRejection(code: SubstitutionRejectionReason, message: string): RecommendationReason {
  return { code, message };
}

/**
 * 按工艺、颜色、单位、库存和兼容性规则评估全部候选材料。
 * 不访问数据库，可独立单测。
 */
export function evaluateCandidates(
  source: EngineMaterial,
  candidates: EngineMaterial[],
  compatibility: CompatibilityEntry[],
  rules: EngineRules
): CandidateEvaluation[] {
  const compatibilityMap = new Map(compatibility.map((entry) => [entry.candidateId, entry]));
  const sourceCraftSet = new Set(source.craftTypes);

  // 库存维度按同族候选中的最大可用库存做相对归一化
  let stockReference = 0;
  const convertedStock = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.id === source.id) continue;
    if (!quantitiesAreCompatible(source.stockUnit, candidate.stockUnit)) {
      convertedStock.set(candidate.id, Number.NaN);
      continue;
    }
    const converted = convertForScoring(candidate.remainingQuantity, candidate.stockUnit, source.stockUnit);
    convertedStock.set(candidate.id, converted);
    if (converted > stockReference) stockReference = converted;
  }

  const evaluations: CandidateEvaluation[] = [];

  for (const candidate of candidates) {
    if (candidate.id === source.id) continue;

    const reasons: RecommendationReason[] = [];
    const dimensions: DimensionDetail = {
      craft: { score: 0, sharedCrafts: [], sourceCrafts: [...source.craftTypes] },
      color: { score: null, distance: null, sourceHex: source.defaultColorHex, candidateHex: candidate.defaultColorHex },
      unit: {
        score: 0,
        compatible: false,
        exactMatch: source.stockUnit === candidate.stockUnit,
        sourceUnit: source.stockUnit,
        candidateUnit: candidate.stockUnit
      },
      stock: { score: null, convertedQuantity: null, referenceQuantity: null },
      compatibility: { decision: compatibilityMap.get(candidate.id)?.decision ?? null, bonusApplied: 0 }
    };

    // --- 硬性拒绝条件（全部收集，便于一次性解释） ---
    const entry = compatibilityMap.get(candidate.id);
    if (entry?.decision === "BLOCKED") {
      reasons.push(
        buildRejection(
          "COMPATIBILITY_BLOCKED",
          entry.note ? `被兼容性规则明确禁止替代：${entry.note}` : "被兼容性规则明确标记为禁止替代"
        )
      );
    }
    if (candidate.archived && !rules.includeArchived) {
      reasons.push(buildRejection("CANDIDATE_ARCHIVED", "候选材料已归档"));
    }

    const sharedCrafts = candidate.craftTypes.filter((craft) => sourceCraftSet.has(craft));
    dimensions.craft.sharedCrafts = sharedCrafts;
    const craftUnion = new Set([...source.craftTypes, ...candidate.craftTypes]);
    dimensions.craft.score = craftUnion.size === 0 ? 0 : sharedCrafts.length / craftUnion.size;
    if (rules.requireSameCraft && sharedCrafts.length === 0) {
      reasons.push(buildRejection("CRAFT_MISMATCH", "工艺不匹配：与被替代材料的适用工艺没有交集"));
    }

    const unitCompatible = quantitiesAreCompatible(source.stockUnit, candidate.stockUnit);
    dimensions.unit.compatible = unitCompatible;
    dimensions.unit.score = dimensions.unit.exactMatch ? 1 : unitCompatible ? 0.7 : 0;
    if (rules.requireUnitCompatibility && !unitCompatible) {
      reasons.push(
        buildRejection(
          "UNIT_INCOMPATIBLE",
          `单位不兼容：${candidate.stockUnit} 与 ${source.stockUnit} 不属于同一计量单位族，无法换算`
        )
      );
    }

    const hasStock = remainingIsPositive(candidate.remainingQuantity);
    if (rules.requireInStock && !hasStock) {
      reasons.push(buildRejection("NO_STOCK", "候选材料当前无可用库存"));
    }
    const converted = convertedStock.get(candidate.id);
    if (unitCompatible && converted !== undefined && !Number.isNaN(converted)) {
      dimensions.stock.convertedQuantity = Number(converted.toFixed(6));
      dimensions.stock.referenceQuantity = Number(stockReference.toFixed(6));
      dimensions.stock.score = stockReference > 0 ? Math.min(1, converted / stockReference) : 0;
    }

    if (source.defaultColorHex && candidate.defaultColorHex) {
      const distance = colorDistance(source.defaultColorHex, candidate.defaultColorHex);
      dimensions.color.distance = Number(distance.toFixed(2));
      dimensions.color.score = Number(Math.max(0, 1 - distance / MAX_COLOR_DISTANCE).toFixed(4));
      if (rules.maxColorDistance !== null && distance > rules.maxColorDistance) {
        reasons.push(
          buildRejection(
            "COLOR_DISTANCE_EXCEEDED",
            `颜色差异过大：色差值 ${distance.toFixed(1)} 超过规则阈值 ${rules.maxColorDistance.toFixed(1)}`
          )
        );
      }
    }

    const rejected = reasons.length > 0;
    if (rejected) {
      evaluations.push({
        candidateId: candidate.id,
        status: "REJECTED",
        score: null,
        rankPosition: null,
        reasons,
        dimensions
      });
      continue;
    }

    // --- 加权评分：缺失数据的维度不参与，其权重在可用维度间按比例归一化 ---
    const weightedParts: Array<{ weight: number; score: number; available: boolean }> = [
      { weight: rules.craftWeight, score: dimensions.craft.score, available: true },
      { weight: rules.colorWeight, score: dimensions.color.score ?? 0, available: dimensions.color.score !== null },
      { weight: rules.unitWeight, score: dimensions.unit.score, available: true },
      { weight: rules.stockWeight, score: dimensions.stock.score ?? 0, available: dimensions.stock.score !== null }
    ];
    const availableParts = weightedParts.filter((part) => part.weight > 0 && part.available);
    const weightSum = availableParts.reduce((sum, part) => sum + part.weight, 0);
    // 有权重的维度恰好全部缺数据时（例如权重全押颜色但双方都未设置颜色）给中性分
    let score = weightSum === 0
      ? 0
      : availableParts.reduce((sum, part) => sum + part.weight * part.score, 0) / weightSum;

    if (entry?.decision === "ALLOWED") {
      const bonus = Math.min(rules.allowBonus, 1 - score);
      score += bonus;
      dimensions.compatibility.bonusApplied = Number(bonus.toFixed(4));
      reasons.push({
        code: "COMPATIBILITY_ALLOWED",
        message: entry.note ? `兼容性规则允许替代：${entry.note}` : "已在兼容性规则中标记为允许替代"
      });
    }

    evaluations.push({
      candidateId: candidate.id,
      status: "SUGGESTED",
      score: Number(score.toFixed(4)),
      rankPosition: null,
      reasons,
      dimensions
    });
  }

  // 确定性排序：分数降序，平局按材料名、ID 兜底
  const candidateNames = new Map(candidates.map((candidate) => [candidate.id, candidate.name]));
  const suggested = evaluations
    .filter((evaluation) => evaluation.status === "SUGGESTED")
    .sort((left, right) => {
      if ((right.score ?? 0) !== (left.score ?? 0)) return (right.score ?? 0) - (left.score ?? 0);
      const nameCompare = (candidateNames.get(left.candidateId) ?? "").localeCompare(candidateNames.get(right.candidateId) ?? "");
      return nameCompare !== 0 ? nameCompare : left.candidateId.localeCompare(right.candidateId);
    });
  suggested.forEach((evaluation, index) => {
    evaluation.rankPosition = index + 1;
  });

  const rejectedRows = evaluations.filter((evaluation) => evaluation.status === "REJECTED");
  return [...suggested, ...rejectedRows];
}

/**
 * 基于现有推荐结果制定重算计划：
 * - 已锁定的候选保持原结果不动，不参与本次计算与排名；
 * - 未锁定旧结果全部删除，用当前规则重建。
 */
export function planRecomputation(
  source: EngineMaterial,
  candidates: EngineMaterial[],
  compatibility: CompatibilityEntry[],
  rules: EngineRules,
  existing: ExistingRecommendation[]
): RecomputationPlan {
  const locked = existing.filter((row) => row.locked);
  const lockedCandidateIds = new Set(locked.map((row) => row.candidateId));
  const eligibleCandidates = candidates.filter((candidate) => !lockedCandidateIds.has(candidate.id));
  const results = evaluateCandidates(source, eligibleCandidates, compatibility, rules);
  return {
    results,
    toDeleteIds: existing.filter((row) => !row.locked).map((row) => row.id),
    locked,
    suggestedCount: results.filter((row) => row.status === "SUGGESTED").length,
    rejectedCount: results.filter((row) => row.status === "REJECTED").length
  };
}
