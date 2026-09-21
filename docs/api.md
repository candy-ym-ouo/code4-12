# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。

## 10. 材料替代推荐

推荐按工艺、颜色、单位（量纲）、显式兼容性、库存五个维度评分。每个候选都会保留各维度分数与解释：通过硬性条件的进入推荐列表并按综合分降序，其余进入拒绝列表并附带结构化拒绝原因。

拒绝原因代码：

| 代码 | 含义 |
| --- | --- |
| `CRAFT_MISMATCH` | 适用工艺与所需工艺无重叠 |
| `COLOR_MISMATCH` | 颜色超过色差阈值或候选缺少颜色信息 |
| `UNIT_INCOMPATIBLE` | 计量单位不属于同一量纲，无法换算 |
| `COMPATIBILITY_EXCLUDED` | 兼容性矩阵明确标注不可替代 |
| `INSUFFICIENT_STOCK` | 可用库存不满足需求量 |
| `CANDIDATE_ARCHIVED` | 候选材料已归档 |

### 10.1 规则版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/substitution/rules` | 全部规则版本 |
| GET | `/substitution/rules/active` | 当前启用版本 |
| POST | `/substitution/rules` | 发布新版本并自动启用（旧版本停用） |
| POST | `/substitution/rules/:version/activate` | 重新启用历史版本 |

规则改版采用追加版本方式，历史分析保留创建时的版本号；发布新版本不会自动改动旧分析，需要在分析上显式触发重算。

```json
{
  "name": "2026 秋季放宽颜色规则",
  "requireCraftOverlap": true,
  "requireColorMatch": false,
  "requireUnitFamily": true,
  "requireStock": false,
  "colorDistanceThreshold": 60,
  "weightCraft": 30,
  "weightColor": 20,
  "weightUnit": 15,
  "weightCompatibility": 25,
  "weightStock": 10,
  "notes": "五个权重之和必须等于 100"
}
```

`require*` 字段是硬性拒绝开关；权重用于推荐项排序。色差使用 redmean 距离，阈值范围 0-450。

### 10.2 材料兼容性矩阵

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials/:id/compatibility` | 查询或新增兼容关系 |
| PATCH/DELETE | `/materials/:id/compatibility/:ruleId` | 更新或删除 |

```json
{
  "otherMaterialId": "uuid",
  "direction": "BIDIRECTIONAL",
  "compatible": false,
  "note": "缩率差异过大，不能混用"
}
```

- `BIDIRECTIONAL`：两方向都生效；`ONE_WAY`：仅当前材料 → 另一材料生效。
- `compatible=false` 是硬性拒绝项，即使工艺、颜色、单位全部匹配也不会推荐。

### 10.3 分析、重算与人工锁定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/substitution/analyses` | 分析列表（支持 `materialId`、`projectId`）或创建并立即计算 |
| GET | `/substitution/analyses/:id` | 分析详情，含全部候选、维度分数与拒绝原因 |
| POST | `/substitution/analyses/:id/recompute` | 按当前启用规则重算未锁定候选 |
| POST | `/substitution/analyses/:id/candidates/:candidateId/lock` | 人工锁定候选结果 |
| DELETE | `/substitution/analyses/:id/candidates/:candidateId/lock` | 解锁 |

创建分析：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "500",
  "unit": "g",
  "projectId": null,
  "notes": "苏木缺货，找替代品"
}
```

候选详情中的 `scoreBreakdown` 按 `craft`、`color`、`unit`、`compatibility`、`stock` 给出 0-1 分、等级和中文说明，`rejectedReasons` 给出代码与中文解释。

人工锁定保证：锁定候选的结论（推荐/拒绝）、综合分、维度分数、拒绝原因与人工排序在重算时一律不覆盖；解锁后才会参与后续重算。重算只更新未锁定项，分析的 `ruleVersion` 同步为当前启用版本。

