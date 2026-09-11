# 输入草稿暂存 — 设计文档

> 需求：会话 Tab 与引导页的输入框草稿，在切换到其他 Tab/工作区时保存未发送内容，再次切换回来时恢复；**关闭应用再打开仍保留（2026-09-11 增补，§5 磁盘层）**。
> 参考先例：移动端 `../openbuilder/docs/design-compose-draft.md`（同名设计，2026 年已在 Flutter 端落地并多轮评审，含磁盘层）。本文是其在桌面端的移植，按桌面组件模型调整；移动端踩过的坑（写草稿触发整页重建、恢复链断裂、跨 profile 泄漏、键入高频磁盘写放大）在 §4 决策中逐条对应。

## 1. 现状与病灶

- `ChatView` 的草稿是组件局部 `useState`。Tab 切换经 `key={active.key}` 隔离（防跨会话 fiber 残留，见 workspace.tsx 注释），切走即卸载、局部 state 随之销毁——切回时输入框恒空
- `GuidePage` 同理：任何 Tab 激活即卸载；且它原来**无 key**，跨作用域切换（两个作用域都无激活 Tab 的窗口）fiber 存活，局部草稿会串到另一作用域
- 作用域（项目/工作区）切换经 `restoreScopeTabs` 改换激活，同样触发卸载

即：草稿丢失是「卸载即失忆」的结构性结果，必须把草稿提升到跨卸载存活的层——store。

## 2. 方案

### 2.1 store 数据（app-store.ts）

```ts
private chatDrafts = new Map<string, string>()   // sessionID → 未发送文本
private guideDrafts = new Map<string, string>()  // 作用域目录 → 未发送文本
private draftsState: Record<string, { chat: …; guide: … }> = {}  // 磁盘层切片（§5）
```

- 键选择与移动端一致：sessionID 是 server 分配的 UUID，全局唯一（移动端 D6）；引导页按作用域分（每作用域一个引导页），故按目录
- 空文本写入 = 删条目（发送成功/清空即不留痕，Map 有界）
- 读 `chatDraftFor/guideDraftFor`（无条目 = 空串）、写 `setChatDraft/setGuideDraft`

### 2.2 写入不 emit（移动端"不 notifyListeners"的同构约束）

App 根组件 subscribe store、`emit()` 即整树重渲染。草稿随键入高频变化，写 store 若 emit = 每次击键全树重建（移动端对应病灶：草稿变化不得触发整页消息列表重建）。故 `set*Draft` **不 emit**——草稿无渲染订阅者：视图只在挂载时读一次，挂载期间由组件局部 state 驱动输入框。

### 2.3 UI 同步（workspace.tsx）

ChatView / GuidePage 同一模式：

1. 挂载初始化读回：`useState(() => store.chatDraftFor(sessionID))`（引导页 `guideDraftFor(directory)`）
2. 单一 effect 在每次 `draft` 提交后同步 store：`useEffect(() => store.setChatDraft(sessionID, draft), [draft, sessionID])`

所有改草稿的路径（键入、发送成功置空、失败回填、回滚种子回填、命令补全）都经 `setDraft` → 同步 effect 落 store，无分支遗漏；切走卸载前 store 必已是最新值，切回重挂载即恢复（键入是离散输入事件，React 在处理下一个离散事件前必先 flush 待定 passive effect，故"键入后立即点 Tab"不会丢最后一次击键）。

**同 commit 卸载陷阱（实现实测）**：`setDraft` 与组件卸载发生在**同一 commit** 时，React 丢弃卸载组件的待定 passive effect——同步 effect 不会执行。引导页发送成功即触发：`setDraft("")` 后 `openChatTab` 使引导页当帧卸载，若只靠 effect 清 store，已发送文本会残留、关 Tab 回引导页复活。故**发送成功路径在 handler 内显式 `set*Draft(…, "")`**（ChatView/GuidePage 同构），不依赖 effect。其余同 commit 卸载窗口（如键入末帧恰遇 SSE 关 Tab）至多丢最后一次未 flush 的击键，best-effort（与移动端 CD-23 同类取舍）。

### 2.4 GuidePage 按作用域 key 隔离

`{!active && <GuidePage key={scopeDir} />}`。原实现无 key（AM-IMPL3-3 记录 fiber 跨作用域存活），草稿按目录存取后该存活会成为串用源（A 作用域的草稿显示在 B）。key 隔离后：

