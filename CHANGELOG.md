# 更新日志（dsh-cost-cloud）

本服务是「多设备用量汇总 + 云端权威算价」的采集端服务。版本号与插件
`@angelyeye/dsh-cost-tracker` 独立演进；两者通过 `syncVer` 契约与同源价格表协作。

## 1.4.1

**修复：订阅套餐「看得见数据、看不见套餐」——火山方舟 Coding Plan 的说明缺失**

现场：某设备本地 provider 名为自定的 `byteblus-coding-plan-cn`（BytePlus Coding Plan CN），
云端其实**一直有**这批记录（183 条 / ¥17.7616，与本地逐分一致），但看板上的表现让人以为「没上报」：

- 概览的「按量」金额卡**不含订阅**（设计如此），所以按量数字里看不到它；
- 「订阅服务」页的**套餐单价表只列了 kimi** —— 火山套餐的等效单价（`VOLCENGINE_PLAN_RATES`）
  在算价里用到却没有暴露给看板，页上只有原始 provider 字符串，用户认不出这就是火山方舟。

改动：

- `src/pricing.js` 的 `priceSnapshot()` 新增 `subscriptionPlans`：完整套餐说明
  （`id` / `label` / 适用 provider 别名 / 白名单模型 / 等效单价 / 判定范围），
  kimi 与火山方舟 Coding Plan 各一项；
- `src/query.js`：`subscriptions` 新增 `subscriptionPlans`，并给订阅明细 / 按设备 / 最近记录
  补 `providerLabel`（`byteblus-coding-plan-cn` → 「火山方舟 Coding Plan」、`kimi*` → 「Kimi Coding Plan」）
  —— 自定 provider 名终于有人话解释；
- `web/app.js`：订阅页「套餐单价表」改为按套餐分组展示（各带适用 provider 与判定范围）；
  旧服务端没有该字段时自动回落到原表，不会白屏；
- `src/server.js`：`/api/v1/protocol` 的 `pricing` 一并回显 `subscription` 与 `subscriptionPlans`；
- 测试：`test/heatmap-subscriptions.test.js` 新增回归（火山订阅记录可见 + provider 别名 +
  两条套餐说明 + protocol 回显），云端共 **135 项**测试全通过。

> 说明：**套餐配额百分比不会上报**（云端不持有你的方舟凭据，也不该持有）——
> 配额进度条只在插件本地面板显示；云端只有 token / 花费记录。

## 1.4.0

**官方价格同步 + 多厂商价格目录（与插件 v1.9.0 配套）**

- 新增 `src/price-sync.js`：官方定价页解析器（**与插件逐字节同源**，见
  `scripts/check-pricing-sync.js`）。转置价格表（列 = 模型、行 = 指标 × 时段）
  解析为各模型峰价；页面改版/数字不齐/空闲价非半价一律**抛错**，绝不写错价。
- 新增 `src/pricing-eras.js`：把同步得到的「计费时代」存进 DB meta
  （`pricing_eras`）并在启动时注入 `pricing.js`。应用新价只影响**应用时刻之后**
  的算价，历史记录按各自时间戳选版，口径不回改。
- 新增 `src/catalog.js` + `src/vendor-catalog.js`（与插件同源的 14 家厂商、
  90 个模型条目）：内置价格表之外的模型（OpenAI / Anthropic / Gemini / Qwen 等）
  按目录价计入「精确价」，与插件侧口径对齐，避免两边 `cost_drift` 长期虚高。
  目录按 `catalog_fx_rate`（默认 7.2）把 USD/1M tokens 折算为人民币。
- `src/ingest.js`：算价时传入目录参数（目录默认开启；关闭后逐字回到旧行为）。
- 新增管理端点：`GET/POST /api/admin/pricing-sync`（核对 / 应用）、
  `POST /api/admin/pricing-eras/clear`（回退内置价）、`POST /api/admin/catalog`
  （目录开关 / 汇率 / 匹配模式）。`/api/v1/protocol` 一并回显云端实际使用的
  价格版本与目录指纹，采集端可自查两边是否同源。
- 看板「设置」页新增「官方价格同步」与「多厂商模型价格目录」两块面板，
  并把「当前单价表」改为显示**当前生效时代**（同步价生效后不再显示过期的内置表）。

## 1.3.3

- 设备令牌只读接口（`/api/v1/*`）与「插件形状」聚合的稳定性修复。

## 1.3.0

- 上报契约 `syncVer=1`：明细 / 日汇总快照 / 墓碑 / 心跳；按内容哈希幂等去重。
- `docs/INGEST-API.md`、`docs/INGEST-API.zh.md` 机器可读契约与错误码表。
