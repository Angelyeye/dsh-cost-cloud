# dsh-cost-cloud 上报接口契约（v1 / syncVer = 1）

本文件是**设备侧实现者的唯一权威依据**。任何 agent（DSH / ZCode / Codex / Claude Code / 自研工具…）的统计插件或采集器，只要按本文件实现，就能把自己的 token 用量与花费汇总到本服务，并在管理看板（含「设备 × Agent」二维视图）中出现。

本文档与实现一一对应，服务端有契约测试（`test/contract.test.js`）保证**文档承诺的行为不会被内部实现偏离**。

- 机器可读版本：`GET /api/v1/protocol`（JSON）
- 能力协商：`GET /api/v1/health`
- 可运行示例：`docs/examples/curl.sh`、`docs/examples/minimal-adapter.mjs`
- 自验脚本：`docs/examples/conformance.mjs`（幂等、错误码、水位、归属）

---

## 1. 术语与身份模型

| 概念 | 含义 | 谁生成 |
|---|---|---|
| `machineId` | **机器级身份**。同一台机器的**所有 agent 必须使用同一个** `machineId` | 建议读写共享文件 `~/.dsh-cost/device.json` |
| `deviceId` | 服务端记录的设备主键。默认等于 `machineId` | 客户端提供，服务端登记 |
| `deviceName` | 展示名，用户可在 DSH 插件配置卡里改名 | 客户端上报的只是**建议名** |
| `source` | **agent 标识**（`dsh` / `zcode` / `codex` / `claude-code` / 自定） | 适配器固定值 |
| `agentInstance` | 同一台机器上同一个 agent 的多实例（多 profile / 多安装）区分用，可留空 | 适配器可选 |
| `token` | 上报凭据，一个设备（或一个来源）一个 | 后台预建，或自注册获得 |

> ⚠️ **最常见的事故**：每台机器上的每个 agent 各生成一个 `machineId`，于是「1 台电脑 + 2 个 agent」在云端显示成 **2 台设备**。
> 正确做法：所有适配器共用同一份 `~/.dsh-cost/device.json`（目录可用环境变量 `DSH_COST_HOME` 覆盖——多 OS 用户想合并成同一台设备时指向共享路径）。

**统计维度**：服务端按 `(deviceId, source, agentInstance)` 三元组归集，因此「每台设备 × 每个 agent」的用量与花费都可独立查看、筛选、导出，且行合计 / 列合计 / 总合计三者恒等。

### source 命名约定
- 小写字母、数字、连字符：`^[a-z0-9][a-z0-9-]{0,31}$`
- 稳定、不复用：同一个 agent 永远用同一个 `source`；不要用版本号或主机名拼进去
- 建议值：`dsh`、`zcode`、`codex`、`claude-code`、`gemini-cli`、`kimi-cli`…

---

## 2. 认证与请求

```
Authorization: Bearer <token>
Content-Type: application/json
X-Device-Id: <machineId>          # 可选；载荷内 deviceId 字段优先
X-Source: <source>                # 可选；载荷内 source 字段优先
```

- 令牌形式为 `dshc_<43 字符 base64url>`；**明文只在注册时返回一次**，服务端只存哈希，遗失只能在后台轮换。
- 请求体上限 **4 MB**，单批记录上限 **2000 条**；所有响应均为 JSON，`content-type: application/json`。
- 服务端**未知字段一律容忍**（忽略或原样存入 `meta`），因此适配器可以先于服务端升级。
- 时间一律为 **epoch 毫秒**（整数）；日/月分桶固定为**北京时间（UTC+8）**，与 DSH 插件 `dayKey()` 一致。

---

