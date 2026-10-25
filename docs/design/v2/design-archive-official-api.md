# 归档链路迁回官方 API（design-archive-official-api）

> 状态：已实施（2026-10-25）。参考来源：openbuilder `docs/design/v2/design-archive-metadata.md` §迁回官方归档 API（移动端已实施 2026-10-25，本文决策号引用均指该文档）。
> 触发：pin 升 2.1.3（`docs/ref/ref-pin-bump-2.1.3.md` §2），官方归档三件套回归——design-v2-migration D1 备案的迁移触发点成立。

## 问题

D1（design-v2-migration §交互语义决策点）把「关 Tab = 归档」定为 `metadata.archivedAt` 私约，定位为过渡桥接。私约的代价：

- 其他 v2 客户端不识别 marker（V2D-1），识别靠双源兼容垫着
- v1 迁移存量 `time.archived` 在 v2 无写入路径——「开 Tab = 取消归档」对这类会话不可持久（重连快照复活归档，D1 已知边界）
- metadata 是 REPLACE 语义，写入须整包合并，与他端 metadata 写入存在丢失更新窗口

2.1.3 补齐写路径 + 过滤 + 事件三件套（活体验证见 ref-pin-bump-2.1.3 §2）：

- `PATCH /api/session/:id` body + `archived: boolean | null`——`true` 置 `time.archived`、`false` 清除，重复当前状态 no-op；204 无 body
- `GET /api/session?archived=true|false` 服务端过滤
- `session.archived` / `session.unarchived` 事件（durable，payload `{sessionID}`，信封带 location）；活体发现：**事件 `created` 恰等于 `time.archived` 值**；归档会 touch `time.updated`
- 组合 PATCH（`archived` + `metadata` 同 body）204 通过、他端 metadata 键保留

移动端已迁回并给桌面端立了跨端约束（其决策 9）：**官方写路径切换后，取消归档必须继续清 marker（直至 marker 集合 drained）**——否则「旧 marker 会话 → 官方归档 → 官方取消归档」留下 marker-only，移动端 backfill 会误重新归档。

## 设计

### 1. 版本闸门与写路径分派

连接期探活已拉 `serverInfo()`（`GET /api/info`），增存 `archiveApiReady = !belowMinServerVersion(version, "2.1.3")`（连接期缓存，复用既有 semver 工具）。

- `archiveApiReady` → 官方写路径
- 否则 → 私约 marker 回退（现行 `patchSessionArchive` 路径原样保留）

与移动端不做回退的差异理由：移动端归档入口是会话菜单项（用户主动、失败可见可恢复，接受 2.0.x 剥离 `archived` 字段的复活限制）；桌面端「关 Tab = 归档」是**核心交互路径**——2.0.x 对 PATCH body 未知 `archived` 字段行为未验证（可能 400 拒绝、也可能剥离后 204），剥离结局是 Tab 已关但会话复活进可见列表，体验倒退（现状私约在 2.0.x 工作正常）。回退成本 = 现行代码不删，仅加一层分派。

### 2. 写路径（`patchSessionArchive` 分派）

官方路径：

- 归档（关 Tab）：`PATCH {archived: true}`。本地意外存 marker（双标态）时组合清——防御性，正常路径关 Tab 会话必未归档（Tab 开着 = 在可见列表 = 双源皆空）
- 取消归档（开 Tab）：`PATCH {archived: false}`；本地 marker 存在时组合 `{archived: false, metadata: …去 archivedAt}`——openbuilder 决策 9 跨端约束的落地，同时防本地双源判定残留（官方已取消归档但 marker 在，会话仍被本地判为归档）
- 本地乐观落地：置/清 `time.archived`（`Date.now()` 乐观值；SSE `session.archived` 的信封 `created`（权威，活体 = `time.archived`）或快照对账校正）；marker 清除同步落地
- **D1 已知边界消解**：v1 存量 `time.archived` 现有写入路径——`archived: false` 可清除，「开 Tab = 取消归档」对此类会话持久

### 3. 存量迁移 backfill（marker-only 转正）