- 切作用域重挂载，草稿各归其目录
- 副作用：`pendingSession`（发送失败待重试的会话引用）不再跨作用域存活。可接受——该孤儿会话已由 design-tab-memory §17 的恢复补开吸收为可见可管理的 Tab（该文档 §17「为什么不复活用户关掉的 Tab」段已记录此形态）；ModelSwitcherBar 仍取会话自身目录作防御

## 3. 生命周期与清理点

| 事件 | 动作 |
|---|---|
| 发送成功 | `setDraft("")` → 同步 effect 删条目（不残留，移动端场景 2） |
| 发送失败 | 草稿保留（本地 + store 一致）；重试复用 `pendingSession` 仅限引导页存活期内（切 Tab/作用域即重挂载丢失引用，重试按新会话发送，孤儿会话由 design-tab-memory §17 补开吸收，见 §2.4） |
| 关 chat Tab（显式关闭/死会话收敛/session.deleted） | `closeTab` chat 分支删条目——死会话收敛路径只经 `closeTab` 不经 `cleanupSessionState`，须在此清 |
| 会话运行时卸载（关项目/删工作区/删会话） | `cleanupSessionState` 删条目 |
| 目录卸载（`closeProject`/`closeGlobalDirectory`/`removeWorkspace`） | 删对应目录 `guideDrafts`（chat 草稿已经 `closeTab`/`cleanupSessionState` 覆盖） |
| 拆连接/切 profile（`teardownConnection`） | 两 Map 全清——与 tabs、revertDrafts 同寿命，杜绝跨 profile 泄漏（移动端 CD-24/30：丢远轻于串） |

**双行目录取舍**：引导页草稿只按 directory 键，不带 projectId 维度——双行目录（git 项目与 global 会话同路径）下两个作用域共用一条草稿，且 `closeProject` 会连 global 侧草稿一并清除（该目录的 Tab 记忆归属同一解析规则，见 design-tab-memory §3.1「directory 单个 server 内唯一归属一个项目」与 `findProjectOwningDirectory`）。与 Tab 记忆的目录归属语义保持一致，不为边角形态引入第二套键维度；双行目录本身罕见，损失一条未发送草稿可接受。

## 4. 决策记录

- **D1 草稿放 AppStore，内存层是唯一运行时权威；磁盘层是派生投影（2026-09-11 修订，原「不持久化磁盘」决策废止）**。主场景（切 Tab/作用域往返）内存层即覆盖（移动端 D4 同结论）。原 v0.1 决策以「重启恰在输入中途是边角场景」为由不做持久化——需求变更（用户要求重启保留）+ 移动端磁盘层先例已落地，废止该取舍。实现不搬移动端的「并入会话缓存 blob」路线（桌面无该 blob，且会引入 CD-23 写序竞态一类复杂度），而是复用桌面既有持久层模式：`store.json` 单键 `drafts.state`、profileKey 分切片（同 `tabs.memory`/`project.state` 键维度）、序列化快照去重（同 `persistTabSession`）。写放大防护沿用移动端 D3 结论：键入高频只写内存，磁盘写 500ms 去抖收尾 + 关键时机即时冲刷（§5）
- **D2 写入不 emit**：见 §2.2，移动端"不 notifyListeners"的同构
- **D3 关 Tab 后重开不复活旧草稿**：关 chat Tab = 归档（锁定语义），是明确的收起决断；草稿随会话运行时同灭（移动端 §7「草稿随会话缓存生命周期」同源）
- **D4 回滚回填覆盖已存草稿**：回滚种子置入输入框经同一 `setDraft` 同步落 store，覆盖切走前暂存的草稿——对齐官方 app revert → `prompt.set(draft(messageID))` 语义（回滚本就替换输入框，与 design-message-revert §3.3 一致）
- **D5 引导页按作用域 key 隔离**：见 §2.4，接受 `pendingSession` 不跨作用域的副作用

## 5. 磁盘持久层（2026-09-11 增补）

覆盖「关闭应用再打开仍保留」。数据落 `store.json` 键 `drafts.state`：`profileKey → { chat: { sessionID → 文本 }, guide: { 目录 → 文本 } }`（`StoreShape` 新增键，条目值恒非空串——空 = 删条目，同内存层语义）。内存 map 始终是**当前 profile** 的投影：

### 5.1 读（播种）

