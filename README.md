# dsh-cost-cloud

多机 · 多 Agent 的 **AI 用量与花费云端汇总服务**。为 [dsh-cost-tracker](https://github.com/Angelyeye/dsh-cost-tracker) 提供跨设备汇总，
同时以**开放上报契约**接收任何 agent（ZCode / Codex / Claude Code / 自研工具…）的统计插件，统一在管理看板与「设备 × Agent」矩阵中展示。

- **零运行时依赖**：只用 Node 24 内置模块（`node:http` / `node:sqlite` / `node:crypto`），没有 npm 依赖、没有构建步骤。
- **自托管**：Docker 一条命令起服务，数据落在你自己的 SQLite 文件里。
- **两种鉴权**：设备用 Bearer 令牌；管理端用口令 + HttpOnly 会话 Cookie。
- **幂等去重**：内容哈希作唯一键，重复/重放/乱序上报都不会重复计数。

---

## 快速开始（Docker，推荐）

```bash
# 1) 取代码（公开仓库）
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/Angelyeye/dsh-cost-cloud.git
sudo chown -R $USER:$USER /opt/dsh-cost-cloud
cd /opt/dsh-cost-cloud

# 2) 生成两个密钥/哈希
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # → SESSION_SECRET
node scripts/hash-password.js "你的管理员口令"                                   # → ADMIN_PASSWORD_HASH
# 把两者填进 .env

# 3) 起服务
docker compose up -d

# 4) 打开看板
#    http://<服务器IP>:8787
```

首次登录后到 **设置** 页可以看到**共享引导令牌明文**（带「复制」按钮），把它填进 DSH 插件的「云端同步」配置卡即可开始上报。

生产环境请在前面放一层 TLS，并把 compose 的端口改成 `127.0.0.1:8787:8787` 只对反代暴露
（`docker-compose.1panel.yml` 就是为此准备的覆盖文件）。

**升级**：`git pull && docker compose -f docker-compose.yml -f docker-compose.1panel.yml up -d --build`
（`.env` 已 gitignore，`git pull` 不会覆盖你的密钥；数据库迁移启动时自动执行，迁移前自动备份）

**部署到腾讯云轻量 + 1Panel**：见 [`docs/DEPLOY-1PANEL.zh.md`](docs/DEPLOY-1PANEL.zh.md)（含反代、证书、防火墙、备份、排障）。

## 不用 Docker（单进程直跑）

```bash
node src/main.js check                 # 自检配置与数据库
node src/main.js start                 # 启动
node src/main.js register --name "办公台式机" --source dsh   # 打印一枚设备令牌
```

`node src/main.js hash-password "口令"` 可随时生成口令哈希。

---

## 接入 DSH 插件

在插件设置卡里填：

| 字段 | 说明 |
|---|---|
| 服务地址 | 例如 `https://cost.example.com`（末尾不要带斜杠） |
| 共享引导令牌 | 看板「设置」页生成的那个 `dshc_...` |
| 设备名 | 你在看板上看到的机器名（可随时改，云端不会覆盖） |
| 同步间隔 / 批量 | 默认 60 秒 / 500 条 |

插件会：本地先记账 → 异步增量上报 → 失败指数退避 → 断网恢复后自动补齐。
删除设备令牌或轮换后，插件会在状态行提示「令牌无效」。

---

## 接入其它 Agent（适配器作者请看这里）

**云端不需要认识任何具体 agent**。任何统计插件只要按契约实现 HTTP 上报即可接入，看板（含「设备 × Agent」二维矩阵）会自动出现新的 `source` 列。

- 📄 契约（中文）：[`docs/INGEST-API.zh.md`](docs/INGEST-API.zh.md)
- 📄 Contract (EN): [`docs/INGEST-API.md`](docs/INGEST-API.md)
- 🧾 参考载荷：`docs/examples/reference-payload.json`
- 🔧 curl 示例：`docs/examples/curl.sh`
- 🧩 最小适配器（~60 行）：`docs/examples/minimal-adapter.mjs`
- ✅ 一致性自验：`docs/examples/conformance.mjs`

```bash
# 离线校验你的 dedupKey 实现是否符合契约
node docs/examples/conformance.mjs

# 在线校验幂等、错误码、水位、快照与墓碑
node docs/examples/conformance.mjs --base http://127.0.0.1:8787 --token dshc_xxx
```

### 采集端只读查询（设备令牌可读）

采集端插件手里只有**设备令牌 / 共享引导令牌**，拿不到管理员会话；因此云端另开了一组**只读**聚合接口，用同一个令牌鉴权，供插件渲染「仅云端 / 本机+云端」视图：

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/overview?range=7d&days=7` | 概览聚合；支持 `devices` / `sources` / `excludeDevice` / `excludeSource`，也支持 `union=<JSON数组>` 把多组过滤条件的概览相加（插件「本机+云端」用的就是它） |
| `GET /api/v1/matrix?range=7d` | 「设备 × Agent」二维矩阵 |
| `GET /api/v1/devices` | 设备 / 来源维度清单（插件据此把 deviceId 显示成设备名） |

```bash
curl -H "Authorization: Bearer $DSH_SYNC_TOKEN" "http://127.0.0.1:8787/api/v1/overview?range=7d"
```

- 鉴权与上报完全一致（`Authorization: Bearer <设备令牌或共享引导令牌>`）：缺令牌 401 `TOKEN_MISSING`，错令牌 401 `TOKEN_INVALID`。
- **只读**：写数据、改配置、管令牌、看审计仍然只认管理员会话；设备令牌访问 `/api/admin/*` 一律 401。
- 返回结构与同名管理接口**逐项一致**（共用同一实现），插件的两种视图口径因此与看板相同。
- 可用 `ALLOW_DEVICE_READ=0` 关闭（返回 403 `DEVICE_READ_DISABLED`），默认开启。

### 三个必须遵守的约定

1. **同一台机器上的所有 agent 必须共用同一个 `machineId`** —— 建议读写共享文件 `~/.dsh-cost/device.json`（可用 `DSH_COST_HOME` 覆盖目录）。
   各 agent 各生成一个 ID 会让「1 台电脑」在看板上显示成多台设备。
2. **`input` 是"缓存未命中"的输入 token** —— 若服务商把缓存命中包含在 `prompt_tokens` 里，必须减去。否则输入费用会被高估数倍。
3. **`dedupKey` 用 §6 的 canonical 串**（不是 `JSON.stringify`）—— 不同语言的浮点/转义处理不同，用 JSON 会产生"同一记录两个键"，从而重复计数。

---

## 看板说明

| 页面 | 作用 |
|---|---|
| 概览 | 时间范围：今天 / 近 7 天 / 近 30 天 / 近 90 天 / 本月 / 本年 / **全部**；今日 / 本月 / 全部累计卡片（带环比）；近 30 天热力条；按 Agent、按设备的分布；口径漂移提示 |
| **热力图** | 日历热力图（周为列、星期为行，缺口补零）+ 星期×小时热力图（高峰计价时段虚线框）；指标可切 花费 / 按量 / 订阅 / 调用 / Tokens，窗口可选 30/90/180/365 天、本年、全部；点日历格直接下钻到当天记录 |
| 趋势 | 按天/周/月，分组维度可选 设备 / Agent / 模型 / 项目 |
| **订阅服务** | 订阅等效费用与占比、订阅 vs 按量的按天/按月对比、套餐明细（活跃日均、闲置天数）、按设备 / Agent 分布、套餐单价表与最近订阅记录。窗口默认**全部**（订阅是按月生效的长周期账，用「近 7 天」会看到一片 ¥0.0000），可切 7/30/90 天、本月 |
| **设备 × Agent** | 矩阵：行=设备、列=agent，单元格=花费 / tokens / 调用；行合计 = 列合计 = 总计；单元格可点击下钻到记录；附同步健康度 |
| 设备 | 机器清单，可改名（可锁定）、禁用、轮换令牌、清空某设备数据；展开可见每台机器上各 agent 的明细 |
| 模型 | 模型用量与花费，含历史日汇总（明细超期折叠部分） |
| 记录 | 明细表（设备 + agent + 模型 + 会话 + tokens + 费用），筛选与 CSV 导出 |
| **监控** | 告警列表（同步停滞 / 时钟偏差 / 非法记录 / 口径漂移 / 估算占比 / 缓存命中率 / 花费尖峰 / 月度预算 / 订阅闲置 / 版本不一致 / 云端静默 / 区间空数据）、设备同步新鲜度、近 30 天成本速率、阈值与预算设置。订阅闲置判定固定用**全时段**窗口（套餐可能上月才用过） |
| 设置 | 服务信息、共享引导令牌、管理员口令、已接入 Agent 列表、当前单价表 |

> 热力图 / 订阅服务 / 监控三页走 `GET /api/admin/heatmap` 与 `GET /api/admin/subscriptions`（**仅管理员会话**，
> 设备令牌一律 401）。告警阈值与预算存在浏览器 `localStorage`（键 `dshc.prefs`），只影响本机这一份看板。

---

## 口径（重要）

- **时区**：全部按**北京时间（UTC+8）**分桶，与 DSH 插件一致，因此多机数字可直接相加。
- **时间范围**：`range=today | 7d | 30d | month | year | all`，自定义区间用 `from` / `to`（epoch ms）。
  其中 `all` 在看板上叫「**全部**」，语义是 `fromMs = 0`（**无下界**）—— 它的起点就是全库最早一条记录的日期，
  概览卡片副标题上的「自 YYYY-MM-DD HH:mm 起」只是把那个日期显示出来，不是被截断。
- **按量 vs 订阅**：分开统计；订阅显示为「等效费用」，仅供参考。
- **设备维度的排除语义**：`excludeDevice=<id>` 排除的是**整台设备**（含该机上所有 agent）；
  `excludeSource=<src>` 排除某个 agent 来源，两者可叠加，也可与 `devices=` / `sources=` 白名单混用。
  需要**并集**口径（例如「其他整机 + 本机上的其它 agent」）时用
  `overview?union=[{...},{...}]`：服务端把各部分的概览相加后返回一份合并结果（≤8 部分，有测试守护）。
- **统计维度**：每条记录带 `(device_id, source, agent_instance)`，因此「每台设备 × 每个 agent」
  可独立查看、筛选、导出；矩阵的行合计 = 列合计 = 总合计恒成立（明细 + 历史日汇总一起算）。
- **费用来源**：以设备上报值为准（历史价格时代无法回溯时，云端重算会与设备不一致）；
  云端同时按自己内置的价格表重算一遍，两者差值即「口径漂移」，在看板提示 ——
  常见原因是某台设备插件版本较旧（升级后可用 `cost_recompute` 补账）。
- **明细 vs 日汇总**：设备本地明细保留 180 天，更早折叠为永久日汇总；云端两者都收，
  通过 `absorbed` 墓碑避免重叠计数。

---

## 备份与恢复

数据只有一个 SQLite 文件（在命名卷 `dsh_data` 里）：

```bash
# 逻辑备份（推荐，可在容器里执行）
docker compose exec dsh-cost-cloud node -e "process.exit(0)"   # 确保容器在跑
docker compose exec dsh-cost-cloud sh -c 'ls -l /data'

# 宿主机上拿到卷路径后直接复制三件套（db / -wal / -shm），或：
docker run --rm -v dsh_data:/data -v "$PWD:/backup" alpine \
  sh -c 'cp /data/dsh-cost-cloud.sqlite* /backup/'
```

服务在每次 schema 迁移前会自动把旧库复制到 `data/backups/pre-migration-*.sqlite`（保留最近 7 份）。

看板「记录」页的 **导出 CSV** 也是兜底：任何情况下都能把全部数据取回本地。

---

## 安全须知

- **必须**设置 `SESSION_SECRET` 与 `ADMIN_PASSWORD_HASH`，否则服务拒绝启动（这是刻意的 fail-closed）。
- 共享引导令牌等价于"注册通行证"：拿到它的人可以注册设备并上报数据。请只在 HTTPS 下使用，
  泄露了就用 `POST /api/admin/device-token` 重新生成（旧令牌立即作废），并到设备页清空可疑设备的数据。
  **看板「设置」页会明文显示这个令牌**——能登进管理端的人就能拿走它，请确保 `ADMIN_PASSWORD_HASH` 足够强。
- 上报接口有按设备/IP 的令牌桶限流（默认 120 次/分钟）。
- 管理端会话是 HttpOnly + SameSite=Strict Cookie；登录失败按 IP 指数退避。
- `TRUST_PROXY=1` 才会采信 `X-Forwarded-For`（直连时请保持关闭）。
- 服务**只存 token 数量、费用、时间戳与标识符**，不存 prompt / 回复 / 文件路径 / 代码内容。
  适配器若上报 `sessionId`，建议先做不可逆哈希（插件提供「会话脱敏」开关）。

---

## 开发与测试

```bash
npm test                     # 全部测试（node --test）
node --no-warnings --test test/contract.test.js   # 只跑契约测试
node scripts/check-pricing-sync.js --plugin ../dsh-cost-tracker   # 校验价格表与插件同源
```

测试覆盖：去重键契约向量、幂等与重放、rollup 快照与墓碑、二维矩阵自洽、
鉴权与限流、计费口径与北京时间边界、契约错误码、双设备双 agent 端到端。

---

## 目录结构

```
src/            服务端（config / http / db / auth / ingest / query / pricing / time）
src/schema/     SQLite 迁移（PRAGMA user_version 驱动）
web/            看板（原生 ES 模块，无构建）
docs/           INGEST-API 契约（中/英）与示例
scripts/        口令哈希、价格表同步校验
test/           node --test 测试
```

---

## 更新记录

### v1.3.2

**`plugin-view` 的按天数据补上 token 类型拆分，供插件「Token 用量统计」热力图按视图合并。**

- `GET /api/v1/plugin-view` 的 `byDay` 每一项新增 `input` / `output` / `cacheRead` /
  `cacheWrite` / `reasoning`。此前按天只有 `tokens` 总数（`byModelDay` 早就有拆分），
  插件侧热力图要显示「输入 / 缓存 / 输出 / 费用」浮层并跨视图合并时无数据可用。
- `plugin-view?union=...`（「本机+云端」走的正是这条路径）的并集合并同样累加这五项，
  不会出现「只有 tokens 总数、拆分全为 0」的半截数据。
- 拆分项之和恒等于 `tokens`（含 `reasoning`），有单测守护，避免以后改聚合时两边漂移。
- 纯新增字段，不改任何既有字段语义：卡片、矩阵、记录页与旧版插件完全不受影响。

### v1.3.1

**设置页明文回显共享引导令牌。**

- `GET /api/admin/config` 新增 `deviceToken` 字段，明文返回当前共享引导令牌；令牌只写在 `.env`
  （没走生成接口、库里没有记录）时回退读 `DSH_SYNC_TOKEN`，同样能看到明文。
- 看板「设置 → 服务信息」的「共享引导令牌」一行，由「已设置 / 未设置」改为**直接显示明文**，
  并带「复制」按钮：换机器、重装插件、给新设备接入时，不必再登服务器翻 `.env` / SQLite，
  也不必为了看令牌而重新生成（那会作废所有机器上正在用的旧令牌）。
- 明文**仅对管理员会话可见**：设备令牌访问 `/api/admin/config` 依旧 401，且响应体不带任何令牌。
  管理员口令因此成为该令牌的唯一防线（见「安全须知」）。
- 修复 `test/alerts.test.js` 的时间炸弹：`half` 上下文漏传 `now`，使 `computeAlerts` 回退到真实
  `Date.now()`，与测试里固定的 `NOW` 相减超过 6 小时后必然误报 `cloud-silent`。

### v1.3.0

**看板新增「热力图 / 订阅服务 / 监控」三页，整体布局重做。**

- 新增 `GET /api/admin/heatmap`：日历格（按天补零铺满）+ 星期×小时格（7×24 恒定 168 格）、
  高峰计价时段标记、`summary`（活跃天数 / 连续天数 / 单日最高 / 最忙时段 / 缓存命中率 / 近 7 日均值）。
  **时段格只取明细（`ts > 0`）**：日汇总快照的 `ts` 可能为 0，聚合时会回退到当日北京正午，
  一并计入会凭空造出一个 12 点的假高峰。
- 新增 `GET /api/admin/subscriptions`：订阅（等效费用）与按量分开统计 + 按天 / 按月两条时间轴 +
  套餐明细（占比、活跃日均、闲置天数）+ 按设备 / Agent 分布 + 最近订阅记录 + 套餐单价表（折算依据）。
  两者都是**管理端专属**：设备令牌访问仍 401（采集端只需要 `/api/v1/overview|plugin-view`）。
- 看板由 7 页扩到 **10 页**，导航按「纵览 / 用量 / 运维」分组：概览、**热力图**、趋势、
  **订阅服务**、设备×Agent、设备、模型、记录、**监控**、设置；吸顶工具栏统一承载区间、筛选、
  自动刷新（30s/60s/5m）与导出，视图可深链（`#/heatmap`），窄屏侧栏折叠为横向导航条。
- 「监控」页：12 条可行动告警规则（同步停滞 / 时钟偏差 / 非法记录 / 口径漂移 / 估算占比 /
  缓存命中率 / 花费尖峰 / 月度预算 / 订阅闲置 / 插件版本不一致 / 云端静默 / 区间空数据），
  阈值与预算可在页面上调整（存 `localStorage`），告警计数同步显示在侧栏与工具栏；附设备新鲜度、
  近 30 天成本速率与阈值表单。
- 新增 `GET /api/admin/overview` 的**上期切片**（`summary.prev*`，等长紧邻窗口），KPI 卡显示环比。
- **修复：概览的三张切片卡片长期显示 `¥0.0000`** —— `today/month/all` 的真实字段名是
  `real`（与插件 `buildDashboard` 同形），而看板读的是 `realCost`，于是「今日 / 本月 / 全部累计」
  永远是 0（汇总卡片却是对的，所以一直没被发现）。现统一走 `web/state.js` 的 `sliceReal/sliceSub`。
- **修复：`PORT=0` 被当成非法值回退到 8787** —— `PORT=0`（让系统分配空闲端口）是通用约定，
  测试与临时实例都靠它并行启动；此前会被 `intIn(PORT, 1, 65535, 8787)` 判为越界而落到 8787，
  多个测试实例抢同一端口（Windows 上表现为随机 `EADDRINUSE`）。
- 测试：+21 条（`test/heatmap-subscriptions.test.js` 7 条、`test/alerts.test.js` 10 条、
  前端 4 条），共 121 条；全栈用例新增「日历格铺满 + 时段格命中真实 ts + 切片金额非零」断言。

### v1.2.1

- **修复：`overview` 的三切片（今日 / 本月 / 总花费）无视过滤条件** —— 原取自 `totalsUnfiltered`（无条件下全表），
  于是 `excludeDevice` / `devices` 等参数对它们完全无效。对「本机+云端」是硬伤：该视图走
  `GET /api/v1/overview?union=[…]`，把两份「全网切片」相加 → **调用次数翻倍、金额被写成 0**。
  现改为按同一过滤条件取切片（与 `plugin-view` 同源实现 `totalsFiltered`）。
- 回归测试 `test/plugin-view.test.js` 增加 union 用例（断言 union 后的 `all.real` / `summary.realCost`
  等于各部分的**和**，且不重复计数）；插件侧 `test/cloud-view-e2e.test.js` 增加宿主实际调用形态的端到端断言。

### v1.2.0

- 新增**采集端只读「插件形状」聚合** `GET /api/v1/plugin-view`（设备令牌可读，`caps.devicePluginView=true`）：
  字段名与插件本地 `buildDashboard` 逐项一致（`today/month/all` 的 `real/sub/calls/tokens` +
  `byDay/byModel/byModelDay/recent`），支持 `union` 并集。此前只有 `/api/v1/overview` 的概览卡片，
  插件「仅云端」视图的消费柱状图、分模型明细与最近记录**注定为空**。
- **修复：`pluginView` 的三切片绕过过滤**（同上，见 v1.2.1 说明，两处一并修正）。
- **修复：日/月切片恒空** —— `buildWhere` 用 `Number.isFinite` 判断时间边界，传 `fromMs/toMs = 0`
  会生成 `ts < 0`（恒假），现传 `null`。
- **修复：`calls/tokens` 与订阅口径不互斥** —— 改为只含按量（`real_calls/real_tokens`），
  订阅另计 `subCalls/subTokens`，与插件本地口径一致（看板「API 请求次数」主值 = `calls + subCalls`）。
- `range=all` 时 `pluginView` 的日期轴按**数据实际起点**铺设，「全部」在云端视图里也是全部。

### v1.1.1

- 看板「概览」的时间范围按钮由「全时段」改称「**全部**」，概览卡片标题改为「**全部累计**」，
  与 DSH 插件的措辞统一（`web/state.js` / `web/app.js` / `src/time.js`）。
  **语义未变**：`range=all` 一直是 `fromMs = 0`（无下界），卡片上的「自 … 起」只是全库最早一条记录的日期。

### v1.1.0

- 新增**采集端只读查询接口** `GET /api/v1/overview | matrix | devices`：设备令牌（或共享引导令牌）即可读取
  聚合结果，供插件渲染「仅云端 / 本机+云端」视图。此前插件拿设备令牌去读 `/api/admin/*`，必然 `401 UNAUTHORIZED`。
  可用 `ALLOW_DEVICE_READ=false` 关闭（默认开启），关闭后返回 `403 DEVICE_READ_DISABLED`。

### v1.0.0

- 首个版本：多机 · 多 Agent 用量与花费云端汇总。内容哈希幂等上报、`seq` 增量水位、
  日汇总快照 + `absorbed` 墓碑（明细超期折叠后合计不变）、按设备/IP 限流；
  7 页原生看板（概览 / 设备×Agent / 设备 / 趋势 / 模型 / 记录 / 设置，无构建步骤）；
  Docker + 1Panel 部署物、INGEST-API 契约（中/英）与一致性自验脚本。
- 同版修复：看板整体不可用（按钮失效 / 永远加载中 / 数据到了却白屏）、`matrix`/`groups`
  响应缺 `ok:true` 导致前端 `api()` 抛错、compose `ports` 合并语义把 8787 绑到 `0.0.0.0`。

## License

MIT
