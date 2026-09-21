<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { Material, Project } from "@/types";

const route = useRoute();
const router = useRouter();
const saving = ref(false);
const materials = ref<Material[]>([]);
const projects = ref<Project[]>([]);
const form = reactive({
  materialId: String(route.query.materialId || ""),
  requiredQuantity: "",
  unit: "",
  projectId: String(route.query.projectId || ""),
  notes: ""
});

const selectedMaterial = computed(() => materials.value.find((item) => item.id === form.materialId));
watch(selectedMaterial, (material) => {
  if (material) form.unit = material.stockUnit;
});

async function loadOptions() {
  try {
    const [materialResponse, projectResponse] = await Promise.all([
      request<{ data: Material[] }>("/materials?pageSize=100"),
      request<{ data: Project[] }>("/projects?pageSize=100")
    ]);
    materials.value = materialResponse.data.filter((item) => !item.archivedAt);
    projects.value = projectResponse.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "选项加载失败");
  }
}

async function submit() {
  if (!form.materialId) {
    ElMessage.error("请选择要寻找替代品的目标材料");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { id: string } }>("/substitution/analyses", {
      method: "POST",
      body: {
        materialId: form.materialId,
        requiredQuantity: form.requiredQuantity || undefined,
        unit: form.requiredQuantity ? form.unit : undefined,
        projectId: form.projectId || null,
        notes: form.notes || null
      }
    });
    ElMessage.success("替代分析已完成");
    await router.push(`/substitutions/${response.data.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "创建替代分析失败");
  } finally {
    saving.value = false;
  }
}

onMounted(loadOptions);
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>新建替代分析</h1><p>按当前启用规则立即计算全部候选，可在结果页人工锁定与后续重算。</p></div>
      <el-button @click="router.back()">返回</el-button>
    </header>
    <section class="panel">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="目标材料（要被替代的材料）" required>
            <el-select v-model="form.materialId" filterable style="width: 100%" placeholder="选择材料">
              <el-option v-for="material in materials" :key="material.id" :value="material.id"
                         :label="`${material.name}（${material.stockUnit}）`" />
            </el-select>
          </el-form-item>
          <el-form-item label="关联项目（可选）">
            <el-select v-model="form.projectId" clearable filterable style="width: 100%">
              <el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="所需数量（可选，用于库存评分）">
            <el-input v-model="form.requiredQuantity" placeholder="例如 500；留空则只评估适配性" />
          </el-form-item>
          <el-form-item label="数量单位">
            <el-select v-model="form.unit" style="width: 100%" :disabled="!form.requiredQuantity">
              <el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit"
                         :value="unit" :label="unit" />
            </el-select>
            <div v-if="selectedMaterial && form.requiredQuantity" class="muted">
              须与 {{ selectedMaterial.stockUnit }} 同量纲，系统会换算到各候选单位比较
            </div>
          </el-form-item>
          <el-form-item label="备注" class="full">
            <el-input v-model="form.notes" type="textarea" :rows="2" maxlength="2000" />
          </el-form-item>
        </div>
        <el-button type="primary" size="large" :loading="saving" @click="submit">开始计算</el-button>
      </el-form>
    </section>
  </div>
</template>