`doInit` 读入 + 校验（坏切片/坏条目丢弃等效无记录，同 `sanitizeTabSessionMap` 口径）→ **connect 时**（`doConnect` 的 `teardownConnection` 之后）从本 profile 切片播种内存 map。播种位置在连接探针之前：连接失败（server 未起）也已播种入内存——但连接未成功时无项目数据（Workspace 空态）、无 composer 挂载，草稿**待连接成功后随视图挂载才可见**（可见性与持久性分离：内存已恢复，丢不了）。视图层零改动——ChatView/GuidePage 挂载读 `chatDraftFor/guideDraftFor` 的既有链路天然吃到播种。

### 5.2 写（去抖 + 即时冲刷）

- **键入/清理点**（`set*Draft`、关 Tab、目录卸载等全部内存变更点）→ `scheduleDraftPersist()`：500ms 尾随去抖，收尾时 `flushDrafts()` 一次（移动端 D3 同结论：高频 onChanged 只写内存）。清理点与键入共用窗口——清理是低频单发动作，500ms 延迟落盘无观察面（内存已清，重启前必有去抖/冲刷落地其一）
- **teardown（disconnect/切 profile）**：清空**前**按**连接切片键**（`sessionProfileKey`，非 `activeProfileId`——切 profile 时后者已指向新 profile）即时冲刷——断连/切走不丢，重连/切回经播种原样恢复；内存清空语义不变（CD-24/30 防串由「冲刷后清 + 播种各归切片」共同保证）
- **退出（关窗/退出应用）**：去抖定时器不再有机会落地——renderer 在 `pagehide`/`beforeunload` 即时冲刷（幂等）；main 侧 `will-quit` 对 store 内存缓存**同步写**兜底（pagehide 的 `store:set` 可能仍在异步写队列里排队，退出会截断写队列；store.json 为 KB 级小 JSON，同步写阻塞可忽略）

`flushDrafts` 带两道闸门：① 序列化快照去重（无变化不落盘，同 `persistTabSession`）；② `client == null 且两 map 皆空` 时跳过——teardown 后/播种前的迟到定时器不得把空 map 写成空切片覆盖磁盘（teardown 已在清空前冲刷过，此处无新信息）。

### 5.3 清理语义（磁盘与内存同灭）

§3 全部清理点（发送成功、关 Tab、会话卸载、目录卸载）在删内存条目同时触发去抖落盘——**重启不复活已发送/已关闭/已卸载的草稿**。已知残留：应用未运行期间他端删除会话/目录，对应切片成孤儿（无事件可达，仅占字符串体积）；正常路径（运行中删除）经 SSE 事件清理。不做主动清扫（Keep Lean）。

### 5.4 best-effort 边界

- 崩溃/强杀丢窗 ≤ 去抖窗口（500ms）——与移动端 CD-4「不为强杀于输入中途做额外复杂度」同取舍。**正常退出同为 best-effort 上界、不承诺零丢失**：pagehide 冲刷的 IPC 在关闭中的渲染帧上不保证必达 main（Electron 无此保证），`will-quit` 同步写只兜底**已达 main 缓存**的写——最坏情形与崩溃同界（最后 <500ms 击键丢失）
- 单写者（去抖定时器串行收尾 + 冲刷点同步执行），无移动端 CD-23 的 `setString` 乱序竞态面
- 引用（fileRefs）与附件不持久化：仅文本草稿（附件含 data URL 体积大，重启重拖成本低）

## 6. 场景验证表

