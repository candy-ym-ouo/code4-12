import type { FastifyInstance } from "fastify";
import {
  compatibilityInputSchema,
  recommendationLockSchema,
  substitutionRuleSetInputSchema,
  type CompatibilityDecisionValue
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import {
  planRecomputation,
  type CompatibilityEntry,
  type EngineMaterial,
  type EngineRules,
  type ExistingRecommendation
} from "../lib/substitutionEngine.js";

type RuleRow = {
  id: string;
  version: number;
  name: string;
  require_same_craft: boolean;
  require_unit_compatibility: boolean;
  require_in_stock: boolean;
  include_archived: boolean;
  max_color_distance: string | null;
  craft_weight: string;
  color_weight: string;
  unit_weight: string;
  stock_weight: string;
  allow_bonus: string;
  status: string;
  created_at: Date;
};

const MATERIAL_SELECT = `
  SELECT m.id, m.name, m.craft_types AS "craftTypes", m.stock_unit AS "stockUnit",
         m.default_color_hex AS "defaultColorHex",
         (m.archived_at IS NOT NULL) AS archived,
         coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0)::text AS "remainingQuantity"
    FROM materials m LEFT JOIN batches b ON b.material_id = m.id`;

function toEngineRules(row: RuleRow): EngineRules {
  return {
    requireSameCraft: row.require_same_craft,
    requireUnitCompatibility: row.require_unit_compatibility,
    requireInStock: row.require_in_stock,
    includeArchived: row.include_archived,
    maxColorDistance: row.max_color_distance === null ? null : Number(row.max_color_distance),
    craftWeight: Number(row.craft_weight),
    colorWeight: Number(row.color_weight),
    unitWeight: Number(row.unit_weight),
    stockWeight: Number(row.stock_weight),
    allowBonus: Number(row.allow_bonus)
  };
}

async function loadActiveRules(client: Pick<DbClient, "query">): Promise<RuleRow | null> {
  const result = await client.query<RuleRow>(
    `SELECT * FROM substitution_rule_sets WHERE status = 'ACTIVE' LIMIT 1`
  );
  return result.rows[0] ?? null;
}

async function loadMaterial(client: Pick<DbClient, "query">, materialId: string): Promise<EngineMaterial> {
  const result = await client.query<EngineMaterial>(`${MATERIAL_SELECT} WHERE m.id = $1 GROUP BY m.id`, [materialId]);
  if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "材料不存在");
  return result.rows[0];
}

async function loadCandidates(client: Pick<DbClient, "query">, includeArchived: boolean): Promise<EngineMaterial[]> {
  const result = await client.query<EngineMaterial>(
    `${MATERIAL_SELECT}
     ${includeArchived ? "" : "WHERE m.archived_at IS NULL"}
     GROUP BY m.id`,
    []
  );
  return result.rows;
}

async function loadCompatibility(client: Pick<DbClient, "query">, sourceMaterialId: string): Promise<CompatibilityEntry[]> {
  const result = await client.query<{ candidate_material_id: string; decision: CompatibilityDecisionValue; note: string | null }>(
    `SELECT candidate_material_id, decision, note FROM material_compatibility WHERE source_material_id = $1`,
    [sourceMaterialId]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_material_id,
    decision: row.decision,
    note: row.note
  }));
}

async function loadExisting(client: Pick<DbClient, "query">, sourceMaterialId: string): Promise<ExistingRecommendation[]> {
  const result = await client.query<{ id: string; candidate_material_id: string; locked: boolean }>(
    `SELECT id, candidate_material_id, locked FROM substitution_recommendations
      WHERE source_material_id = $1 FOR UPDATE`,
    [sourceMaterialId]
  );
  return result.rows.map((row) => ({ id: row.id, candidateId: row.candidate_material_id, locked: row.locked }));
}