## 3. 端点总览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查与能力协商（**无需鉴权**） |
| GET | `/api/v1/protocol` | 机器可读契约（**无需鉴权**） |
| POST | `/api/v1/devices/register` | 注册设备并领取令牌（需 `ALLOW_DEVICE_SELF_REGISTER=1`；否则 403） |
| POST | `/api/v1/ingest/records` | 上报明细记录（可同时携带 rollup 快照） |
| POST | `/api/v1/ingest/rollups` | 仅上报 rollup 快照（全量补传时用） |
| POST | `/api/v1/ingest/tombstone` | 声明记录已删除（可选；服务端据此排除该记录） |
| GET | `/api/v1/ingest/watermark` | 查询服务端已接收的最大 `seq` |
| POST | `/api/v1/ingest/heartbeat` | 心跳（仅更新在线状态，可用来验证令牌） |

### 3.1 `GET /api/v1/health`

```json
{
  "ok": true,
  "serviceVersion": "1.0.0",
  "syncVer": 1,
  "minSyncVer": 1,
  "time": 1789392645019,
  "caps": {
    "rollups": true, "tombstones": true, "meta": true, "heartbeat": true,
    "selfRegister": false,
    "maxBatchRecords": 2000, "maxBodyBytes": 4194304,
    "groupBy": ["device", "source", "agentInstance", "model", "project", "day", "provider"]
  }
}
```
适配器应：
- 若 `syncVer` 不为 1 → 停止上报并提示用户升级服务端；
- 若自身协议版本 < `minSyncVer` → 停止上报并提示"服务端要求升级适配器"；
- 若 `caps.selfRegister` 为 false → 不要调用注册端点，提示用户到后台建令牌。

### 3.2 `POST /api/v1/devices/register`

```json
// 请求
{ "deviceId": "6f1c…", "deviceName": "办公台式机", "source": "dsh", "agentInstance": "" }
// 200 响应
{ "ok": true, "deviceId": "6f1c…", "token": "dshc_…", "deviceName": "办公台式机" }
```
- `deviceId` 建议传本机 `machineId`；不传则服务端生成。
- 同一个 `deviceId` 重复注册会返回新的令牌（旧令牌**不会**自动失效，如需失效请在后台轮换）。
- 自注册被关闭时返回 `403 SELF_REGISTER_DISABLED`。

### 3.3 `POST /api/v1/ingest/records`

```json
{
  "syncVer": 1,
  "source": "dsh",
  "agentInstance": "",
  "agent": { "name": "DSH", "version": "0.1.0-rc.9", "pluginVersion": "1.8.0" },
  "deviceId": "6f1c…",
  "deviceName": "办公台式机",
  "resetEpoch": 0,
  "maxClientSeq": 1383,
  "sentAt": 1789392645019,
  "clock": { "tzOffset": -480 },
  "batchUid": "3f2b0c8e-…",
  "records": [
    {
      "seq": 1384,
      "ts": 1789392645019,
      "provider": "deepseek-official",
      "model": "deepseek-v4.1-flash",
      "sessionId": "session-ddb21caa-…",
      "purpose": "",
      "tokens": { "input": 3850, "output": 2880, "cacheRead": 43904, "cacheWrite": 0, "reasoning": 2612 },
      "cost": 0.01624808,
      "costBasis": "reported",
      "estimated": false,
      "period": "off-peak",
      "subscription": false,
      "meta": { "workspace": "proj-a" }
    }
  ],
  "rollups": [
    {
      "dayKey": "2026-03-04",
      "provider": "deepseek-official",
      "model": "deepseek-v4.1-flash",
      "subscription": false,
      "calls": 12,
      "tokens": { "input": 12000, "output": 8000, "cacheRead": 40000, "cacheWrite": 0, "reasoning": 0 },
      "cost": 1.23,
      "peak": 0.4, "off": 0.8, "flat": 0.03,
      "absorbed": ["<dedupKey>", "…"]
    }
  ]
}
```

