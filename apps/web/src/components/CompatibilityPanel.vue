<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { CompatibilityRule, Material } from "@/types";

const props = defineProps<{ materialId: string }>();

const loading = ref(false);
const rules = ref<CompatibilityRule[]>([]);
const materials = ref<Material[]>([]);
const showForm = ref(false);
const form = reactive({
  otherMaterialId: "",
  direction: "BIDIRECTIONAL" as "BIDIRECTIONAL" | "ONE_WAY",
  compatible: true,
  note: ""
});

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: CompatibilityRule[] }>(
      `/materials/${props.materialId}/compatibility`
    );
    rules.value = response.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "兼容关系加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadMaterials() {
  try {
    const response = await request<{ data: Material[] }>("/materials?pageSize=100");
    materials.value = response.data.filter((item) => item.id !== props.materialId && !item.archivedAt);
  } catch {
    // 非关键数据
  }
}

function openForm(compatible: boolean) {
  form.otherMaterialId = "";
  form.direction = "BIDIRECTIONAL";
  form.compatible = compatible;
  form.note = "";
  showForm.value = true;
}

async function submit() {
  if (!form.otherMaterialId) {
    ElMessage.error("请选择另一材料");
    return;
  }
  try {
    await request(`/materials/${props.materialId}/compatibility`, {
      method: "POST",
      body: {
        otherMaterialId: form.otherMaterialId,
        direction: form.direction,
        compatible: form.compatible,
        note: form.note || null
      }
    });
    ElMessage.success("兼容关系已保存");
    showForm.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "保存失败");
  }
}

async function toggle(rule: CompatibilityRule) {
  try {
    await request(`/materials/${props.materialId}/compatibility/${rule.id}`, {
      method: "PATCH",
      body: { compatible: !rule.compatible }
    });
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "更新失败");
  }
}

async function remove(rule: CompatibilityRule) {
  try {
    await request(`/materials/${props.materialId}/compatibility/${rule.id}`, { method: "DELETE" });
    ElMessage.success("已删除");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "删除失败");
  }
}

function otherSide(rule: CompatibilityRule) {
  return rule.fromMaterialId === props.materialId
    ? { name: rule.toMaterialName, id: rule.toMaterialId }
    : { name: rule.fromMaterialName, id: rule.fromMaterialId };
}

onMounted(() => {
  void load();
  void loadMaterials();
});
</script>

<template>
  <div v-loading="loading">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">替代兼容性矩阵</h2>
      <div>
        <el-button size="small" type="success" @click="openForm(true)">标注可替代</el-button>
        <el-button size="small" type="danger" plain @click="openForm(false)">标注禁止替代</el-button>
      </div>
    </div>
    <p class="muted" style="margin:8px 0">
      显式标注会直接进入推荐引擎：可替代提升兼容性得分，禁止替代则硬性拒绝（即使其他维度匹配）。
    </p>

    <el-dialog v-model="showForm" title="新增兼容关系" width="480px">
      <el-form label-position="top">
        <el-form-item label="另一材料" required>
          <el-select v-model="form.otherMaterialId" filterable style="width:100%" placeholder="选择材料">
            <el-option v-for="material in materials" :key="material.id" :value="material.id"
                       :label="`${material.name}（${material.stockUnit}）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="方向">
          <el-radio-group v-model="form.direction">
            <el-radio value="BIDIRECTIONAL">双向：两种材料可互相替代</el-radio>
            <el-radio value="ONE_WAY">单向：仅当前材料 → 另一材料</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="判定">
          <el-switch v-model="form.compatible" active-text="可替代" inactive-text="禁止替代" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showForm = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-table :data="rules">
      <el-table-column label="另一材料" min-width="180">
        <template #default="{ row }">
          <router-link :to="`/materials/${otherSide(row).id}`">{{ otherSide(row).name }}</router-link>
          <div class="muted">{{ row.direction === "BIDIRECTIONAL" ? "双向" : "单向" }}</div>
        </template>
      </el-table-column>
      <el-table-column label="判定" width="110">
        <template #default="{ row }">
          <el-tag :type="row.compatible ? 'success' : 'danger'" size="small">
            {{ row.compatible ? "可替代" : "禁止" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="备注" prop="note" min-width="160" />
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button link @click="toggle(row)">切换判定</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="rules.length === 0" description="尚未标注任何兼容关系" :image-size="70" />
  </div>
</template>
