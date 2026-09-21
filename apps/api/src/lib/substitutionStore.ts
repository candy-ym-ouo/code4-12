import type { DbClient } from "./db.js";
import {
  type CraftType,
  type StockUnit,
  type SubstitutionRejectCode
} from "@handcraft/contracts";
import {
  evaluateSubstitutions,
  rejectReasonMessages,
  type CandidateEvaluation,
  type EngineMaterial,
  type SubstitutionRule
} from "./substitutionEngine.js";

type QueryExecutor = Pick<DbClient, "query">;

export type StoredRule = SubstitutionRule & {
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  activatedAt: Date;
};

export async function getActiveRule(client: QueryExecutor): Promise<StoredRule | null> {
  const result = await client.query(
    `SELECT version, name, require_craft_overlap AS "requireCraftOverlap",
            require_color_match AS "requireColorMatch", require_unit_family AS "requireUnitFamily",
            require_stock AS "requireStock", color_distance_threshold::text AS "colorDistanceThreshold",
            weight_craft AS "weightCraft", weight_color AS "weightColor", weight_unit AS "weightUnit",
            weight_compatibility AS "weightCompatibility", weight_stock AS "weightStock",
            is_active AS "isActive", notes, created_at AS "createdAt", activated_at AS "activatedAt"
       FROM substitution_rule_versions WHERE is_active = true`
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    colorDistanceThreshold: Number(row.colorDistanceThreshold)
  } as StoredRule;
}

const materialSql = `
  SELECT m.id, m.name, m.code, m.craft_types AS "craftTypes", m.stock_unit AS "stockUnit",
         m.archived_at AS "archivedAt", m.default_color_name AS "defaultColorName",
         m.default_color_hex AS "defaultColorHex",
         (
           SELECT b.current_color_name
             FROM batches b
            WHERE b.material_id = m.id AND b.status <> 'ARCHIVED'
            ORDER BY b.color_updated_at DESC NULLS LAST, b.received_at DESC, b.created_at DESC
            LIMIT 1
         ) AS "currentColorName",
         (
           SELECT b.current_color_hex
             FROM batches b
            WHERE b.material_id = m.id AND b.status <> 'ARCHIVED'
            ORDER BY b.color_updated_at DESC NULLS LAST, b.received_at DESC, b.created_at DESC
            LIMIT 1
         ) AS "currentColorHex",
         coalesce((
           SELECT sum(b.remaining_quantity)
             FROM batches b
            WHERE b.material_id = m.id AND b.status <> 'ARCHIVED'
         ), 0)::text AS "remainingQuantity"
    FROM materials m`;

type MaterialRow = {
  id: string;
  name: string;
  code: string | null;
  craftTypes: CraftType[];
  stockUnit: StockUnit;
  archivedAt: Date | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  currentColorName: string | null;
  currentColorHex: string | null;
  remainingQuantity: string;
};

export async function loadTargetMaterial(client: QueryExecutor, materialId: string): Promise<EngineMaterial | null> {
  const result = await client.query<MaterialRow>(`${materialSql} WHERE m.id = $1`, [materialId]);
  return result.rows[0] ? toEngineMaterial(result.rows[0]) : null;
}

export async function loadCandidateMaterials(client: QueryExecutor): Promise<EngineMaterial[]> {
  const result = await client.query<MaterialRow>(materialSql);
  return result.rows.map(toEngineMaterial);
}

function toEngineMaterial(row: MaterialRow): EngineMaterial {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    craftTypes: row.craftTypes,
    stockUnit: row.stockUnit,
    archived: row.archivedAt !== null,
    color: {
      name: row.currentColorName ?? row.defaultColorName,
      hex: row.currentColorHex ?? row.defaultColorHex
    },
    remainingQuantity: row.remainingQuantity
  };
}

export async function buildCompatibilityLookup(
  client: QueryExecutor
): Promise<(fromMaterialId: string, toMaterialId: string) => boolean | null> {
  const result = await client.query<{
    from_material_id: string;
    to_material_id: string;
    direction: "BIDIRECTIONAL" | "ONE_WAY";
    compatible: boolean;
  }>("SELECT from_material_id, to_material_id, direction, compatible FROM material_compatibility");
  return (fromMaterialId, toMaterialId) => {
    for (const rule of result.rows) {
      if (rule.from_material_id === fromMaterialId && rule.to_material_id === toMaterialId) {
        return rule.compatible;
      }
      if (
        rule.direction === "BIDIRECTIONAL" &&
        rule.from_material_id === toMaterialId &&
        rule.to_material_id === fromMaterialId
      ) {
        return rule.compatible;
      }
    }
    return null;
  };
}