```json
// 200 响应
{
  "ok": true,
  "accepted": 12, "updated": 0, "duplicates": 3, "invalid": 0,
  "tombstoned": 0, "rollupsUpserted": 1,
  "cost": { "computed": 0.195, "deviceReported": 0.195, "drift": 0, "basis": "reported" },
  "watermark": { "maxClientSeq": 1384, "lastAcceptedAt": 1789392645100 },
  "warnings": []
}
```

语义：
- **幂等**：相同 `batchUid` 的重复请求直接返回首次结果（不重复计数）。
- `accepted` = 新增行数；`updated` = 命中已存在记录并刷新了展示字段（如费用重算）的行数；`duplicates` = 内容完全相同、无变化；`invalid` = 被跳过的非法记录（附 `warnings`）。
- `tombstoned` = 本次因 rollup 的 `absorbed` 列表而被排除的历史明细行数（它们已计入快照，不会重复统计）。

### 3.4 `POST /api/v1/ingest/rollups`

与 3.3 相同的信封字段，`snapshots` 取代 `records`（等价于 3.3 的 `rollups` 数组）。用于"明细已超期折叠、需要全量重传"的场景。

### 3.5 `POST /api/v1/ingest/tombstone`

```json
{ "syncVer": 1, "source": "dsh", "deviceId": "6f1c…", "reason": "user-reset",
  "keys": ["<dedupKey>", "…"] }
```
用于适配器侧执行"清空数据"后同步删除。服务端只标记不物理删除（后台可彻底清理）。

### 3.6 `GET /api/v1/ingest/watermark?source=&agentInstance=`

```json
{ "ok": true, "maxClientSeq": 1384, "lastAcceptedAt": 1789392645100 }
```
`deviceId` 取自令牌归属；也可用 `?deviceId=` 覆盖（同一令牌跨设备使用时）。

---

## 4. 字段字典

### 4.1 信封（信封字段对所有端点通用）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `syncVer` | integer | ✅ | 必须为 `1` |
| `source` | string | ✅ | agent 标识，见命名约定；缺失 → `400 MISSING_SOURCE` |
| `agentInstance` | string | ❌ | 多实例区分，默认 `""` |
| `agent` | object | ❌ | `{name, version, pluginVersion}`，仅作展示 |
| `deviceId` | string | ❌ | 缺省用令牌归属；建议传本机 `machineId` |
| `deviceName` | string | ❌ | 展示名建议值（用户已改名则服务端不覆盖） |
| `resetEpoch` | integer | ❌ | 本地数据被"清空"过几次；重置后 +1（避免重置后重新导入被判重复） |
| `maxClientSeq` | integer | ❌ | 本批最大 `seq`；用于服务端水位（缺省取 `records[].seq` 最大值） |
| `sentAt` | integer | ❌ | 发送时刻（仅诊断） |
| `clock` | object | ❌ | `{tzOffset}` 分钟；`tzOffset` 仅记录不参与分桶 |
| `batchUid` | string | ❌ | 幂等键；建议每次请求生成 UUID |
| `records` | array | ❌ | 明细记录（与 `rollups` 至少给一个） |
| `rollups` | array | ❌ | 日汇总快照 |

### 4.2 明细记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `seq` | integer | ❌ | 适配器本地单调序号；服务端水位用它增量拉取（**建议提供**） |
| `ts` | integer | ✅ | 调用发生时刻（epoch ms） |
| `provider` | string | ✅ | 服务商标识，如 `deepseek-official`、`moonshot-ai` |
| `model` | string | ✅ | 计费模型名（被路由的请求请填**实际计费模型**） |
| `tokens` | object | ✅ | 见 4.3；token 全为整数 |
| `sessionId` | string | ❌ | 会话标识；敏感，可用不可逆哈希（见 §7） |
| `purpose` | string | ❌ | 用途/项目归属 |
| `cost` | number | ❌ | 适配器自算费用（CNY）；**服务端只作参考，不作为权威口径** |
| `costBasis` | enum | ❌ | `reported` / `estimated` / `subscription` / `unknown` |
| `estimated` | boolean | ❌ | 是否估算 |
| `subscription` | boolean | ❌ | 是否订阅套餐覆盖（等效费用） |
| `period` | enum | ❌ | `peak` / `off-peak` / `flat`（服务端按 `ts` 重算） |
| `meta` | object | ❌ | 适配器自定义字段，原样存储（≤1 KB/条） |

