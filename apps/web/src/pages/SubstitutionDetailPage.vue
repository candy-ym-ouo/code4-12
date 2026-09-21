<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import {
  craftTypeLabels,
  dimensionLabels,
  substitutionRejectLabels,
  type SubstitutionAnalysisDetail,
  type SubstitutionCandidate
} from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const recomputing = ref(false);
const analysis = ref<SubstitutionAnalysisDetail | null>(null);

const recommended = computed(() => analysis.value?.candidates.filter((item) => item.verdict === "RECOMMENDED") ?? []);
const rejected = computed(() => analysis.value?.candidates.filter((item) => item.verdict === "REJECTED") ?? []);

function scoreType(score: number): "success" | "warning" | "danger" {
  if (score >= 80) return "success";
  if (score >= 40) return "warning";
  return "danger";
}

const dimensionKeys: (keyof SubstitutionCandidate["scoreBreakdown"])[] = ["craft", "color", "unit", "compatibility", "stock"];

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: SubstitutionAnalysisDetail }>(`/substitution/analyses/${route.params.id}`);
    analysis.value = response.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "分析详情加载失败");
  } finally {
    loading.value = false;
  }
}

async function recompute() {
  try {
    await ElMessageBox.confirm(
      "将按当前启用的规则版本重新计算所有未锁定候选；人工锁定的结果不会被覆盖。",
      "规则改版重算",
      { type: "warning", confirmButtonText: "重算未锁定项", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  recomputing.value = true;
  try {
    const response = await request<{ data: { ruleVersion: number; previousRuleVersion: number } }>(
      `/substitution/analyses/${route.params.id}/recompute`,
      { method: "POST" }
    );
    ElMessage.success(`已按规则 v${response.data.ruleVersion} 重算（原 v${response.data.previousRuleVersion}），锁定项保持不变`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "重算失败");
  } finally {
    recomputing.value = false;
  }
}

async function lock(candidate: SubstitutionCandidate) {
  let note = "";
  try {
    const result = await ElMessageBox.prompt("可填写锁定备注（可选）", `锁定候选：${candidate.candidateMaterialName}`, {
      confirmButtonText: "锁定",
      cancelButtonText: "取消",
      inputType: "textarea",
      inputValue: ""
    });
    note = result.value ?? "";
  } catch {
    return;
  }
  try {
    await request(`/substitution/analyses/${route.params.id}/candidates/${candidate.id}/lock`, {
      method: "POST",
      body: { note: note || null }
    });
    ElMessage.success("已人工锁定，后续规则重算不会覆盖该结果");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "锁定失败");
  }
}

async function unlock(candidate: SubstitutionCandidate) {
  try {
    await ElMessageBox.confirm("解锁后，下次重算将覆盖该候选的评分与排序。", `解除锁定：${candidate.candidateMaterialName}`, {
      type: "warning",
      confirmButtonText: "解锁",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  try {
    await request(`/substitution/analyses/${route.params.id}/candidates/${candidate.id}/lock`, { method: "DELETE" });
    ElMessage.success("已解锁");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "解锁失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="analysis">
      <header class="page-header">
        <div>
          <h1>替代分析 · {{ analysis.targetMaterialName }}</h1>
          <p>
            {{ analysis.targetMaterialCode || "无编码" }} · {{ analysis.targetStockUnit }}
            <template v-if="analysis.requiredQuantity"> · 需求 {{ analysis.requiredQuantity }} {{ analysis.stockUnit }}</template>
            · 规则版本 v{{ analysis.ruleVersion }}
          </p>
        </div>
        <div>
          <el-button @click="router.push('/substitutions/rules')">规则版本</el-button>
          <el-button type="primary" :loading="recomputing" @click="recompute">按最新规则重算</el-button>
        </div>
      </header>

      <section class="panel">
        <h2>推荐候选（{{ recommended.length }}）</h2>
        <el-table :data="recommended" row-key="id">
          <el-table-column label="排序" width="70">
            <template #default="{ row }">
              <el-tag size="small" :type="row.locked ? 'warning' : 'success'">{{ row.locked ? '已锁定' : `#${row.rank}` }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="候选材料" min-width="200">
            <template #default="{ row }">
              <router-link :to="`/materials/${row.candidateMaterialId}`"><strong>{{ row.candidateMaterialName }}</strong></router-link>
              <div class="muted">{{ row.candidateMaterialCode || "无编码" }} · {{ row.candidateStockUnit }}</div>
              <el-tag v-for="craft in row.candidateCraftTypes" :key="craft" size="small" style="margin: 2px 4px 0 0">
                {{ craftTypeLabels[craft] || craft }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="综合分" width="110">
            <template #default="{ row }">
              <el-progress :percentage="row.totalScore" :stroke-width="10" :status="scoreType(row.totalScore)" />
            </template>
          </el-table-column>
          <el-table-column label="维度得分" min-width="320">
            <template #default="{ row }">
              <div v-for="key in dimensionKeys" :key="key" class="score-line">
                <span class="score-name">{{ dimensionLabels[key] }}</span>
                <el-progress :percentage="Math.round(row.scoreBreakdown[key].score * 100)" :stroke-width="6"
                              :show-text="false" style="flex: 1" />
                <span class="muted score-detail">{{ row.scoreBreakdown[key].detail }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="库存" width="170">
            <template #default="{ row }">
              <span class="amount">{{ row.availableQuantity }} {{ row.candidateStockUnit }}</span>
              <div v-if="row.requiredQuantityInCandidateUnit" class="muted">
                需 {{ row.requiredQuantityInCandidateUnit }} {{ row.candidateStockUnit }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button v-if="!row.locked" link type="warning" @click="lock(row)">锁定</el-button>
              <el-button v-else link type="danger" @click="unlock(row)">解锁</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="recommended.length === 0" description="没有通过硬性规则的候选，请查看下方拒绝原因" />
      </section>

      <section class="panel">
        <h2>被拒绝候选（{{ rejected.length }}）</h2>
        <el-table :data="rejected" row-key="id">
          <el-table-column label="候选材料" min-width="200">
            <template #default="{ row }">
              <router-link :to="`/materials/${row.candidateMaterialId}`"><strong>{{ row.candidateMaterialName }}</strong></router-link>
              <div class="muted">{{ row.candidateMaterialCode || "无编码" }} · {{ row.candidateStockUnit }}</div>
            </template>
          </el-table-column>
          <el-table-column label="综合分" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="scoreType(row.totalScore)">{{ row.totalScore }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="拒绝原因" min-width="260">
            <template #default="{ row }">
              <el-tag v-for="reason in row.rejectedReasons" :key="reason.code" type="danger" size="small"
                      style="margin: 2px 6px 2px 0">
                {{ substitutionRejectLabels[reason.code] || reason.code }}
              </el-tag>
              <div class="muted" style="margin-top: 4px">
                <div v-for="reason in row.rejectedReasons" :key="`${reason.code}-text`">· {{ reason.message }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="维度明细" min-width="280">
            <template #default="{ row }">
              <div v-for="key in dimensionKeys" :key="key" class="score-line">
                <span class="score-name">{{ dimensionLabels[key] }}</span>
                <span class="muted score-detail">{{ row.scoreBreakdown[key].detail }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button v-if="!row.locked" link type="warning" @click="lock(row)">锁定</el-button>
              <el-button v-else link type="danger" @click="unlock(row)">解锁</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="rejected.length === 0" description="没有被拒绝的候选" />
      </section>

      <section v-if="analysis.candidates.some((item) => item.locked)" class="panel">
        <h2>人工锁定记录</h2>
        <el-table :data="analysis.candidates.filter((item) => item.locked)">
          <el-table-column label="候选材料">
            <template #default="{ row }">{{ row.candidateMaterialName }}（{{ row.candidateStockUnit }}）</template>
          </el-table-column>
          <el-table-column label="锁定时结论" width="130">
            <template #default="{ row }">
              <el-tag size="small" :type="row.verdict === 'RECOMMENDED' ? 'success' : 'danger'">
                {{ row.verdict === 'RECOMMENDED' ? "推荐" : "拒绝" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="锁定人" prop="lockedByName" width="120" />
          <el-table-column label="备注" prop="lockNote" min-width="180" />
          <el-table-column label="锁定时间" width="180">
            <template #default="{ row }">{{ new Date(row.lockedAt).toLocaleString() }}</template>
          </el-table-column>
        </el-table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.score-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 3px 0;
}
.score-name {
  width: 48px;
  flex: 0 0 48px;
  font-size: 12px;
  color: #75675e;
}
.score-detail {
  font-size: 12px;
  max-width: 220px;
}
</style>
