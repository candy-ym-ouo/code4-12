import type { FastifyInstance } from "fastify";
import {
  analysisInputSchema,
  compatibilityInputSchema,
  compatibilityPatchSchema,
  convertQuantity,
  quantitiesAreCompatible,
  substitutionRuleInputSchema,
  type StockUnit,
  type SubstitutionRejectCode
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { rejectReasonMessages } from "../lib/substitutionEngine.js";
import { getActiveRule, loadTargetMaterial, persistEvaluations } from "../lib/substitutionStore.js";

type Query = Record<string, string | undefined>;

function ruleFromRow(row: Record<string, unknown>) {
  return {
    version: row.version,
    name: row.name,
    requireCraftOverlap: row.requireCraftOverlap,
    requireColorMatch: row.requireColorMatch,
    requireUnitFamily: row.requireUnitFamily,
    requireStock: row.requireStock,
    colorDistanceThreshold: Number(row.colorDistanceThreshold),
    weightCraft: row.weightCraft,
    weightColor: row.weightColor,
    weightUnit: row.weightUnit,
    weightCompatibility: row.weightCompatibility,
    weightStock: row.weightStock,
    notes: row.notes,
    isActive: row.isActive,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt
  };
}

export async function substitutionRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 规则版本 ----------

  app.get("/substitution/rules", async () => {
    const result = await pool.query(
      `SELECT version, name, require_craft_overlap AS "requireCraftOverlap",
              require_color_match AS "requireColorMatch", require_unit_family AS "requireUnitFamily",
              require_stock AS "requireStock", color_distance_threshold::text AS "colorDistanceThreshold",
              weight_craft AS "weightCraft", weight_color AS "weightColor", weight_unit AS "weightUnit",
              weight_compatibility AS "weightCompatibility", weight_stock AS "weightStock",
              is_active AS "isActive", notes, created_at AS "createdAt", activated_at AS "activatedAt"
         FROM substitution_rule_versions ORDER BY version DESC`
    );
    return { data: result.rows.map(ruleFromRow) };
  });

  app.get("/substitution/rules/active", async () => {
    const active = await getActiveRule(pool);
    if (!active) throw new AppError(409, "NO_ACTIVE_RULE", "当前没有启用的替代规则，请先发布");
    return { data: ruleFromRow(active as unknown as Record<string, unknown>) };
  });

  app.post("/substitution/rules", async (request, reply) => {
    const input = parseInput(substitutionRuleInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      await client.query("UPDATE substitution_rule_versions SET is_active = false WHERE is_active = true");
      const result = await client.query(
        `INSERT INTO substitution_rule_versions
           (name, require_craft_overlap, require_color_match, require_unit_family, require_stock,
            color_distance_threshold, weight_craft, weight_color, weight_unit, weight_compatibility,
            weight_stock, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING version`,
        [
          input.name, input.requireCraftOverlap, input.requireColorMatch, input.requireUnitFamily,
          input.requireStock, input.colorDistanceThreshold, input.weightCraft, input.weightColor,
          input.weightUnit, input.weightCompatibility, input.weightStock, input.notes || null, user.id
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "PUBLISH_RULE", entityType: "SUBSTITUTION_RULE",
        entityId: null, afterData: { version: result.rows[0]?.version, ...input }, requestId: request.id
      });
      const row = await client.query(
        `SELECT version, name, require_craft_overlap AS "requireCraftOverlap",
                require_color_match AS "requireColorMatch", require_unit_family AS "requireUnitFamily",
                require_stock AS "requireStock", color_distance_threshold::text AS "colorDistanceThreshold",
                weight_craft AS "weightCraft", weight_color AS "weightColor", weight_unit AS "weightUnit",
                weight_compatibility AS "weightCompatibility", weight_stock AS "weightStock",
                is_active AS "isActive", notes, created_at AS "createdAt", activated_at AS "activatedAt"
           FROM substitution_rule_versions WHERE version = $1`,
        [result.rows[0]?.version]
      );
      return row.rows[0];
    });
    return reply.status(201).send({ data: ruleFromRow(created as Record<string, unknown>) });
  });

  app.post<{ Params: { version: string } }>("/substitution/rules/:version/activate", async (request) => {
    const version = Number(request.params.version);
    if (!Number.isInteger(version) || version <= 0) throw new AppError(422, "INVALID_RULE_VERSION", "规则版本号无效");
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const existing = await client.query("SELECT 1 FROM substitution_rule_versions WHERE version = $1", [version]);
      if (!existing.rowCount) throw new AppError(404, "NOT_FOUND", "规则版本不存在");
      await client.query("UPDATE substitution_rule_versions SET is_active = false WHERE is_active = true");
      await client.query(
        "UPDATE substitution_rule_versions SET is_active = true, activated_at = now() WHERE version = $1",
        [version]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "ACTIVATE_RULE", entityType: "SUBSTITUTION_RULE",
        entityId: null, afterData: { version }, requestId: request.id
      });
      return { data: { version } };
    });
  });

  // ---------- 材料兼容性矩阵 ----------

  app.get<{ Params: { id: string } }>("/materials/:id/compatibility", async (request) => {
    const result = await pool.query(
      `SELECT c.id, c.from_material_id AS "fromMaterialId", fm.name AS "fromMaterialName",
              c.to_material_id AS "toMaterialId", tm.name AS "toMaterialName",
              c.direction, c.compatible, c.note, c.updated_at AS "updatedAt"
         FROM material_compatibility c
         JOIN materials fm ON fm.id = c.from_material_id
         JOIN materials tm ON tm.id = c.to_material_id
        WHERE c.from_material_id = $1 OR c.to_material_id = $1
        ORDER BY c.updated_at DESC`,
      [request.params.id]
    );
    return { data: result.rows };
  });

  app.post<{ Params: { id: string } }>("/materials/:id/compatibility", async (request, reply) => {
    const input = parseInput(compatibilityInputSchema, request.body);
    if (input.otherMaterialId === request.params.id) {
      throw new AppError(422, "SELF_COMPATIBILITY", "不能为材料与自己建立兼容关系");
    }
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const materials = await client.query(
        "SELECT id FROM materials WHERE id = ANY($1::uuid[]) AND archived_at IS NULL",
        [[request.params.id, input.otherMaterialId]]
      );
      if (materials.rowCount !== 2) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");
      const result = await client.query(
        `INSERT INTO material_compatibility(from_material_id, to_material_id, direction, compatible, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, from_material_id AS "fromMaterialId", to_material_id AS "toMaterialId",
                   direction, compatible, note, updated_at AS "updatedAt"`,
        [request.params.id, input.otherMaterialId, input.direction, input.compatible, input.note || null]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "MATERIAL_COMPATIBILITY",
        entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string; ruleId: string } }>(
    "/materials/:id/compatibility/:ruleId",
    async (request) => {
      const input = parseInput(compatibilityPatchSchema, request.body);
      const user = (request as AuthenticatedRequest).authUser;
      return withTransaction(async (client) => {
        const before = await client.query(
          "SELECT * FROM material_compatibility WHERE id = $1 FOR UPDATE",
          [request.params.ruleId]
        );
        const old = before.rows[0];
        if (!old) throw new AppError(404, "NOT_FOUND", "兼容规则不存在");
        if (old.from_material_id !== request.params.id && old.to_material_id !== request.params.id) {
          throw new AppError(404, "NOT_FOUND", "兼容规则不属于该材料");
        }
        const result = await client.query(
          `UPDATE material_compatibility SET
             compatible = $1,
             direction = coalesce($2, direction),
             note = CASE WHEN $3::boolean THEN $4 ELSE note END
            WHERE id = $5
            RETURNING id, from_material_id AS "fromMaterialId", to_material_id AS "toMaterialId",
                      direction, compatible, note, updated_at AS "updatedAt"`,
          [input.compatible, input.direction ?? null, "note" in input, input.note ?? null, request.params.ruleId]
        );
        await writeAudit(client, {
          actorUserId: user.id, action: "UPDATE", entityType: "MATERIAL_COMPATIBILITY",
          entityId: request.params.ruleId, beforeData: old, afterData: result.rows[0], requestId: request.id
        });
        return { data: result.rows[0] };
      });
    }
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/materials/:id/compatibility/:ruleId",
    async (request, reply) => {
      const user = (request as AuthenticatedRequest).authUser;
      await withTransaction(async (client) => {
        const result = await client.query(
          "DELETE FROM material_compatibility WHERE id = $1 AND ($2 = from_material_id OR $2 = to_material_id) RETURNING *",
          [request.params.ruleId, request.params.id]
        );
        if (!result.rowCount) throw new AppError(404, "NOT_FOUND", "兼容规则不存在");
        await writeAudit(client, {
          actorUserId: user.id, action: "DELETE", entityType: "MATERIAL_COMPATIBILITY",
          entityId: request.params.ruleId, beforeData: result.rows[0], requestId: request.id
        });
      });
      return reply.status(204).send();
    }
  );

  // ---------- 替代分析 ----------

  app.get<{ Querystring: Query }>("/substitution/analyses", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.materialId) {
      values.push(request.query.materialId);
      conditions.push(`a.target_material_id = $${values.length}::uuid`);
    }
    if (request.query.projectId) {
      values.push(request.query.projectId);
      conditions.push(`a.project_id = $${values.length}::uuid`);
    }
    const where = conditions.length ? conditions.join(" AND ") : "1 = 1";
    const total = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM substitution_analyses a WHERE ${where}`,
      values
    );
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT a.id, a.target_material_id AS "targetMaterialId", m.name AS "targetMaterialName",
              m.code AS "targetMaterialCode", m.stock_unit AS "targetStockUnit",
              a.required_quantity::text AS "requiredQuantity", a.stock_unit AS "stockUnit",
              a.project_id AS "projectId", a.project_requirement_id AS "projectRequirementId",
              a.rule_version AS "ruleVersion", a.notes, a.created_at AS "createdAt",
              (SELECT count(*)::int FROM substitution_candidates c WHERE c.analysis_id = a.id AND c.verdict = 'RECOMMENDED') AS "recommendedCount",
              (SELECT count(*)::int FROM substitution_candidates c WHERE c.analysis_id = a.id AND c.verdict = 'REJECTED') AS "rejectedCount",
              (SELECT count(*)::int FROM substitution_candidates c WHERE c.analysis_id = a.id AND c.locked_by IS NOT NULL) AS "lockedCount"
         FROM substitution_analyses a JOIN materials m ON m.id = a.target_material_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.post("/substitution/analyses", async (request, reply) => {
    const input = parseInput(analysisInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const target = await loadTargetMaterial(client, input.materialId);
      if (!target) throw new AppError(422, "INVALID_MATERIAL", "目标材料不存在");

      if (input.projectId) {
        const project = await client.query("SELECT 1 FROM projects WHERE id = $1", [input.projectId]);
        if (!project.rowCount) throw new AppError(422, "INVALID_PROJECT", "项目不存在");
      }
      if (input.projectRequirementId) {
        const requirement = await client.query(
          "SELECT project_id, material_id FROM project_requirements WHERE id = $1",
          [input.projectRequirementId]
        );
        if (!requirement.rowCount) throw new AppError(422, "INVALID_REQUIREMENT", "材料需求不存在");
        if (input.projectId && requirement.rows[0]?.project_id !== input.projectId) {
          throw new AppError(422, "REQUIREMENT_PROJECT_MISMATCH", "材料需求不属于该项目");
        }
        if (requirement.rows[0]?.material_id !== input.materialId) {
          throw new AppError(422, "REQUIREMENT_MATERIAL_MISMATCH", "材料需求对应的材料与目标材料不一致");
        }
      }

      let requiredQuantity: string | null = null;
      let requiredUnit: StockUnit = target.stockUnit;
      if (input.requiredQuantity) {
        requiredUnit = input.unit ?? target.stockUnit;
        if (!quantitiesAreCompatible(requiredUnit, target.stockUnit)) {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "需求单位与目标材料的库存单位不兼容");
        }
        try {
          requiredQuantity = convertQuantity(input.requiredQuantity, requiredUnit, target.stockUnit);
        } catch {
          throw new AppError(422, "QUANTITY_PRECISION_EXCEEDED", "需求数量超出允许的小数精度");
        }
      }

      const rule = await getActiveRule(client);
      if (!rule) throw new AppError(409, "NO_ACTIVE_RULE", "当前没有启用的替代规则，请先发布");

      const analysis = await client.query(
        `INSERT INTO substitution_analyses
           (target_material_id, project_id, project_requirement_id, required_quantity, stock_unit,
            rule_version, notes)
         VALUES ($1, $2, $3, $4, $5::stock_unit, $6, $7)
         RETURNING id`,
        [
          input.materialId, input.projectId || null, input.projectRequirementId || null,
          requiredQuantity, requiredUnit, rule.version, input.notes || null
        ]
      );
      const analysisId = analysis.rows[0]?.id as string;

      await persistEvaluations(client, {
        analysisId,
        target: {
          material: target,
          requiredQuantity: requiredQuantity ?? undefined
        },
        rule
      });

      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "SUBSTITUTION_ANALYSIS",
        entityId: analysisId, afterData: { targetMaterialId: input.materialId, ruleVersion: rule.version },
        requestId: request.id
      });
      return { id: analysisId, ruleVersion: rule.version };
    });
    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>("/substitution/analyses/:id", async (request) => {
    const analysis = await pool.query(
      `SELECT a.id, a.target_material_id AS "targetMaterialId", m.name AS "targetMaterialName",
              m.code AS "targetMaterialCode", m.stock_unit AS "targetStockUnit",
              a.required_quantity::text AS "requiredQuantity", a.stock_unit AS "stockUnit",
              a.project_id AS "projectId", a.project_requirement_id AS "projectRequirementId",
              a.rule_version AS "ruleVersion", a.notes, a.created_at AS "createdAt",
              a.updated_at AS "updatedAt"
         FROM substitution_analyses a JOIN materials m ON m.id = a.target_material_id
        WHERE a.id = $1`,
      [request.params.id]
    );
    if (!analysis.rows[0]) throw new AppError(404, "NOT_FOUND", "替代分析不存在");
    const candidates = await pool.query(
      `SELECT c.id, c.candidate_material_id AS "candidateMaterialId", m.name AS "candidateMaterialName",
              m.code AS "candidateMaterialCode", m.stock_unit AS "candidateStockUnit",
              m.craft_types AS "candidateCraftTypes", m.archived_at AS "candidateArchivedAt",
              c.rank, c.verdict, c.total_score AS "totalScore", c.score_breakdown AS "scoreBreakdown",
              c.rejected_codes AS "rejectedCodes",
              c.available_quantity::text AS "availableQuantity",
              c.required_quantity_in_candidate_unit::text AS "requiredQuantityInCandidateUnit",
              c.locked_by IS NOT NULL AS "locked", c.locked_at AS "lockedAt", c.lock_note AS "lockNote",
              u.display_name AS "lockedByName",
              c.rule_version AS "ruleVersion", c.updated_at AS "updatedAt"
         FROM substitution_candidates c
         JOIN materials m ON m.id = c.candidate_material_id
         LEFT JOIN users u ON u.id = c.locked_by
        WHERE c.analysis_id = $1
        ORDER BY (c.locked_at IS NOT NULL) DESC, c.locked_at ASC, c.rank ASC`,
      [request.params.id]
    );
    const data = {
      ...analysis.rows[0],
      candidates: candidates.rows.map((candidate) => ({
        ...candidate,
        rejectedReasons: (candidate.rejectedCodes as SubstitutionRejectCode[]).map((code) => ({
          code,
          message: rejectReasonMessages[code] ?? code
        }))
      }))
    };
    return { data };
  });

  app.post<{ Params: { id: string } }>("/substitution/analyses/:id/recompute", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query(
        `SELECT * FROM substitution_analyses WHERE id = $1 FOR UPDATE`,
        [request.params.id]
      );
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "替代分析不存在");
      const rule = await getActiveRule(client);
      if (!rule) throw new AppError(409, "NO_ACTIVE_RULE", "当前没有启用的替代规则，请先发布");
      const target = await loadTargetMaterial(client, old.target_material_id as string);
      if (!target) throw new AppError(409, "TARGET_MISSING", "目标材料已不存在");

      await persistEvaluations(client, {
        analysisId: request.params.id,
        target: {
          material: target,
          // 分析表中的 required_quantity 已按目标材料库存单位入库
          requiredQuantity: (old.required_quantity as string | null) ?? undefined
        },
        rule
      });
      await client.query(
        "UPDATE substitution_analyses SET rule_version = $1, updated_at = now() WHERE id = $2",
        [rule.version, request.params.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "RECOMPUTE", entityType: "SUBSTITUTION_ANALYSIS",
        entityId: request.params.id,
        beforeData: { ruleVersion: old.rule_version },
        afterData: { ruleVersion: rule.version },
        requestId: request.id
      });
      return { data: { ruleVersion: rule.version, previousRuleVersion: old.rule_version } };
    });
  });

  app.post<{ Params: { id: string; candidateId: string } }>(
    "/substitution/analyses/:id/candidates/:candidateId/lock",
    async (request) => {
      const user = (request as AuthenticatedRequest).authUser;
      return withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE substitution_candidates SET locked_by = $1, locked_at = now(), lock_note = $2
            WHERE id = $3 AND analysis_id = $4 AND locked_by IS NULL
           RETURNING id, candidate_material_id AS "candidateMaterialId", verdict, total_score AS "totalScore"`,
          [user.id, (request.body as { note?: string } | null)?.note?.toString().slice(0, 2000) ?? null,
           request.params.candidateId, request.params.id]
        );
        if (!result.rowCount) {
          const exists = await client.query(
            "SELECT 1 FROM substitution_candidates WHERE id = $1 AND analysis_id = $2",
            [request.params.candidateId, request.params.id]
          );
          if (!exists.rowCount) throw new AppError(404, "NOT_FOUND", "候选结果不存在");
          throw new AppError(409, "CANDIDATE_ALREADY_LOCKED", "该候选已被人工锁定");
        }
        await writeAudit(client, {
          actorUserId: user.id, action: "LOCK", entityType: "SUBSTITUTION_CANDIDATE",
          entityId: request.params.candidateId, afterData: result.rows[0], requestId: request.id
        });
        return { data: result.rows[0] };
      });
    }
  );

  app.delete<{ Params: { id: string; candidateId: string } }>(
    "/substitution/analyses/:id/candidates/:candidateId/lock",
    async (request, reply) => {
      const user = (request as AuthenticatedRequest).authUser;
      await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE substitution_candidates SET locked_by = NULL, locked_at = NULL, lock_note = NULL
            WHERE id = $1 AND analysis_id = $2 AND locked_by IS NOT NULL
           RETURNING *`,
          [request.params.candidateId, request.params.id]
        );
        if (!result.rowCount) throw new AppError(404, "NOT_FOUND", "锁定记录不存在或已解锁");
        await writeAudit(client, {
          actorUserId: user.id, action: "UNLOCK", entityType: "SUBSTITUTION_CANDIDATE",
          entityId: request.params.candidateId, beforeData: result.rows[0], requestId: request.id
        });
      });
      return reply.status(204).send();
    }
  );
}