### 4.3 `tokens` 对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | integer | ✅ | **缓存未命中**的输入 token |
| `output` | integer | ✅ | 输出 token |
| `cacheRead` | integer | ❌ | 缓存**命中/读取**的输入 token（默认 0） |
| `cacheWrite` | integer | ❌ | 缓存**写入/创建**的输入 token（默认 0） |
| `reasoning` | integer | ❌ | 推理 token（若服务商单独计价，默认 0） |

**各家命名映射对照表**

| 常见命名 | 应映射为 |
|---|---|
| `prompt_tokens` / `input_tokens` / `inputTokens` | `input`（**注意：先扣除缓存命中部分**） |
| `completion_tokens` / `output_tokens` | `output` |
| `cached_tokens` / `cached_input_tokens` / `cache_read_input_tokens` / `prompt_cache_hit_tokens` | `cacheRead` |
| `cache_creation_input_tokens` / `cache_write_tokens` | `cacheWrite` |
| `reasoning_tokens` / `thinking_tokens` | `reasoning` |

> ⚠️ **不要把 `prompt_tokens` 的总额直接塞进 `input`**：若服务商把缓存命中包含在 `prompt_tokens` 内（DeepSeek / OpenAI 都是），必须 `input = prompt_tokens - cached_tokens`，否则输入费用会明显高估。