| # | 场景 | 行为 |
|---|---|---|
| 1 | 会话 A 输入 → 切会话 B → 切回 A | A 草稿原样恢复（含光标文本、不 trim） |
| 2 | 输入 → 发送成功 → 切走再回 | 输入框空（条目已删） |
| 3 | 发送失败（断线）→ 停留在引导页重试 | 草稿保留，复用同一会话（`pendingSession` 未随卸载丢失）；会话 Tab 内失败则直接重发 |
| 3b | 发送失败 → 切走再回引导页 | 草稿恢复；但重挂载丢失 `pendingSession`，重试按新会话发送，旧会话经 design-tab-memory §17 补开为可见 Tab（§2.4 已知取舍） |
| 4 | 引导页输入 → 开/切 Tab → 回引导页（"+" 或关尽 Tab） | 草稿恢复 |
| 5 | 作用域 A 引导页输入 → 切工作区 B → 切回 A | A 草稿恢复；B 引导页独立空态（key 隔离，不串用） |
| 6 | 输入 → 关 Tab（归档）→ 引导页卡片恢复会话 | 输入框空（D3） |
| 7 | 输入 → 他端删除该会话 | 条目经 `closeTab`+`cleanupSessionState` 清除，无泄漏 |
| 8 | 输入 → 关闭项目/删工作区 → 重开 | 草稿不恢复（目录卸载清除），首次打开语义 |
| 9 | 输入 → 断线重连（SSE 对账） | 草稿仍在（不走 teardown） |
| 9b | 输入 → 显式断开/切 profile → 重连/切回 | 草稿恢复（teardown 清空前冲刷，播种读回；各 profile 切片独立不串） |
| 10 | 输入 → 重启应用 | 草稿恢复（§5 磁盘层：connect 播种；引导页/会话 Tab 同） |
| 10b | 重启后关 Tab（归档）/关项目/删工作区 | 磁盘条目随清理点同灭，再重启不复活（§5.3） |
| 11 | 带草稿的会话发生回滚（他端/本端） | 输入框 = 回滚点消息文本（D4），旧草稿被替换 |
| 12 | 回滚回填后切走再回 | 回填文本仍在（经同步 effect 落 store） |
| 13 | 撤销回滚（空种子清输入框）后切走再回 | 输入框空（空种子 = 删条目） |

## 7. 不做的事（沿用移动端 §7 取舍）

- 引用/附件草稿持久化——仅文本（§5.4；v0.4 已有附件功能，但引用/附件是内存层，重启不恢复）
- 草稿管理 UI（查看/清空全部）——发送即清、空即不存
- 草稿自动过期/TTL——随会话/目录生命周期清理（§3/§5.3）
- 孤儿切片主动清扫（§5.3 已知残留，不做）

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `chatDrafts`/`guideDrafts` + 读写四方法（不 emit）；清理挂点：`closeTab` chat 分支、`cleanupSessionState`、`closeProject`/`closeGlobalDirectory`/`removeWorkspace`（引导页草稿随目录）、`teardownConnection`；磁盘层（§5）：`draftsState`/`scheduleDraftPersist`/`flushDrafts`/`seedDrafts` + doInit 读入 + doConnect 播种 + pagehide/beforeunload 冲刷 |
| `src/renderer/src/components/workspace.tsx` | ChatView/GuidePage 挂载读回 + 同步 effect；GuidePage 按作用域 key 隔离；AM-IMPL3-3 注释修订（磁盘层零组件改动） |
| `src/renderer/src/store/app-store.test.ts` | store 级用例（读写往返/关 Tab 清/删会话清/关项目清引导页草稿）+ 磁盘层用例（去抖落盘/快照去重/关 Tab 落盘删除/teardown 冲刷/connect 播种） |
| `src/shared/ipc.ts` | `StoreShape` 新增 `"drafts.state"` 键 |
| `src/main/ipc.ts` | `will-quit` 同步写兜底（§5.2 退出路径） |
| `docs/spec-v0.1.md` / `docs/design-layout.md` | 范围与引导页/输入区条目同步指向本文 |

## 9. 验证记录（2026-08-26）

- vitest 309/309（新增 6 用例：读写往返 ×2、关 Tab 清、删会话清、关项目清引导页草稿、拆连接清空）；typecheck 双侧、build 全绿
- 实现中发现并修复同 commit 卸载陷阱（§2.3）：发送成功路径改显式清 store，不依赖 effect

review 一轮修订（2026-08-26）：

- 「失败重试复用同一会话」限定为引导页存活期内（§3 表/场景 3 拆分 3b；design-layout §4 引导页条目同步修订）——key 隔离后 `pendingSession` 不跨重挂载，孤儿会话由 design-tab-memory §17 补开吸收
- 补记双行目录取舍（§3）：草稿按 directory 键、不带 projectId 维度，与 Tab 记忆归属语义一致
- 补拆连接清草稿用例（切 profile 防串）

2026-09-11 磁盘层增补验证：

- vitest 929/929（新增 4 用例：去抖落盘 + 快照去重、关 Tab 落盘删除、teardown 按连接切片键冲刷、connect 播种恢复）；typecheck 双侧全绿
- 组件层零改动（播种对 ChatView/GuidePage 透明）；main 侧 will-quit 兜底为进程生命周期钩子，不走单测（Electron `app` 依赖），联调口径见 §6 场景 10
