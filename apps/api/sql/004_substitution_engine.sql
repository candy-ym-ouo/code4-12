-- 材料替代推荐引擎：版本化规则集、材料兼容关系、推荐结果与人工锁定

CREATE TYPE compatibility_decision AS ENUM ('ALLOWED', 'BLOCKED');
CREATE TYPE substitution_rule_set_status AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE recommendation_status AS ENUM ('SUGGESTED', 'REJECTED');

CREATE TABLE substitution_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL,
  name varchar(120) NOT NULL,
  require_same_craft boolean NOT NULL,
  require_unit_compatibility boolean NOT NULL,
  require_in_stock boolean NOT NULL,
  include_archived boolean NOT NULL,
  max_color_distance numeric(7,2) CHECK (max_color_distance IS NULL OR max_color_distance >= 0),
  craft_weight numeric(6,3) NOT NULL CHECK (craft_weight BETWEEN 0 AND 1),
  color_weight numeric(6,3) NOT NULL CHECK (color_weight BETWEEN 0 AND 1),
  unit_weight numeric(6,3) NOT NULL CHECK (unit_weight BETWEEN 0 AND 1),
  stock_weight numeric(6,3) NOT NULL CHECK (stock_weight BETWEEN 0 AND 1),
  allow_bonus numeric(5,3) NOT NULL CHECK (allow_bonus BETWEEN 0 AND 0.5),
  CHECK (craft_weight + color_weight + unit_weight + stock_weight > 0),
  status substitution_rule_set_status NOT NULL DEFAULT 'ACTIVE',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX substitution_rules_version_uq ON substitution_rule_sets(version);
-- 任意时刻只允许一个生效规则版本
CREATE UNIQUE INDEX substitution_rules_single_active_uq ON substitution_rule_sets ((true)) WHERE status = 'ACTIVE';

-- 种子一条默认规则（created_by 为空表示系统默认配置，不属于业务数据）
INSERT INTO substitution_rule_sets(
  version, name, require_same_craft, require_unit_compatibility, require_in_stock,
  include_archived, max_color_distance, craft_weight, color_weight, unit_weight, stock_weight, allow_bonus
) VALUES (1, '默认规则', true, true, false, false, NULL, 0.350, 0.250, 0.200, 0.200, 0.100);

CREATE TABLE material_compatibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_material_id uuid NOT NULL REFERENCES materials(id),
  candidate_material_id uuid NOT NULL REFERENCES materials(id),
  decision compatibility_decision NOT NULL,
  note varchar(500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_material_id <> candidate_material_id),
  UNIQUE (source_material_id, candidate_material_id)
);
CREATE INDEX material_compatibility_source_idx ON material_compatibility(source_material_id);

CREATE TABLE substitution_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_material_id uuid NOT NULL REFERENCES materials(id),
  candidate_material_id uuid NOT NULL REFERENCES materials(id),
  status recommendation_status NOT NULL,
  score numeric(7,4) CHECK (score IS NULL OR (score BETWEEN 0 AND 1)),
  rank_position integer CHECK (rank_position IS NULL OR rank_position > 0),
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_set_id uuid NOT NULL REFERENCES substitution_rule_sets(id),
  rule_version integer NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  locked_by uuid REFERENCES users(id),
  locked_at timestamptz,
  lock_note varchar(500),
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_material_id <> candidate_material_id),
  CHECK ((status = 'SUGGESTED') = (score IS NOT NULL)),
  CHECK ((status = 'SUGGESTED') = (rank_position IS NOT NULL)),
  CHECK (locked = (locked_at IS NOT NULL)),
  CHECK (locked = (locked_by IS NOT NULL)),
  UNIQUE (source_material_id, candidate_material_id)
);
CREATE INDEX substitution_recommendations_source_rank_idx
  ON substitution_recommendations(source_material_id, status, rank_position);
CREATE INDEX substitution_recommendations_locked_idx
  ON substitution_recommendations(source_material_id) WHERE locked = true;

CREATE TRIGGER material_compatibility_updated_at BEFORE UPDATE ON material_compatibility
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER substitution_recommendations_updated_at BEFORE UPDATE ON substitution_recommendations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