export type PersistInput = {
  analysisId: string;
  target: { material: EngineMaterial; requiredQuantity?: string };
  rule: SubstitutionRule;
};

export type ExistingCandidateRow = {
  candidate_material_id: string;
  locked_by: string | null;
};

export type EvaluationPlan = {
  upserts: { evaluation: CandidateEvaluation; rank: number; ruleVersion: number }[];
  deletes: { candidateMaterialId: string }[];
  /** 人工锁定，重算时整体跳过（不更新结论/分数/原因/排名）。 */
  lockedSkipped: { candidateMaterialId: string }[];
};

/**
 * 纯函数：根据现有候选行（含锁定标记）和最新引擎结果，决定重算时新增/更新、删除、跳过哪些候选。
 */
export function buildEvaluationPlan(
  existing: ExistingCandidateRow[],
  evaluations: CandidateEvaluation[],
  ruleVersion: number
): EvaluationPlan {
  const lockedIds = new Set(existing.filter((row) => row.locked_by !== null).map((row) => row.candidate_material_id));
  const currentIds = new Set(evaluations.map((evaluation) => evaluation.candidateId));

  const deletes: EvaluationPlan["deletes"] = [];
  const lockedSkipped: EvaluationPlan["lockedSkipped"] = [];
  for (const row of existing) {
    if (lockedIds.has(row.candidate_material_id)) {
      lockedSkipped.push({ candidateMaterialId: row.candidate_material_id });
    } else if (!currentIds.has(row.candidate_material_id)) {
      deletes.push({ candidateMaterialId: row.candidate_material_id });
    }
  }

  const upserts: EvaluationPlan["upserts"] = [];
  let autoRank = 0;
  for (const evaluation of evaluations) {
    if (lockedIds.has(evaluation.candidateId)) continue; // 锁定结果不被重算覆盖
    autoRank += 1;
    upserts.push({ evaluation, rank: autoRank, ruleVersion });
  }
  return { upserts, deletes, lockedSkipped };
}

/**
 * 用当前规则重算未锁定候选，并把结果落库。
 * 人工锁定（locked_by 非空）的候选其 verdict / 分数 / 拒绝原因 / rank 一律不覆盖。
 */
export async function persistEvaluations(client: QueryExecutor, input: PersistInput): Promise<void> {
  const [candidates, compatibility] = await Promise.all([
    loadCandidateMaterials(client),
    buildCompatibilityLookup(client)
  ]);
  const result = evaluateSubstitutions(input.target, candidates, input.rule, compatibility);

  const existing = await client.query<ExistingCandidateRow>(
    `SELECT candidate_material_id, locked_by FROM substitution_candidates WHERE analysis_id = $1`,
    [input.analysisId]
  );
  const evaluations: CandidateEvaluation[] = [...result.recommended, ...result.rejected];
  const plan = buildEvaluationPlan(existing.rows, evaluations, input.rule.version);

  for (const deleted of plan.deletes) {
    await client.query("DELETE FROM substitution_candidates WHERE analysis_id = $1 AND candidate_material_id = $2", [
      input.analysisId,
      deleted.candidateMaterialId
    ]);
  }
  for (const upsert of plan.upserts) {
    await upsertEvaluation(client, input.analysisId, upsert.evaluation, upsert.rank, upsert.ruleVersion);
  }
}

async function upsertEvaluation(
  client: QueryExecutor,
  analysisId: string,
  evaluation: CandidateEvaluation,
  rank: number,
  ruleVersion: number
): Promise<void> {
  await client.query(
    `INSERT INTO substitution_candidates
       (analysis_id, candidate_material_id, rank, verdict, total_score, score_breakdown,
        rejected_codes, available_quantity, required_quantity_in_candidate_unit, rule_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (analysis_id, candidate_material_id) DO UPDATE SET
       rank = EXCLUDED.rank,
       verdict = EXCLUDED.verdict,
       total_score = EXCLUDED.total_score,
       score_breakdown = EXCLUDED.score_breakdown,
       rejected_codes = EXCLUDED.rejected_codes,
       available_quantity = EXCLUDED.available_quantity,
       required_quantity_in_candidate_unit = EXCLUDED.required_quantity_in_candidate_unit,
       rule_version = EXCLUDED.rule_version`,
    [
      analysisId,
      evaluation.candidateId,
      rank,
      evaluation.verdict,
      evaluation.totalScore,
      JSON.stringify(evaluation.dimensions),
      evaluation.rejectedReasons.map((reason) => reason.code) as SubstitutionRejectCode[],
      evaluation.stock.availableQuantity,
      evaluation.stock.requiredQuantity,
      ruleVersion
    ]
  );
}

export { rejectReasonMessages };
