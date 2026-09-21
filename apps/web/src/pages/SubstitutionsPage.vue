<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Lock, Refresh, Switch } from "@element-plus/icons-vue";
import { request, ApiError } from "@/lib/api";
import {
  craftTypeLabels,
  recommendationReasonLabels,
  type CompatibilityLink,
  type Material,
  type Recommendation,
  type SubstitutionRuleSet
} from "@/types";

const activeTab = ref("recommendations");
const route = useRoute();
const materials = ref<Material[]>([]);
const selectedMaterialId = ref("");

const recommendations = ref<Recommendation[]>([]);
const activeRuleVersion = ref<number | null>(null);
const computedRuleVersion = ref<number | null>(null);
const hasComputed = ref(false);
const stale = ref(false);
const loading = ref(false);
const working = ref(false);

const ruleSets = ref<SubstitutionRuleSet[]>([]);
const compatibilityLinks = ref<CompatibilityLink[]>([]);

const selectedMaterial = computed(() => materials.value.find((material) => material.id === selectedMaterialId.value) ?? null);
const suggested = computed(() => recommendations.value.filter((row) => row.status === "SUGGESTED"));
const rejected = computed(() => recommendations.value.filter((row) => row.status === "REJECTED"));
const activeRule = computed(() => ruleSets.value.find((rule) => rule.status === "ACTIVE") ?? null);

async function loadMaterials() {
  const response = await request<{ data: Material[] }>("/materials?pageSize=100");
  materials.value = response.data;
}