- 判据：marker-only = `metadata.archivedAt` 为正数 && `!time.archived`
- 动作：组合 `PATCH {archived: true, metadata: …去 archivedAt}`——**转正 + 清标记一步到位**（openbuilder 决策 5：不清标记则官方取消归档后 marker 残留 → 双源误判永久不可见 + 移动端 backfill 误重新归档）
- metadata 基底取**快照权威值**（REPLACE 语义整包，不抹 `sessionId` 等他端键）
- 挂点：`applySessionsSnapshot` 尾部 fire-and-forget，扫描本次快照 `filtered`——开项目 `refreshSessionsForProject` 与对账（reconciler）两路快照全覆盖，幂等可重试，与移动端挂 `_fetchAllSessions` 同构
- **PATCH 前复查本地**（review 2026-10-25 🟡）：快照捕获后用户可能已开 Tab 取消归档（组合清 marker）——迟到的转正 PATCH 会重新归档并经 SSE 回声关掉刚开的 Tab。双条件防御：`chat:${id}` Tab 打开着（含 unarchive 在途窗口）或本地已非 marker-only 都跳过；残余窗口缩至单 RTT，接受
- 闸门与防御：`archiveApiReady` 才跑（openbuilder 决策 8 同款——旧服务器可能剥离 `archived` 字段，204 但 marker 被清而官方归档未置位，会话复活且无声）；in-flight flag 防重入（多目录快照并发到达）；单条失败吞掉记日志，下次对账重扫（marker 未清仍命中）
- 成功后本地落地：置 `time.archived` + 清 marker（免等下次快照收敛）

### 4. SSE 双事件（旁路模式）

`session.archived` / `session.unarchived` 是 durable 事件。与 `session.viewed` / `execution.*` / `revert.*` 同族**旁路处理**（前置闸门之前，按 sessionID 反查目录 + `isOpenedDirectory` 等效闸门）——信封 location 活体见带 directory，但旁路对缺 location 帧也正确（先例同款理由）。

- 已知会话：
  - `session.archived`：置 `time.archived = meta.created`（权威时间戳）+ 镜像清 marker（服务端组合 PATCH / backfill 已清，本地镜像收敛双源）→ `applySessionEvent`（归档收敛关 Tab 复用既有路径；`closingChatSessions` 抑制在 `applySessionEvent` 内既有——本端关 Tab 流程的 SSE 回环不抢先关）
  - `session.unarchived`：清 `time.archived` + 镜像清 marker → `applySessionEvent`
- 未知会话（快照未到窗口——桌面端归档会话不删 map，未知 = 冷启动竞态）：
  - 归档方向：忽略（对账快照兜底）
  - 取消归档方向：信封目录已打开 → 回源 `GET /api/session/:id` 取权威 info 落地（`applySessionEvent(info, info.location.directory)`）；否则跳过（未打开项目不开作用域，打开时快照拉来权威态）

`session.metadata.updated` 接线保留（过渡期：其他机器上的旧版桌面端仍写 marker，实时生效；下次对账 backfill 转正）。

### 5. 识别层与读路径不变

- `isArchivedSession` / `archivedAtOf` 双源**保留**（openbuilder 决策 6：旧版桌面端写 marker 窗口 + backfill 未跑完窗口，双读防漏网）。终态：marker 集合 drained 后双源与 `metadata.archivedAt` 识别可整体移除（todo-archive-marker-cleanup）
- 读路径维持**全量拉取**（`listSessions({directory, limit})` 不加 `archived` 参数）：桌面端 `archivedSessions` 引导页展示段依赖归档会话在 map——与移动端 `?archived=false` 服务端过滤策略的差异是产品面差异（移动端无已归档列表面；桌面端若改服务端过滤，归档段无数据，须另拉 `?archived=true` 增请求面，Keep Lean 不取）。backfill 扫描同样依赖全量快照（marker-only 被展示层过滤但须在扫描里可见，openbuilder 同款理由）

## 场景验证

