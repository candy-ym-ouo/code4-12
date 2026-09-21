export type ApiMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Material = {
  id: string;
  code: string | null;
  name: string;
  craftTypes: string[];
  subtype: string | null;
  stockUnit: string;
  lowStockThreshold: string | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  tags: string[];
  notes: string | null;
  remainingQuantity: string;
  batchCount: number;
  stockState: string;
  archivedAt: string | null;
  updatedAt: string;
  version: number;
};

export type Batch = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  initialQuantity: string;
  remainingQuantity: string;
  stockUnit: string;
  currentColorName: string | null;
  currentColorHex: string | null;
  status: string;
  notes: string | null;
  version: number;
  updatedAt: string;
};

export type Source = {
  id: string;
  name: string;
  type: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: string | null;
  batchCount: number;
  activeBatchCount: number;
};

export type Location = {
  id: string;
  name: string;
  parentId: string | null;
  notes: string | null;
  batchCount: number;
  archivedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  craftType: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  description: string | null;
  targetColorName: string | null;
  targetColorHex: string | null;
  tags: string[];
  requirementCount: number;
  consumptionCount: number;
  version: number;
  updatedAt: string;
};

export type Consumption = {
  id: string;
  projectId: string;
  projectName: string;
  projectRequirementId: string | null;
  batchId: string;
  batchCode: string | null;
  materialId: string;
  materialName: string;
  sourceName: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  stockUnit: string;
  consumedAt: string;
  purpose: string | null;
  notes: string | null;
  status: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

export const craftTypeLabels: Record<string, string> = {
  DYEING: "染布",
  WOODWORKING: "木工",
  POTTERY: "陶艺",
  METALWORKING: "金工",
  GENERAL: "通用",
  OTHER: "其他"
};

export const statusLabels: Record<string, string> = {
  ACTIVE: "有库存",
  DEPLETED: "已耗尽",
  ARCHIVED: "已归档",
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  REVERSED: "已撤销"
};

export const movementLabels: Record<string, string> = {
  OPENING: "初始入库",
  PURCHASE: "采购入库",
  CONSUMPTION: "材料消耗",
  ADJUSTMENT_IN: "盘增",
  ADJUSTMENT_OUT: "盘减",
  REVERSAL: "撤销恢复"
};

export const substitutionRejectLabels: Record<string, string> = {
  CRAFT_MISMATCH: "工艺不匹配",
  COLOR_MISMATCH: "颜色不匹配",
  UNIT_INCOMPATIBLE: "单位量纲不兼容",
  COMPATIBILITY_EXCLUDED: "兼容性矩阵禁止替代",
  INSUFFICIENT_STOCK: "库存不足",
  CANDIDATE_ARCHIVED: "候选已归档"
};

export const dimensionLabels: Record<string, string> = {
  craft: "工艺",
  color: "颜色",
  unit: "单位",
  compatibility: "兼容性",
  stock: "库存"
};

export type SubstitutionRule = {
  version: number;
  name: string;
  requireCraftOverlap: boolean;
  requireColorMatch: boolean;
  requireUnitFamily: boolean;
  requireStock: boolean;
  colorDistanceThreshold: string;
  weightCraft: number;
  weightColor: number;
  weightUnit: number;
  weightCompatibility: number;
  weightStock: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  activatedAt: string;
};

export type SubstitutionAnalysisSummary = {
  id: string;
  targetMaterialId: string;
  targetMaterialName: string;
  targetMaterialCode: string | null;
  targetStockUnit: string;
  requiredQuantity: string | null;
  stockUnit: string | null;
  projectId: string | null;
  projectRequirementId: string | null;
  ruleVersion: number;
  notes: string | null;
  createdAt: string;
  recommendedCount: number;
  rejectedCount: number;
  lockedCount: number;
};

export type DimensionScore = {
  score: number;
  level: string;
  detail: string;
};

export type SubstitutionCandidate = {
  id: string;
  candidateMaterialId: string;
  candidateMaterialName: string;
  candidateMaterialCode: string | null;
  candidateStockUnit: string;
  candidateCraftTypes: string[];
  candidateArchivedAt: string | null;
  rank: number;
  verdict: "RECOMMENDED" | "REJECTED";
  totalScore: number;
  scoreBreakdown: Record<"craft" | "color" | "unit" | "compatibility" | "stock", DimensionScore>;
  rejectedCodes: string[];
  rejectedReasons: { code: string; message: string }[];
  availableQuantity: string;
  requiredQuantityInCandidateUnit: string | null;
  locked: boolean;
  lockedAt: string | null;
  lockNote: string | null;
  lockedByName: string | null;
  ruleVersion: number;
  updatedAt: string;
};

export type SubstitutionAnalysisDetail = SubstitutionAnalysisSummary & {
  updatedAt: string;
  candidates: SubstitutionCandidate[];
};

export type CompatibilityRule = {
  id: string;
  fromMaterialId: string;
  fromMaterialName: string;
  toMaterialId: string;
  toMaterialName: string;
  direction: "BIDIRECTIONAL" | "ONE_WAY";
  compatible: boolean;
  note: string | null;
  updatedAt: string;
};
