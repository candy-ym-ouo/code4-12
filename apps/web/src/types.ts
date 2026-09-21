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

export type SubstitutionRuleSet = {
  id: string;
  version: number;
  name: string;
  requireSameCraft: boolean;
  requireUnitCompatibility: boolean;
  requireInStock: boolean;
  includeArchived: boolean;
  maxColorDistance: string | null;
  craftWeight: string;
  colorWeight: string;
  unitWeight: string;
  stockWeight: string;
  allowBonus: string;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  archivedAt: string | null;
};

export type RecommendationReason = {
  code: string;
  message: string;
};

export type RecommendationDimensions = {
  craft: { score: number; sharedCrafts: string[] };
  color: { score: number | null; distance: number | null };
  unit: { score: number; compatible: boolean; exactMatch: boolean; sourceUnit: string; candidateUnit: string };
  stock: { score: number | null; convertedQuantity: number | null; referenceQuantity: number | null };
  compatibility: { decision: "ALLOWED" | "BLOCKED" | null; bonusApplied: number };
};

export type Recommendation = {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateCraftTypes: string[];
  candidateUnit: string;
  candidateColorHex: string | null;
  candidateArchived: boolean;
  candidateRemainingQuantity: string | null;
  status: "SUGGESTED" | "REJECTED";
  score: string | null;
  rankPosition: number | null;
  dimensions: RecommendationDimensions;
  reasons: RecommendationReason[];
  ruleVersion: number;
  locked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  lockNote: string | null;
  computedAt: string;
};

export const recommendationReasonLabels: Record<string, string> = {
  CRAFT_MISMATCH: "工艺不符",
  UNIT_INCOMPATIBLE: "单位不兼容",
  NO_STOCK: "无可用库存",
  CANDIDATE_ARCHIVED: "候选已归档",
  COLOR_DISTANCE_EXCEEDED: "色差超阈值",
  COMPATIBILITY_BLOCKED: "兼容规则禁止",
  COMPATIBILITY_ALLOWED: "兼容规则允许"
};

export type CompatibilityLink = {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateUnit: string;
  decision: "ALLOWED" | "BLOCKED";
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