| 场景 | 行为 |
|---|---|
| 关 Tab = 归档（≥2.1.3） | `PATCH {archived:true}` → 本地乐观置 `time.archived` → SSE `session.archived` 回声：已知→权威时间戳覆盖，关 Tab 收敛幂等 |
| 开 Tab = 取消归档（≥2.1.3） | `PATCH {archived:false}`（+marker 存在时组合清）→ 本地乐观清 → SSE `session.unarchived` 回声镜像落地 |
| v1 存量 `time.archived` 会话开 Tab | 官方 `archived:false` 清除——D1「重连快照复活归档」边界消解，取消归档持久 |
| 存量 marker-only 会话 | 快照落地 → backfill 组合 PATCH（转正+清 marker）→ 本地立即收敛为纯官方单源 |
| 前台期间他端官方归档 | `session.archived` 旁路 → 已知→关 Tab + 移入归档段（实时） |
| 前台期间他端官方取消归档 | `session.unarchived` 旁路 → 已知→双清恢复可见；未知→回源 GET 加回 |
| 2.0.x 服务器 | 写路径分派回私约 marker（行为与迁移前逐字节一致）；backfill 闸门跳过，marker 维持 |
| 他端旧版桌面端写 marker（过渡期） | `session.metadata.updated` 接线保留，实时生效；下次对账 backfill 转正 |
| backfill 失败（网络/会话已删） | 吞掉记日志；marker 未清，下次对账重扫重试 |

## 关键设计决策

1. **写路径版本分派、私约回退不删**（与移动端的差异点）：关 Tab = 归档是桌面端核心交互，2.0.x 剥离 `archived` 字段的复活结局不可接受；回退成本仅为保留现行代码。版本下限升 2.1.3 时随下限一并清理（todo-archive-marker-cleanup）。
2. **取消归档组合清 marker**：openbuilder 决策 9 跨端约束的落地——保移动端 backfill 判据正确，也防本地双源残留误判。
3. **backfill 挂 `applySessionsSnapshot` 尾部、扫描快照 `filtered`**：开项目 + 对账两路全覆盖（与移动端挂 `_fetchAllSessions` 同构）；metadata 基底取快照权威值，REPLACE 不抹他键。
4. **SSE 双事件旁路模式 + 镜像清 marker**：durable 帧旁路是 `session.viewed` 先例的既定模式；镜像清 marker 让本地双源在 backfill 未跑/他端组合写窗口内立即收敛单源视角。
5. **读路径维持全量拉取**：`archivedSessions` 展示段与 backfill 扫描共同依赖（§5）；不消费 `?archived=` 过滤参数是它的必然推论。
6. **双源识别过渡保留**：旧版桌面端写 marker 窗口 + backfill 未完成窗口需双读兜底；marker drained 后整体移除（todo-archive-marker-cleanup）。

## 不做的事

- `Project.Time.archived` / `GET /api/project?archived=` 项目级归档面（移动端同样不做，Keep Lean）
- `GET /api/session?archived=` 过滤参数消费（读路径全量的推论，§5）
- 双源识别立即收敛单源、私约写路径删除（todo-archive-marker-cleanup：marker drained / 版本下限升级时清理）
- 对 v1 存量 `time.archived` 的清理（本就是官方字段，无需动）

## 评审意见（2026-10-25，reviewer 子代理）

| 编号 | 严重度 | 问题 | 裁定 |
|---|---|---|---|
| AR-1 | 🟡 | backfill 与「开 Tab = 取消归档」自竞态：pending 判据取快照捕获值，循环内不复查——迟到的转正 PATCH 会重新归档刚被用户打开的会话并经 SSE 回声关 Tab（移动端无取消归档入口，同类竞态不存在） | **已修复**：循环内 PATCH 前复查本地（Tab 打开或本地已非 marker-only 即跳过），§3 入档；补测试「backfill 自竞态防御」 |
| AR-2 | 🟢 | 测试名声称「失败吞掉后下次快照重扫」但未覆盖 failure-retry 分支 | **已补**：独立用例（首次 reject → marker 保留 → 二次快照重扫成功收敛） |
| AR-3 | 🟢 | AGENTS.md / design 文档「todo」引用无落点 | **已补**：`docs/todo/todo-archive-marker-cleanup.md`（清理项/触发条件），两处字样改为指向该文件 |
| AR-4 | 🟢 | refetchSessionMeta「不整覆盖」注释只提 metadata.archivedAt 一源 | **已修**：注释补 time.archived 官方源 |

评审另核实（无问题）：2.0.x 回退路径与迁移前逐字节等价；archiveApiReady 生命周期（connect 复位/置位、disconnect 复位、探活失败不悬挂）；旁路闸门对未打开目录正确丢弃、refetchUnarchivedSession 不绕闸门；closingChatSessions 抑制路径仍成立；60s 对账整覆盖窗口与迁移前同构非回归；backfill 判据与移动端 AR2-1 双标态裁定相容、metadata REPLACE 不抹他键；in-flight 防重入/幂等/失败语义。