async function loadRecommendations() {
  if (!selectedMaterialId.value) return;
  loading.value = true;
  try {
    const response = await request<{
      data: {
        activeRule: { version: number } | null;
        computed: boolean;
        computedRuleVersion: number | null;
        stale: boolean;
        recommendations: Recommendation[];
      };
    }>(`/materials/${selectedMaterialId.value}/substitutions`);
    recommendations.value = response.data.recommendations;
    activeRuleVersion.value = response.data.activeRule?.version ?? null;
    computedRuleVersion.value = response.data.computedRuleVersion;
    hasComputed.value = response.data.computed;
    stale.value = response.data.stale;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "推荐结果加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadRules() {
  const response = await request<{ data: SubstitutionRuleSet[] }>("/substitution-rules");
  ruleSets.value = response.data;
}

async function loadCompatibility() {
  if (!selectedMaterialId.value) return;
  const response = await request<{ data: CompatibilityLink[] }>(`/materials/${selectedMaterialId.value}/compatibility`);
  compatibilityLinks.value = response.data;
}

async function onMaterialChange() {
  recommendations.value = [];
  hasComputed.value = false;
  await Promise.all([loadRecommendations(), loadCompatibility()]);
}

async function recalculate() {
  if (!selectedMaterialId.value) return;
  working.value = true;
  try {
    const response = await request<{ data: { suggested: number; rejected: number; lockedPreserved: number; ruleVersion: number } }>(
      `/materials/${selectedMaterialId.value}/substitutions/recalculate`,
      { method: "POST" }
    );
    ElMessage.success(
      `重算完成：推荐 ${response.data.suggested} 项、拒绝 ${response.data.rejected} 项，保留 ${response.data.lockedPreserved} 条人工锁定`
    );
    await Promise.all([loadRecommendations(), loadRules()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "重算失败");
  } finally {
    working.value = false;
  }
}

async function recalculateAll() {
  try {
    await ElMessageBox.confirm(
      "将使用当前生效规则重建所有材料的推荐结果，未锁定结果会被覆盖，人工锁定结果保持不变。确认继续？",
      "全量重算",
      { type: "warning", confirmButtonText: "全量重算", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  working.value = true;
  try {
    const response = await request<{ data: { materials: number } }>("/substitutions/recalculate-all", { method: "POST" });
    ElMessage.success(`已重算 ${response.data.materials} 个材料的推荐结果`);
    await Promise.all([loadRecommendations(), loadRules()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "全量重算失败");
  } finally {
    working.value = false;
  }
}

async function lockRow(row: Recommendation) {
  let lockNote = "";
  try {
    const result = await ElMessageBox.prompt("可填写锁定备注（例如：已由操作员确认替代方案）", `锁定 #${row.rankPosition ?? ""} ${row.candidateName}`, {
      confirmButtonText: "锁定",
      cancelButtonText: "取消",
      inputValue: row.lockNote ?? "",
      inputValidator: (value) => (value ?? "").length <= 500 || "备注最多 500 字"
    });
    lockNote = result.value ?? "";
  } catch {
    return;
  }
  try {
    await request(`/substitutions/${row.id}/lock`, { method: "POST", body: { lockNote: lockNote || null } });
    ElMessage.success("已锁定，后续重算不会覆盖该结果");
    await loadRecommendations();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "锁定失败");
  }
}

async function unlockRow(row: Recommendation) {
  try {
    await request(`/substitutions/${row.id}/unlock`, { method: "POST" });
    ElMessage.success("已解锁，下次重算将重新评估该候选");
    await loadRecommendations();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "解锁失败");
  }
}

// ---------- 兼容性管理 ----------

const compatibilityForm = ref({ candidateId: "", decision: "ALLOWED" as "ALLOWED" | "BLOCKED", note: "" });
const savingCompatibility = ref(false);
const compatibilityCandidates = computed(() =>
  materials.value.filter(
    (material) => material.id !== selectedMaterialId.value
      && !compatibilityLinks.value.some((link) => link.candidateId === material.id)
  )
);

async function saveCompatibility() {
  if (!selectedMaterialId.value || !compatibilityForm.value.candidateId) {
    ElMessage.warning("请先选择候选材料");
    return;
  }
  savingCompatibility.value = true;
  try {
    await request(
      `/materials/${selectedMaterialId.value}/compatibility/${compatibilityForm.value.candidateId}`,
      { method: "PUT", body: { decision: compatibilityForm.value.decision, note: compatibilityForm.value.note || null } }
    );
    ElMessage.success("兼容关系已保存");
    compatibilityForm.value = { candidateId: "", decision: "ALLOWED", note: "" };
    await loadCompatibility();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "保存兼容关系失败");
  } finally {
    savingCompatibility.value = false;
  }
}

async function deleteCompatibility(link: CompatibilityLink) {
  try {
    await ElMessageBox.confirm(`删除与「${link.candidateName}」的兼容关系？`, "删除兼容关系", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  try {
    await request(`/materials/${selectedMaterialId.value}/compatibility/${link.candidateId}`, { method: "DELETE" });
    ElMessage.success("已删除");
    await loadCompatibility();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "删除失败");
  }
}

// ---------- 规则版本 ----------

const ruleDialogVisible = ref(false);
const savingRule = ref(false);
const ruleForm = ref({
  name: "",
  requireSameCraft: true,
  requireUnitCompatibility: true,
  requireInStock: false,
  includeArchived: false,
  maxColorDistance: null as number | null,
  craftWeight: 0.35,
  colorWeight: 0.25,
  unitWeight: 0.2,
  stockWeight: 0.2,
  allowBonus: 0.1
});

const weightSum = computed(() =>
  Number(ruleForm.value.craftWeight) + Number(ruleForm.value.colorWeight) + Number(ruleForm.value.unitWeight) + Number(ruleForm.value.stockWeight)
);

function openRuleDialog() {
  const base = activeRule.value;
  ruleForm.value = {
    name: base ? `${base.name}（修订）` : "默认规则",
    requireSameCraft: base?.requireSameCraft ?? true,
    requireUnitCompatibility: base?.requireUnitCompatibility ?? true,
    requireInStock: base?.requireInStock ?? false,
    includeArchived: base?.includeArchived ?? false,
    maxColorDistance: base?.maxColorDistance ? Number(base.maxColorDistance) : null,
    craftWeight: Number(base?.craftWeight ?? 0.35),
    colorWeight: Number(base?.colorWeight ?? 0.25),
    unitWeight: Number(base?.unitWeight ?? 0.2),
    stockWeight: Number(base?.stockWeight ?? 0.2),
    allowBonus: Number(base?.allowBonus ?? 0.1)
  };
  ruleDialogVisible.value = true;
}

async function saveRule() {
  if (weightSum.value <= 0) {
    ElMessage.warning("四个维度权重之和必须大于 0");
    return;
  }
  savingRule.value = true;
  try {
    await request("/substitution-rules", {
      method: "POST",
      body: {
        ...ruleForm.value,
        maxColorDistance: ruleForm.value.maxColorDistance,
        craftWeight: ruleForm.value.craftWeight ?? 0,
        colorWeight: ruleForm.value.colorWeight ?? 0,
        unitWeight: ruleForm.value.unitWeight ?? 0,
        stockWeight: ruleForm.value.stockWeight ?? 0,
        allowBonus: ruleForm.value.allowBonus ?? 0
      }
    });
    ElMessage.success("新规则版本已生效，旧版本已归档；可在需要时重算推荐结果");
    ruleDialogVisible.value = false;
    await loadRules();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "创建规则版本失败");
  } finally {
    savingRule.value = false;
  }
}

function scorePercent(score: string | null): string {
  return score === null ? "—" : `${Math.round(Number(score) * 100)}%`;
}

function dimensionPercent(score: number | null): string {
  return score === null ? "—" : `${Math.round(score * 100)}%`;
}

function reasonLabel(code: string): string {
  return recommendationReasonLabels[code] ?? code;
}

onMounted(async () => {
  await Promise.all([loadMaterials(), loadRules()]);
  const queryMaterialId = typeof route.query.materialId === "string" ? route.query.materialId : "";
  if (queryMaterialId && materials.value.some((material) => material.id === queryMaterialId)) {
    selectedMaterialId.value = queryMaterialId;
    await onMaterialChange();
  }
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>材料替代推荐</h1>
        <p>按工艺、颜色、单位与库存兼容性排序；硬性条件不过的候选保留拒绝原因，人工锁定结果不会被重算覆盖。</p>
      </div>
      <el-button :icon="Refresh" @click="recalculateAll">按当前规则全量重算</el-button>
    </header>

    <section class="toolbar">
      <el-form :inline="true">
        <el-form-item label="被替代材料">
          <el-select
            v-model="selectedMaterialId"
            filterable
            clearable
            placeholder="选择需要寻找替代的材料"
            style="width: 320px"
            @change="onMaterialChange"
          >
            <el-option v-for="material in materials" :key="material.id" :label="`${material.name}（${material.stockUnit}）`" :value="material.id">
              <span>{{ material.name }}</span>
              <span class="muted" style="float: right">{{ material.stockUnit }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item v-if="activeRuleVersion !== null">
          <el-tag type="info">当前生效规则 v{{ activeRuleVersion }}</el-tag>
          <el-tag v-if="computedRuleVersion !== null && computedRuleVersion !== activeRuleVersion" type="warning" style="margin-left: 8px">
            结果基于 v{{ computedRuleVersion }}，规则已改版
          </el-tag>
        </el-form-item>
      </el-form>
    </section>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="推荐结果" name="recommendations">
        <section v-if="!selectedMaterialId" class="panel empty-card muted">请先选择被替代材料。</section>
        <template v-else>
          <section class="panel">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
              <div>
        <strong>{{ selectedMaterial?.name }}</strong>
                <span class="muted"> · {{ selectedMaterial?.stockUnit }} · 剩余 {{ selectedMaterial?.remainingQuantity }}</span>
                <el-alert
                  v-if="stale"
                  title="规则已改版：点击重算更新未锁定结果，人工锁定项不受影响"
                  type="warning"
                  :closable="false"
                  show-icon
                  style="margin-top: 10px"
                />
                <div v-else-if="!hasComputed" class="muted" style="margin-top: 8px">尚未计算过替代推荐。</div>
              </div>
              <el-button type="primary" :icon="Switch" :loading="working" @click="recalculate">
                {{ hasComputed ? "重新计算" : "开始计算" }}
              </el-button>
            </div>
          </section>

          <section v-loading="loading">
            <div v-if="hasComputed && suggested.length === 0 && rejected.length === 0" class="panel empty-card muted">
              没有候选材料（其他材料均已归档或被锁定规则排除）。
            </div>

            <section v-if="suggested.length > 0" class="panel">
              <h3>推荐替代（{{ suggested.length }}）</h3>
              <el-table :data="suggested">
                <el-table-column label="排名" width="64">
                  <template #default="{ row }">
                    <el-tag round>{{ row.rankPosition }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="候选材料" min-width="170">
                  <template #default="{ row }">
                    <router-link :to="`/materials/${row.candidateId}`"><strong>{{ row.candidateName }}</strong></router-link>
                    <div class="muted">
                      <span v-if="row.candidateColorHex" class="color-dot" :style="{ background: row.candidateColorHex }" />
                      {{ row.candidateUnit }} · 剩余 {{ row.candidateRemainingQuantity ?? "0" }}
                      <el-tag v-if="row.candidateArchived" size="small" type="info" style="margin-left: 4px">已归档</el-tag>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="工艺" min-width="140">
                  <template #default="{ row }">
                    <el-tag
                      v-for="craft in row.candidateCraftTypes"
                      :key="craft"
                      size="small"
                      :type="row.dimensions.craft.sharedCrafts.includes(craft) ? 'success' : 'info'"
                      style="margin: 2px"
                    >{{ craftTypeLabels[craft] ?? craft }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="评分维度" width="250">
                  <template #default="{ row }">
                    <div class="dim-grid">
                      <span>工艺 <b>{{ dimensionPercent(row.dimensions.craft.score) }}</b></span>
                      <span>颜色 <b>{{ dimensionPercent(row.dimensions.color.score) }}</b></span>
                      <span>单位 <b>{{ dimensionPercent(row.dimensions.unit.score) }}</b></span>
                      <span>库存 <b>{{ dimensionPercent(row.dimensions.stock.score) }}</b></span>
                    </div>
                    <el-tooltip v-if="row.dimensions.color.distance !== null" placement="top">
                      <template #content>色差值 {{ row.dimensions.color.distance }}</template>
                      <span class="muted" style="font-size: 12px">色差 {{ row.dimensions.color.distance }}</span>
                    </el-tooltip>
                    <el-tag v-if="row.dimensions.compatibility.decision === 'ALLOWED'" size="small" type="success" style="margin-left: 6px">兼容允许 +{{ Math.round(row.dimensions.compatibility.bonusApplied * 100) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="总分" width="110">
                  <template #default="{ row }">
                    <strong style="font-size: 16px">{{ scorePercent(row.score) }}</strong>
                    <div class="muted" style="font-size: 12px">规则 v{{ row.ruleVersion }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="锁定" width="180">
                  <template #default="{ row }">
                    <template v-if="row.locked">
                      <el-tag type="warning" :icon="Lock">已锁定</el-tag>
                      <div class="muted" style="font-size: 12px; margin-top: 2px">{{ row.lockedByName }} · {{ row.lockNote || "无备注" }}</div>
                      <el-button link type="danger" size="small" @click="unlockRow(row)">解锁</el-button>
                    </template>
                    <el-button v-else link type="warning" :icon="Lock" @click="lockRow(row)">锁定结果</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </section>

            <section v-if="rejected.length > 0" class="panel">
              <h3>不符合条件（{{ rejected.length }}）</h3>
              <p class="muted">以下候选未通过硬性规则，但仍列出拒绝原因；锁定后同样会被保留。</p>
              <el-table :data="rejected">
                <el-table-column label="候选材料" min-width="170">
                  <template #default="{ row }">
                    <router-link :to="`/materials/${row.candidateId}`"><strong>{{ row.candidateName }}</strong></router-link>
                    <div class="muted">{{ row.candidateUnit }} · 剩余 {{ row.candidateRemainingQuantity ?? "0" }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="拒绝原因" min-width="280">
                  <template #default="{ row }">
                    <el-tag v-for="reason in row.reasons" :key="reason.code" type="danger" size="small" style="margin: 2px">
                      {{ reasonLabel(reason.code) }}
                    </el-tag>
                    <ul class="reason-list">
                      <li v-for="reason in row.reasons" :key="`${reason.code}-text`" class="muted">{{ reason.message }}</li>
                    </ul>
                  </template>
                </el-table-column>
                <el-table-column label="规则版本" width="100">
                  <template #default="{ row }"><span class="muted">v{{ row.ruleVersion }}</span></template>
                </el-table-column>
                <el-table-column label="锁定" width="150">
                  <template #default="{ row }">
                    <template v-if="row.locked">
                      <el-tag type="warning" :icon="Lock">已锁定</el-tag>
                      <el-button link type="danger" size="small" @click="unlockRow(row)">解锁</el-button>
                    </template>
                    <el-button v-else link type="warning" size="small" @click="lockRow(row)">仍锁定</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </section>
          </section>
        </template>
      </el-tab-pane>

      <el-tab-pane label="兼容关系" name="compatibility" :disabled="!selectedMaterialId">
        <section class="panel">
          <h3>为「{{ selectedMaterial?.name }}」设置人工兼容关系</h3>
          <p class="muted">“允许”会给候选总分加分；“禁止”是硬性拒绝，即使其他维度全部匹配也不会推荐。</p>
          <el-form :inline="true" @submit.prevent="saveCompatibility">
            <el-form-item label="候选材料">
              <el-select v-model="compatibilityForm.candidateId" filterable placeholder="选择候选材料" style="width: 260px">
                <el-option v-for="material in compatibilityCandidates" :key="material.id" :label="`${material.name}（${material.stockUnit}）`" :value="material.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="决定">
              <el-radio-group v-model="compatibilityForm.decision">
                <el-radio-button value="ALLOWED">允许替代</el-radio-button>
                <el-radio-button value="BLOCKED">禁止替代</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="compatibilityForm.note" maxlength="500" placeholder="可选，例如：老师傅确认 / 会褪色" style="width: 260px" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="savingCompatibility" @click="saveCompatibility">保存</el-button>
            </el-form-item>
          </el-form>
        </section>

        <section class="panel">
          <h3>已配置的兼容关系（{{ compatibilityLinks.length }}）</h3>
          <el-table :data="compatibilityLinks">
            <el-table-column label="候选材料" min-width="180">
              <template #default="{ row }">
                <router-link :to="`/materials/${row.candidateId}`"><strong>{{ row.candidateName }}</strong></router-link>
                <div class="muted">{{ row.candidateUnit }}</div>
              </template>
            </el-table-column>
            <el-table-column label="决定" width="140">
              <template #default="{ row }">
                <el-tag :type="row.decision === 'ALLOWED' ? 'success' : 'danger'">
                  {{ row.decision === "ALLOWED" ? "允许替代" : "禁止替代" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="备注" prop="note" min-width="220" />
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button link type="danger" @click="deleteCompatibility(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane label="评分规则" name="rules">
        <section class="panel">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <h3 style="margin: 0">规则版本（{{ ruleSets.length }}）</h3>
            <el-button type="primary" @click="openRuleDialog">改版：创建新版本</el-button>
          </div>
          <p class="muted">规则一经发布即不可修改；调整参数会生成新版本并归档旧版本，已计算的结果可随后重算。</p>
          <el-table :data="ruleSets">
            <el-table-column label="版本" width="90">
              <template #default="{ row }"><strong>v{{ row.version }}</strong></template>
            </el-table-column>
            <el-table-column label="名称" prop="name" min-width="140" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">
                  {{ row.status === "ACTIVE" ? "生效中" : "已归档" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="硬性条件" min-width="300">
              <template #default="{ row }">
                <el-tag size="small" :type="row.requireSameCraft ? 'danger' : 'info'" style="margin: 2px">必须工艺匹配</el-tag>
                <el-tag size="small" :type="row.requireUnitCompatibility ? 'danger' : 'info'" style="margin: 2px">必须单位可换算</el-tag>
                <el-tag size="small" :type="row.requireInStock ? 'danger' : 'info'" style="margin: 2px">必须有库存</el-tag>
                <el-tag size="small" :type="row.includeArchived ? 'warning' : 'info'" style="margin: 2px">含已归档</el-tag>
                <el-tag size="small" :type="row.maxColorDistance ? 'danger' : 'info'" style="margin: 2px">
                  色差 ≤ {{ row.maxColorDistance ?? "不限" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="权重（工艺/颜色/单位/库存）" min-width="230">
              <template #default="{ row }">
                {{ row.craftWeight }} / {{ row.colorWeight }} / {{ row.unitWeight }} / {{ row.stockWeight }}
                <span class="muted">；允许加分 {{ row.allowBonus }}</span>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" width="170">
              <template #default="{ row }"><span class="muted">{{ new Date(row.createdAt).toLocaleString() }}</span></template>
            </el-table-column>
          </el-table>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="ruleDialogVisible" title="创建新规则版本" width="640px">
      <el-form label-width="180px">
        <el-form-item label="版本名称">
          <el-input v-model="ruleForm.name" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="必须工艺匹配"><el-switch v-model="ruleForm.requireSameCraft" /></el-form-item>
        <el-form-item label="必须单位可换算"><el-switch v-model="ruleForm.requireUnitCompatibility" /></el-form-item>
        <el-form-item label="必须有可用库存"><el-switch v-model="ruleForm.requireInStock" /></el-form-item>
        <el-form-item label="候选可包含已归档"><el-switch v-model="ruleForm.includeArchived" /></el-form-item>
        <el-form-item label="最大允许色差">
          <el-input-number v-model="ruleForm.maxColorDistance" :min="0" :max="765" :step="10" :controls="false" placeholder="留空表示不限制" style="width: 200px" />
          <span class="muted" style="margin-left: 10px">0-765，留空不按颜色硬拒绝</span>
        </el-form-item>
        <el-form-item label="工艺权重">
          <el-input-number v-model="ruleForm.craftWeight" :min="0" :max="1" :step="0.05" style="width: 140px" />
        </el-form-item>
        <el-form-item label="颜色权重">
          <el-input-number v-model="ruleForm.colorWeight" :min="0" :max="1" :step="0.05" style="width: 140px" />
        </el-form-item>
        <el-form-item label="单位权重">
          <el-input-number v-model="ruleForm.unitWeight" :min="0" :max="1" :step="0.05" style="width: 140px" />
        </el-form-item>
        <el-form-item label="库存权重">
          <el-input-number v-model="ruleForm.stockWeight" :min="0" :max="1" :step="0.05" style="width: 140px" />
        </el-form-item>
        <el-form-item label="权重合计">
          <el-tag :type="weightSum > 0 ? 'success' : 'danger'">{{ weightSum.toFixed(2) }}</el-tag>
          <span class="muted" style="margin-left: 10px">缺失数据的维度会按可用权重自动归一化</span>
        </el-form-item>
        <el-form-item label="允许替代加分">
          <el-input-number v-model="ruleForm.allowBonus" :min="0" :max="0.5" :step="0.05" style="width: 140px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingRule" @click="saveRule">发布新版本</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.dim-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 16px;
  font-size: 13px;
  color: #75675e;
}
.dim-grid b {
  float: right;
  color: #4a3b32;
}
.reason-list {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 12px;
}
</style>