/** 单个材料的重算，必须在事务中调用；人工锁定行不会被删除或覆盖。 */
async function recalculateMaterial(
  client: DbClient,
  sourceMaterialId: string,
  actorUserId: string,
  requestId: string
): Promise<{ suggested: number; rejected: number; lockedPreserved: number; ruleVersion: number }> {
  // 锁住材料行，串行化同一材料的并发重算
  const lockedMaterial = await client.query("SELECT id FROM materials WHERE id = $1 FOR UPDATE", [sourceMaterialId]);
  if (!lockedMaterial.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");

  const activeRules = await loadActiveRules(client);
  if (!activeRules) throw new AppError(409, "NO_ACTIVE_RULE_SET", "还没有生效的替代规则，请先创建规则版本");

  const [source, candidates, compatibility, existing] = await Promise.all([
    loadMaterial(client, sourceMaterialId),
    loadCandidates(client, activeRules.include_archived),
    loadCompatibility(client, sourceMaterialId),
    loadExisting(client, sourceMaterialId)
  ]);

  const plan = planRecomputation(source, candidates, compatibility, toEngineRules(activeRules), existing);

  if (plan.toDeleteIds.length > 0) {
    await client.query(`DELETE FROM substitution_recommendations WHERE id = ANY($1::uuid[])`, [plan.toDeleteIds]);
  }
  for (const result of plan.results) {
    await client.query(
      `INSERT INTO substitution_recommendations(
         source_material_id, candidate_material_id, status, score, rank_position,
         dimensions, reasons, rule_set_id, rule_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        sourceMaterialId,
        result.candidateId,
        result.status,
        result.score,
        result.rankPosition,
        JSON.stringify(result.dimensions),
        JSON.stringify(result.reasons),
        activeRules.id,
        activeRules.version
      ]
    );
  }
  await writeAudit(client, {
    actorUserId,
    action: "RECALCULATE",
    entityType: "SUBSTITUTION_RECOMMENDATION",
    entityId: sourceMaterialId,
    afterData: {
      ruleVersion: activeRules.version,
      suggested: plan.suggestedCount,
      rejected: plan.rejectedCount,
      lockedPreserved: plan.locked.length
    },
    requestId
  });
  return {
    suggested: plan.suggestedCount,
    rejected: plan.rejectedCount,
    lockedPreserved: plan.locked.length,
    ruleVersion: activeRules.version
  };
}

export async function substitutionRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 规则版本 ----------

  app.get("/substitution-rules", async () => {
    const rows = await pool.query(
      `SELECT id, version, name, require_same_craft AS "requireSameCraft",
              require_unit_compatibility AS "requireUnitCompatibility",
              require_in_stock AS "requireInStock", include_archived AS "includeArchived",
              max_color_distance::text AS "maxColorDistance",
              craft_weight::text AS "craftWeight", color_weight::text AS "colorWeight",
              unit_weight::text AS "unitWeight", stock_weight::text AS "stockWeight",
              allow_bonus::text AS "allowBonus", status, created_at AS "createdAt",
              archived_at AS "archivedAt"
         FROM substitution_rule_sets ORDER BY version DESC`
    );
    return { data: rows.rows };
  });

  app.post("/substitution-rules", async (request, reply) => {
    const input = parseInput(substitutionRuleSetInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const previous = await client.query<{ id: string; version: number }>(
        `SELECT id, version FROM substitution_rule_sets WHERE status = 'ACTIVE' FOR UPDATE`
      );
      const maxVersion = await client.query<{ max: number | null }>(
        `SELECT max(version) AS max FROM substitution_rule_sets`
      );
      const nextVersion = (maxVersion.rows[0]?.max ?? 0) + 1;
      await client.query(`UPDATE substitution_rule_sets SET status = 'ARCHIVED', archived_at = now() WHERE status = 'ACTIVE'`);
      const result = await client.query(
        `INSERT INTO substitution_rule_sets(
           version, name, require_same_craft, require_unit_compatibility, require_in_stock,
           include_archived, max_color_distance, craft_weight, color_weight, unit_weight,
           stock_weight, allow_bonus, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, version`,
        [
          nextVersion, input.name, input.requireSameCraft, input.requireUnitCompatibility, input.requireInStock,
          input.includeArchived, input.maxColorDistance, input.craftWeight, input.colorWeight,
          input.unitWeight, input.stockWeight, input.allowBonus, user.id
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CREATE",
        entityType: "SUBSTITUTION_RULE_SET",
        entityId: result.rows[0]?.id as string,
        beforeData: previous.rows[0] ? { version: previous.rows[0].version } : null,
        afterData: { version: nextVersion, ...input },
        requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  // ---------- 材料兼容关系 ----------

  app.get<{ Params: { id: string } }>("/materials/:id/compatibility", async (request) => {
    const source = await pool.query("SELECT 1 FROM materials WHERE id = $1", [request.params.id]);
    if (!source.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");
    const rows = await pool.query(
      `SELECT mc.id, mc.candidate_material_id AS "candidateId", m.name AS "candidateName",
              m.stock_unit AS "candidateUnit", mc.decision, mc.note, mc.created_at AS "createdAt",
              mc.updated_at AS "updatedAt"
         FROM material_compatibility mc JOIN materials m ON m.id = mc.candidate_material_id
        WHERE mc.source_material_id = $1
        ORDER BY mc.decision DESC, m.name`,
      [request.params.id]
    );
    return { data: rows.rows };
  });

  app.put<{ Params: { id: string; candidateId: string } }>(
    "/materials/:id/compatibility/:candidateId",
    async (request, reply) => {
      const input = parseInput(compatibilityInputSchema, request.body);
      const user = (request as AuthenticatedRequest).authUser;
      if (request.params.id === request.params.candidateId) {
        throw new AppError(422, "SELF_COMPATIBILITY", "不能为材料自身设置兼容关系");
      }
      const saved = await withTransaction(async (client) => {
        const materials = await client.query("SELECT id FROM materials WHERE id = ANY($1::uuid[])", [
          [request.params.id, request.params.candidateId]
        ]);
        if (materials.rowCount !== 2) throw new AppError(404, "NOT_FOUND", "材料或候选材料不存在");
        const before = await client.query(
          "SELECT * FROM material_compatibility WHERE source_material_id = $1 AND candidate_material_id = $2",
          [request.params.id, request.params.candidateId]
        );
        const result = await client.query(
          `INSERT INTO material_compatibility(source_material_id, candidate_material_id, decision, note, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (source_material_id, candidate_material_id)
           DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note
           RETURNING *`,
          [request.params.id, request.params.candidateId, input.decision, input.note ?? null, user.id]
        );
        await writeAudit(client, {
          actorUserId: user.id,
          action: before.rowCount ? "UPDATE" : "CREATE",
          entityType: "MATERIAL_COMPATIBILITY",
          entityId: result.rows[0]?.id as string,
          beforeData: before.rows[0] ?? null,
          afterData: result.rows[0],
          requestId: request.id
        });
        return result.rows[0];
      });
      return reply.status(200).send({ data: saved });
    }
  );

  app.delete<{ Params: { id: string; candidateId: string } }>(
    "/materials/:id/compatibility/:candidateId",
    async (request, reply) => {
      const user = (request as AuthenticatedRequest).authUser;
      await withTransaction(async (client) => {
        const before = await client.query(
          `SELECT * FROM material_compatibility WHERE source_material_id = $1 AND candidate_material_id = $2`,
          [request.params.id, request.params.candidateId]
        );
        if (!before.rowCount) throw new AppError(404, "NOT_FOUND", "兼容关系不存在");
        await client.query(
          `DELETE FROM material_compatibility WHERE source_material_id = $1 AND candidate_material_id = $2`,
          [request.params.id, request.params.candidateId]
        );
        await writeAudit(client, {
          actorUserId: user.id,
          action: "DELETE",
          entityType: "MATERIAL_COMPATIBILITY",
          entityId: before.rows[0]?.id as string,
          beforeData: before.rows[0],
          requestId: request.id
        });
      });
      return reply.status(204).send();
    }
  );

  // ---------- 推荐结果 ----------

  app.get<{ Params: { id: string } }>("/materials/:id/substitutions", async (request) => {
    const source = await pool.query("SELECT id, name FROM materials WHERE id = $1", [request.params.id]);
    if (!source.rows[0]) throw new AppError(404, "NOT_FOUND", "材料不存在");
    const [activeRules, rows, computed] = await Promise.all([
      loadActiveRules(pool),
      pool.query(
        `SELECT r.id, r.candidate_material_id AS "candidateId", m.name AS "candidateName",
                m.craft_types AS "candidateCraftTypes", m.stock_unit AS "candidateUnit",
                m.default_color_hex AS "candidateColorHex",
                m.archived_at IS NOT NULL AS "candidateArchived",
                stat.remaining_quantity::text AS "candidateRemainingQuantity",
                r.status, r.score::text AS score, r.rank_position AS "rankPosition",
                r.dimensions, r.reasons, r.rule_version AS "ruleVersion",
                r.locked, r.locked_at AS "lockedAt", r.lock_note AS "lockNote",
                u.display_name AS "lockedByName", r.computed_at AS "computedAt"
           FROM substitution_recommendations r
           JOIN materials m ON m.id = r.candidate_material_id
           LEFT JOIN users u ON u.id = r.locked_by
           LEFT JOIN (
             SELECT material_id, sum(remaining_quantity) FILTER (WHERE status <> 'ARCHIVED') AS remaining_quantity
               FROM batches GROUP BY material_id
           ) stat ON stat.material_id = r.candidate_material_id
          WHERE r.source_material_id = $1
          ORDER BY r.locked DESC,
                   CASE r.status WHEN 'SUGGESTED' THEN 0 ELSE 1 END,
                   r.rank_position ASC NULLS LAST, m.name`,
        [request.params.id]
      ),
      pool.query<{ total: number; unlocked_version: number | null; computed_at: Date | null }>(
        `SELECT count(*)::int AS total,
                max(rule_version) FILTER (WHERE locked = false) AS unlocked_version,
                max(computed_at) AS computed_at
           FROM substitution_recommendations
          WHERE source_material_id = $1`,
        [request.params.id]
      )
    ]);
    const computedInfo = computed.rows[0];
    const unlockedVersion = computedInfo?.unlocked_version ?? null;
    return {
      data: {
        source: source.rows[0],
        activeRule: activeRules ? { id: activeRules.id, version: activeRules.version, name: activeRules.name } : null,
        computed: (computedInfo?.total ?? 0) > 0,
        computedRuleVersion: unlockedVersion,
        stale: activeRules !== null && unlockedVersion !== null && unlockedVersion < activeRules.version,
        recommendations: rows.rows
      }
    };
  });

  app.post<{ Params: { id: string } }>("/materials/:id/substitutions/recalculate", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const summary = await withTransaction((client) => recalculateMaterial(client, request.params.id, user.id, request.id));
    return { data: summary };
  });

  app.post("/substitutions/recalculate-all", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const summary = await withTransaction(async (client) => {
      const ids = await client.query<{ source_material_id: string }>(
        `SELECT DISTINCT source_material_id FROM substitution_recommendations`
      );
      const results: Array<{ sourceMaterialId: string; suggested: number; rejected: number; lockedPreserved: number }> = [];
      for (const row of ids.rows) {
        const result = await recalculateMaterial(client, row.source_material_id, user.id, request.id);
        results.push({ sourceMaterialId: row.source_material_id, ...result });
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: "RECALCULATE_ALL",
        entityType: "SUBSTITUTION_RULE_SET",
        afterData: { materials: results.length, results },
        requestId: request.id
      });
      return { materials: results.length, results };
    });
    return { data: summary };
  });

  app.post<{ Params: { id: string } }>("/substitutions/:id/lock", async (request) => {
    const input = parseInput(recommendationLockSchema, request.body ?? {});
    const user = (request as AuthenticatedRequest).authUser;
    const result = await withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM substitution_recommendations WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rowCount) throw new AppError(404, "NOT_FOUND", "推荐结果不存在");
      const updated = await client.query(
        `UPDATE substitution_recommendations
           SET locked = true,
               locked_by = COALESCE(locked_by, $2),
               locked_at = COALESCE(locked_at, now()),
               lock_note = CASE WHEN $3::varchar IS NULL THEN lock_note ELSE $3 END
         WHERE id = $1
         RETURNING id, locked, locked_at AS "lockedAt", lock_note AS "lockNote"`,
        [request.params.id, user.id, input.lockNote ?? null]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "LOCK",
        entityType: "SUBSTITUTION_RECOMMENDATION",
        entityId: request.params.id,
        beforeData: { locked: before.rows[0]?.locked, lockNote: before.rows[0]?.lock_note },
        afterData: updated.rows[0],
        requestId: request.id
      });
      return updated.rows[0];
    });
    return { data: result };
  });

  app.post<{ Params: { id: string } }>("/substitutions/:id/unlock", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const result = await withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM substitution_recommendations WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rowCount) throw new AppError(404, "NOT_FOUND", "推荐结果不存在");
      const updated = await client.query(
        `UPDATE substitution_recommendations
           SET locked = false, locked_by = NULL, locked_at = NULL, lock_note = NULL
         WHERE id = $1 AND locked = true
         RETURNING id, locked`,
        [request.params.id]
      );
      if (updated.rowCount) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "UNLOCK",
          entityType: "SUBSTITUTION_RECOMMENDATION",
          entityId: request.params.id,
          beforeData: { locked: true, lockNote: before.rows[0]?.lock_note },
          afterData: { id: request.params.id, locked: false },
          requestId: request.id
        });
      }
      return { id: request.params.id, locked: false };
    });
    return { data: result };
  });
}
