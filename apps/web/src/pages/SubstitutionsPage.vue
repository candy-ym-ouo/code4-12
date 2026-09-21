<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { ApiMeta, Material, SubstitutionAnalysisSummary } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<SubstitutionAnalysisSummary[]>([]);
const materials = ref<Material[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ materialId: "" });

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (filters.materialId) params.set("materialId", filters.materialId);
    const response = await request<{ data: SubstitutionAnalysisSummary[]; meta: ApiMeta }>(
      `/substitution/analyses?${params}`
    );
    rows.value = response.data;
    Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "替代分析加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  filters.materialId = "";
  void load(1);
}

onMounted(async () => {
  filters.materialId = String(route.query.materialId || "");
  try {
    const response = await request<{ data: Material[] }>("/materials?pageSize=100");
    materials.value = response.data;
  } catch {
    // 材料选项失败不阻塞列表
  }
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>材料替代推荐</h1>
        <p>按当前启用规则为缺少的材料计算替代品，推荐项按工艺、颜色、单位、兼容性、库存综合分排序。</p>
      </div>
      <el-button type="primary" @click="router.push('/substitutions/new')">新建替代分析</el-button>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="目标材料">
          <el-select v-model="filters.materialId" clearable filterable style="width: 260px" placeholder="全部材料">
            <el-option v-for="material in materials" :key="material.id" :value="material.id"
                       :label="`${material.name}（${material.stockUnit}）`" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load(1)">筛选</el-button>
          <el-button @click="reset">重置</el-button>
          <el-button @click="router.push('/substitutions/rules')">规则版本</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="目标材料" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/substitutions/${row.id}`"><strong>{{ row.targetMaterialName }}</strong></router-link>
            <div class="muted">{{ row.targetMaterialCode || "无编码" }} · {{ row.targetStockUnit }}</div>
          </template>
        </el-table-column>
        <el-table-column label="需求量" width="150">
          <template #default="{ row }">
            <span v-if="row.requiredQuantity" class="amount">{{ row.requiredQuantity }} {{ row.stockUnit }}</span>
            <span v-else class="muted">仅做适配评估</span>
          </template>
        </el-table-column>
        <el-table-column label="推荐 / 拒绝" width="130">
          <template #default="{ row }">
            <el-tag type="success" size="small">{{ row.recommendedCount }}</el-tag>
            <el-tag type="danger" size="small" style="margin-left: 6px">{{ row.rejectedCount }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="人工锁定" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.lockedCount > 0" type="warning" size="small">{{ row.lockedCount }} 项</el-tag>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="规则版本" prop="ruleVersion" width="90" />
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(`/substitutions/${row.id}`)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="还没有替代分析">
        <el-button type="primary" @click="router.push('/substitutions/new')">为材料寻找替代品</el-button>
      </el-empty>
      <el-pagination v-if="meta.total > 0" style="margin-top: 16px; justify-content: flex-end"
                     layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize"
                     :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>
