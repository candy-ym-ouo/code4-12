-- 材料替代推荐引擎
-- 1) 版本化的推荐规则：规则改版发布新版本，旧分析可按新版本重算
CREATE TABLE substitution_rule_versions (
  version integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name varchar(120) NOT NULL,
  require_craft_overlap boolean NOT NULL,
  require_color_match boolean NOT NULL,
  require_unit_family boolean NOT NULL,
  require_stock boolean NOT NULL,
  color_distance_threshold numeric(6,2) NOT NULL CHECK (color_distance_threshold >= 0 AND color_distance_threshold <= 450),
  weight_craft integer NOT NULL CHECK (weight_craft BETWEEN 0 AND 100),
  weight_color integer NOT NULL CHECK (weight_color BETWEEN 0 AND 100),
  weight_unit integer NOT NULL CHECK (weight_unit BETWEEN 0 AND 100),
  weight_compatibility integer NOT NULL CHECK (weight_compatibility BETWEEN 0 AND 100),
  weight_stock integer NOT NULL CHECK (weight_stock BETWEEN 0 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_craft + weight_color + weight_unit + weight_compatibility + weight_stock = 100)
);
CREATE UNIQUE INDEX substitution_rules_single_active_uq ON substitution_rule_versions ((is_active)) WHERE is_active;

INSERT INTO substitution_rule_versions
  (name, require_craft_overlap, require_color_match, require_unit_family, require_stock,
   color_distance_threshold, weight_craft, weight_color, weight_unit, weight_compatibility, weight_stock, notes)
VALUES
  ('初始默认规则', true, false, true, false, 60, 30, 20, 15, 25, 10,
   '工艺必须重叠且单位同量纲；颜色与库存按软分排序；综合分 = 工艺30 + 颜色20 + 单位15 + 兼容性25 + 库存10');

-- 2) 显式材料兼容性矩阵（人工维护的替代关系）
-- BIDIRECTIONAL：两个方向都生效；ONE_WAY：仅 from_material -> to_material 生效
CREATE TABLE material_compatibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_material_id uuid NOT NULL REFERENCES materials(id),
  to_material_id uuid NOT NULL REFERENCES materials(id),
  direction varchar(16) NOT NULL CHECK (direction IN ('BIDIRECTIONAL', 'ONE_WAY')),
  compatible boolean NOT NULL,
  note varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_material_id <> to_material_id)
);
-- 同一对材料（不分方向）只允许一条规则；ONE_WAY 的实际指向由 from/to 列表达
CREATE UNIQUE INDEX material_compat_pair_uq
  ON material_compatibility(least(from_material_id, to_material_id), greatest(from_material_id, to_material_id));
CREATE INDEX material_compat_from_idx ON material_compatibility(from_material_id);
CREATE INDEX material_compat_to_idx ON material_compatibility(to_material_id);

CREATE TRIGGER material_compatibility_updated_at BEFORE UPDATE ON material_compatibility
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3) 替代分析（一次“为某材料寻找替代品”的请求）
CREATE TABLE substitution_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_material_id uuid NOT NULL REFERENCES materials(id),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  project_requirement_id uuid REFERENCES project_requirements(id) ON DELETE SET NULL,
  required_quantity numeric(18,6) CHECK (required_quantity IS NULL OR required_quantity > 0),
  stock_unit stock_unit,
  rule_version integer NOT NULL REFERENCES substitution_rule_versions(version),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX substitution_analyses_target_idx ON substitution_analyses(target_material_id, created_at DESC);
CREATE INDEX substitution_analyses_project_idx ON substitution_analyses(project_id);

CREATE TRIGGER substitution_analyses_updated_at BEFORE UPDATE ON substitution_analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4) 候选结果。locked_by 非空即人工锁定：重算时不得覆盖 verdict / 分数 / 拒绝原因
CREATE TABLE substitution_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES substitution_analyses(id) ON DELETE CASCADE,
  candidate_material_id uuid NOT NULL REFERENCES materials(id),
  rank integer NOT NULL CHECK (rank > 0),
  verdict varchar(16) NOT NULL CHECK (verdict IN ('RECOMMENDED', 'REJECTED')),
  total_score integer NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  score_breakdown jsonb NOT NULL,
  rejected_codes varchar(32)[] NOT NULL DEFAULT '{}',
  available_quantity numeric(18,6),
  required_quantity_in_candidate_unit numeric(18,6),
  locked_by uuid REFERENCES users(id),
  locked_at timestamptz,
  lock_note text,
  rule_version integer NOT NULL REFERENCES substitution_rule_versions(version),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX substitution_candidates_pair_uq ON substitution_candidates(analysis_id, candidate_material_id);
CREATE INDEX substitution_candidates_analysis_idx ON substitution_candidates(analysis_id, rank);

CREATE TRIGGER substitution_candidates_updated_at BEFORE UPDATE ON substitution_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