### 4.4 rollup 快照

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dayKey` | string | ✅ | 北京时区日期 `YYYY-MM-DD` |
| `provider` / `model` | string | ✅ | 同明细 |
| `subscription` | boolean | ✅ | 订阅/按量口径分离 |
| `calls` | integer | ✅ | 当日该模型调用次数 |
| `tokens` | object | ✅ | 同 4.3 的**当日合计** |
| `cost` | number | ✅ | 当日该模型合计费用 |
| `peak` / `off` / `flat` | number | ❌ | 峰/闲/平三段费用（缺省按 `cost` 归入 `flat`） |
| `absorbed` | string[] | ❌ | 被折叠进本快照的**明细 dedupKey 列表** |

`absorbed` 的作用：本地明细超过保留窗口（DSH 插件为 180 天）后会被折叠成 rollup。若此前明细已上报过，必须把它们的 `dedupKey` 放进 `absorbed`。服务端把列表里的每个 key 落成**墓碑**（tombstone），该明细从此不再计入任何统计 —— **即使这条明细还没上报**（乱序时也不会丢：它到达时会被识别为已由快照计入，仅保留审计痕迹而不重复计数）。所以务必遵循「**明细先发、快照后发**」。

---

## 5. 错误码

| HTTP | `code` | 含义 | 适配器应做 |
|---|---|---|---|
| 400 | `MISSING_SOURCE` | 缺 `source` | 修正实现（不重试） |
| 400 | `UNSUPPORTED_SYNC_VER` | `syncVer` 不受支持（响应含 `minSyncVer`/`syncVer`） | 提示用户升级，停止上报 |
| 400 | `INVALID_BODY` | JSON 解析失败 | 修正实现 |
| 400 | `INVALID_RECORD` | 单条记录字段非法 | 检查 `warnings`，跳过该条 |
| 401 | `TOKEN_INVALID` | 令牌无效或被轮换 | 停止上报并提示用户重新配置令牌 |
| 401 | `TOKEN_MISSING` | 未带 `Authorization` | 修正实现 |
| 403 | `DEVICE_DISABLED` | 设备被后台禁用 | 停止上报 |
| 403 | `SELF_REGISTER_DISABLED` | 不允许自注册 | 提示用户到后台建令牌 |
| 404 | `UNKNOWN_ROUTE` | 路径错误 | 检查 base URL |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体 > 4 MB | 缩小批次后重试 |
| 429 | `RATE_LIMITED` | 触发限流（响应含 `retryAfterMs`） | 按 `retryAfterMs` 退避重试 |
| 500 | `INTERNAL` | 服务端异常 | 指数退避重试（5s → 10s → … → 300s） |

错误响应统一形状：
```json
{ "ok": false, "code": "TOKEN_INVALID", "error": "人类可读说明", "retryAfterMs": 0 }
```

---

## 6. 去重算法（必须逐字一致）

同一个逻辑记录无论上报多少次，都必须得到**完全相同**的 `dedupKey`，服务端据此幂等。

### 6.1 规范化规则

1. **字符串**：`String(v)` → 去首尾空白；`provider`、`model` 转小写。缺省为 `""`。
2. **整数**：`Math.trunc(Number(v))`；非有限值按 `0`。
3. **费用**：四舍五入到 **6 位小数**，并输出"最短"十进制字符串：`0`、`0.016248`、`1.5`、`123.456789`。
   Java 的 `Double.toString`、Go 的 `strconv.FormatFloat(v,'f',-1,64)`、Rust 的 `{}`（f64）都符合此形态；**不要**用固定位数格式化（会带出多余 0）。
4. **canonical 串**：把下列字段按**固定顺序**拼成单行字符串，字段间用 `\u001f`（Unit Separator）分隔，**不使用 JSON**：
   ```
   <mode> ␟ <resetEpoch> ␟ <ts> ␟ <provider> ␟ <model> ␟ <sessionId> ␟ <purpose>
         ␟ <input> ␟ <output> ␟ <cacheRead> ␟ <cacheWrite> ␟ <reasoning> ␟ <cost6>
   ```
   - 明细记录：`mode = "detail"`
   - rollup 快照：`mode = "rollup:<dayKey>"`，且**只**拼接 `subscription`、`provider`、`model`
     （即 `rollup:<dayKey> ␟ <0|1> ␟ <provider> ␟ <model>`）。
     ⚠️ 快照的**可变指标**（`calls`/`tokens`/`cost`）**不参与身份**：同一天继续使用会让快照增长，
     若把指标计入键，每次增长都会插入新行并导致重复计数。服务端对同一 key 的行做 `max()` 单调合并。
5. **`dedupKey`** = 该 canonical 串的 **SHA-256 小写十六进制**（64 字符）。

> ⚠️ 两个已知陷阱：**不要**在 `dedupKey` 里包含 `cost` 之外的派生字段之外的东西（如本机路径、随机 ID、本地行号）；**也不要**用 JSON.stringify —— 不同语言对空格、浮点、Unicode 转义的处理不一致。
> `resetEpoch` 参与计算：本地"清空数据"后 `resetEpoch += 1`，新数据就不会被判为旧数据的重复。

### 6.2 JavaScript 参考实现（可直接复制）

```js
import { createHash } from 'node:crypto'

const US = '\u001f'

function s(v) { return v == null ? '' : String(v).trim() }
function i(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function cost6(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 1e6) / 1e6
  return String(r)              // JS 的 Number→String 即"最短往返"表示
}

export function detailCanonical(r, { resetEpoch = 0 } = {}) {
  const t = r.tokens || {}
  return [
    'detail', i(resetEpoch), i(r.ts),
    s(r.provider).toLowerCase(), s(r.model).toLowerCase(),
    s(r.sessionId), s(r.purpose),
    i(t.input), i(t.output), i(t.cacheRead), i(t.cacheWrite), i(t.reasoning),
    cost6(r.cost),
  ].join(US)
}

export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex')
}

