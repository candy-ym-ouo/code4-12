<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { SubstitutionRule } from "@/types";

const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const rules = ref<SubstitutionRule[]>([]);
const form = reactive({
  name: "",
  requireCraftOverlap: true,
  requireColorMatch: false,
  requireUnitFamily: true,
  requireStock: false,
  colorDistanceThreshold: 60,
  weightCraft: 30,
  weightColor: 20,
  weightUnit: 15,
  weightCompatibility: 25,
  weightStock: 10,
  notes: ""
});

const weightSum = () =>
  form.weightCraft + form.weightColor + form.weightUnit + form.weightCompatibility + form.weightStock;

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: SubstitutionRule[] }>("/substitution/rules");
    rules.value = response.data;
    const active = response.data.find((rule) => rule.isActive);
    if (active) {
      Object.assign(form, {
        name: "",
        requireCraftOverlap: active.requireCraftOverlap,
        requireColorMatch: active.requireColorMatch,
        requireUnitFamily: active.requireUnitFamily,
        requireStock: active.requireStock,
        colorDistanceThreshold: Number(active.colorDistanceThreshold),
        weightCraft: active.weightCraft,
        weightColor: active.weightColor,
        weightUnit: active.weightUnit,
        weightCompatibility: active.weightCompatibility,
        weightStock: active.weightStock,
        notes: ""
      });
    }
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "规则加载失败");
  } finally {
    loading.value = false;
  }
}

async function publish() {
  if (!form.name.trim()) {
    ElMessage.error("请为新版规则命名");
    return;
  }
  if (weightSum() !== 100) {
    ElMessage.error(`五项权重之和必须等于 100，当前为 ${weightSum()}`);
    return;
  }
  saving.value = true;
  try {
    await request("/substitution/rules", {
      method: "POST",
      body: { ...form, notes: form.notes || null }
    });
    ElMessage.success("新规则已发布并自动启用；可在历史分析页执行“按最新规则重算”");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "发布失败");
  } finally {
    saving.value = false;
  }
}

async function activate(rule: SubstitutionRule) {
  if (rule.isActive) return;
  try {
    await ElMessageBox.confirm(
      `启用 v${rule.version}「${rule.name}」后，新建分析使用该版本；既有分析需要手动触发重算，且人工锁定项不会被覆盖。`,
      "启用历史规则版本",
      { type: "warning", confirmButtonText: "启用", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await request(`/substitution/rules/${rule.version}/activate`, { method: "POST" });
    ElMessage.success(`已启用规则 v${rule.version}`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "启用失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>替代规则版本</h1>
        <p>规则改版 = 发布新版本并自动启用；旧分析保留原版本号，可随时按新版本重算（人工锁定项不覆盖）。</p>
      </div>
      <el-button @click="router.back()">返回</el-button>
    </header>

    <div class="two-column">
      <section class="panel">
        <h2>发布新版本</h2>
        <el-form label-position="top">
          <el-form-item label="版本名称" required>
            <el-input v-model="form.name" maxlength="120" placeholder="例如：2026 秋季放宽颜色规则" />
          </el-form-item>
          <el-form-item label="硬性拒绝条件">
            <el-checkbox v-model="form.requireCraftOverlap">工艺无重叠则拒绝</el-checkbox>
            <el-checkbox v-model="form.requireColorMatch">颜色超差或缺颜色信息则拒绝</el-checkbox>
            <el-checkbox v-model="form.requireUnitFamily">单位量纲不兼容则拒绝</el-checkbox>
            <el-checkbox v-model="form.requireStock">库存不满足需求量则拒绝</el-checkbox>
          </el-form-item>
          <el-form-item label="颜色色差阈值（0-450，仅作软分时不拒绝）">
            <el-slider v-model="form.colorDistanceThreshold" :min="0" :max="450" :step="5" show-input />
          </el-form-item>
          <el-form-item :label="`排序权重（合计 ${weightSum()}，必须等于 100）`">
            <div class="weight-grid">
              <label>工艺<input v-model.number="form.weightCraft" type="number" min="0" max="100" /></label>
              <label>颜色<input v-model.number="form.weightColor" type="number" min="0" max="100" /></label>
              <label>单位<input v-model.number="form.weightUnit" type="number" min="0" max="100" /></label>
              <label>兼容性<input v-model.number="form.weightCompatibility" type="number" min="0" max="100" /></label>
              <label>库存<input v-model.number="form.weightStock" type="number" min="0" max="100" /></label>
            </div>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.notes" type="textarea" :rows="2" maxlength="2000" />
          </el-form-item>
          <el-button type="primary" :loading="saving" :disabled="weightSum() !== 100" @click="publish">发布并启用</el-button>
        </el-form>
      </section>

      <section class="panel">
        <h2>历史版本</h2>
        <el-timeline>
          <el-timeline-item v-for="rule in rules" :key="rule.version"
                            :type="rule.isActive ? 'success' : 'info'"
                            :timestamp="`v${rule.version} · 启用时间 ${new Date(rule.activatedAt).toLocaleString()}`">
            <strong>{{ rule.name }}</strong>
            <el-tag v-if="rule.isActive" type="success" size="small" style="margin-left: 8px">启用中</el-tag>
            <div class="muted" style="margin: 6px 0">
              工艺 {{ rule.weightCraft }} · 颜色 {{ rule.weightColor }} · 单位 {{ rule.weightUnit }}
              · 兼容性 {{ rule.weightCompatibility }} · 库存 {{ rule.weightStock }}
            </div>
            <div class="muted" style="margin-bottom: 6px">
              硬性条件：
              {{ rule.requireCraftOverlap ? "工艺 " : "" }}{{ rule.requireColorMatch ? "颜色 " : "" }}
              {{ rule.requireUnitFamily ? "单位 " : "" }}{{ rule.requireStock ? "库存 " : "" }}
              {{ !rule.requireCraftOverlap && !rule.requireColorMatch && !rule.requireUnitFamily && !rule.requireStock ? "无（全部软分）" : "" }}
            </div>
            <el-button v-if="!rule.isActive" link type="primary" @click="activate(rule)">重新启用此版本</el-button>
          </el-timeline-item>
        </el-timeline>
      </section>
    </div>
  </div>
</template>

<style scoped>
.weight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
  width: 100%;
}
.weight-grid label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: #5a4a40;
}
.weight-grid input {
  width: 80px;
}
</style>