export function dedupKeyOfDetail(r, opts) { return sha256hex(detailCanonical(r, opts)) }
```

**实现建议**：适配器应先跑一次 `docs/examples/conformance.mjs`，它会用下面这组测试向量校验你的实现：

| 输入 | 期望 canonical 串（`␟` 处为 `\u001f`） |
|---|---|
| `{ts:1789392645019, provider:'DeepSeek-Official', model:'DeepSeek-V4.1-Flash', sessionId:' s1 ', purpose:null, tokens:{input:3850,output:2880,cacheRead:43904}, cost:0.01624808}`，`resetEpoch:0` | `detail␟0␟1789392645019␟deepseek-official␟deepseek-v4.1-flash␟s1␟␟3850␟2880␟43904␟0␟0␟0.016248` |

---

## 7. 隐私与脱敏

- 只上报 **token 数量、费用、时间戳与标识符**；**绝不要**上报 prompt / 回复 / 文件路径 / 代码内容。
- `sessionId` 若属于会话标识，建议做**不可逆哈希**后再上报（DSH 插件提供「会话脱敏」开关）：
  `sessionId = sha256(sessionId).slice(0, 16)`（同一会话保持稳定，便于聚合，且不可反查）。
- `purpose` 若可能含敏感信息（如仓库名、客户名），请在上报前替换为代号。
- 传输必须走 HTTPS（自签/内网可直接用 HTTP，但需自行评估风险）。
- `meta` 会原样存储：不要放任何凭据。

---

## 8. 增量与重试建议

1. 维护本地水位 `watermark`（服务端返回的 `maxClientSeq`），每次只发 `seq > watermark` 的记录。
2. 水位**只是省流量的优化**；正确性由 §6 去重保证，因此水位丢失（本地文件被删）后全量重发是安全的。
3. 首批全量建议按 `syncSinceDays`（DSH 插件默认 180 天）裁剪，避免一次推 10 万条。
4. 批次：`records` ≤ 2000 条 / 请求体 ≤ 4 MB；建议 500 条一批。
5. 退避：`429` 按 `retryAfterMs`；`5xx` 指数退避 5s → 10s → … → 300s 上限；`401/403` **不要**重试，直接提示用户。
6. 明细与快照**同批或先明细后快照**发送；不要把 `absorbed` 快照发在对应明细之前。
7. 上报失败**不得影响本地记账**：先落本地，再异步上报。

---

## 9. 版本策略

- `syncVer` 每次不兼容变更递增；服务端在 `/health` 公布 `syncVer` 与 `minSyncVer`。
- 新增可选字段不递增 `syncVer`（服务端容忍未知字段）。
- 废弃流程：先在一个版本内接受但回 `warnings`，下一版本才拒收（`UNSUPPORTED_SYNC_VER`）。
- 适配器启动时应调用 `/health` 做一次能力协商，并把结果缓存 5 分钟。

---

## 10. 常见误区（照抄自真实事故）

| 误区 | 后果 | 正解 |
|---|---|---|
| 每个 agent 各生成一个 `machineId` | 1 台电脑显示成 N 台设备 | 共用 `~/.dsh-cost/device.json` |
| `input` 里含缓存命中 token | 输入费用高估 2~10 倍 | `input = prompt_tokens - cached_tokens` |
| 用累计值当每次调用的值 | 用量随会话数**指数级**膨胀 | 用**差分**：本次累计 − 上次累计 |
| 同一个物理调用被两个 agent 各记一次（如 agent 内部另起子 agent，父/子都记账） | 该花费被统计两次 | 由适配器保证归属唯一（只让真正发起计费的层记账） |
| `dedupKey` 用 `JSON.stringify` | 跨语言结果不一致 → 重复计数 | 用 §6.1 的 canonical 串 |
| 用 `ts` 当天 0 点再上报快照 | 快照与明细重叠 → 重复计数 | 用 `absorbed` 声明已折叠的明细 |
