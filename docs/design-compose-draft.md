# 输入草稿暂存 — 设计文档

> 需求：会话 Tab 与引导页的输入框草稿，在切换到其他 Tab/工作区时保存未发送内容，再次切换回来时恢复。
> 参考先例：移动端 `../openbuilder/docs/design-compose-draft.md`（同名设计，2026 年已在 Flutter 端落地并多轮评审）。本文是其在桌面端的移植，按桌面组件模型调整；移动端踩过的坑（写草稿触发整页重建、恢复链断裂、跨 profile 泄漏）在 §4 决策中逐条对应。

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

- **D1 草稿放 AppStore，不新建存储/不持久化磁盘**。主场景（切 Tab/作用域往返）内存层即覆盖（移动端 D4 同结论）。桌面端 tab 记忆跨重启持久化（design-tab-memory），草稿**不随之持久化**——v0.1 范围外；移动端的磁盘层（并入会话缓存 blob、CD-23 写序竞态等一整套复杂度）不为边角场景（重启恰在输入中途）引入。重启丢草稿可接受，重连（SSE 对账）不丢（`teardownConnection` 只在显式 disconnect/切 profile/connect 走）
- **D2 写入不 emit**：见 §2.2，移动端"不 notifyListeners"的同构
- **D3 关 Tab 后重开不复活旧草稿**：关 chat Tab = 归档（锁定语义），是明确的收起决断；草稿随会话运行时同灭（移动端 §7「草稿随会话缓存生命周期」同源）
- **D4 回滚回填覆盖已存草稿**：回滚种子置入输入框经同一 `setDraft` 同步落 store，覆盖切走前暂存的草稿——对齐官方 app revert → `prompt.set(draft(messageID))` 语义（回滚本就替换输入框，与 design-message-revert §3.3 一致）
- **D5 引导页按作用域 key 隔离**：见 §2.4，接受 `pendingSession` 不跨作用域的副作用

## 5. 场景验证表

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
| 10 | 输入 → 重启应用 | 草稿丢失（D1：v0.1 不持久化） |
| 11 | 带草稿的会话发生回滚（他端/本端） | 输入框 = 回滚点消息文本（D4），旧草稿被替换 |
| 12 | 回滚回填后切走再回 | 回填文本仍在（经同步 effect 落 store） |
| 13 | 撤销回滚（空种子清输入框）后切走再回 | 输入框空（空种子 = 删条目） |

## 6. 不做的事（沿用移动端 §7 取舍）

- 附件草稿（v0.1 无附件功能）
- 草稿管理 UI（查看/清空全部）——发送即清、空即不存
- 草稿自动过期/TTL——随会话/目录生命周期清理（§3）
- 跨重启磁盘持久化（D1）

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `chatDrafts`/`guideDrafts` + 读写四方法（不 emit）；清理挂点：`closeTab` chat 分支、`cleanupSessionState`、`closeProject`/`closeGlobalDirectory`/`removeWorkspace`（引导页草稿随目录）、`teardownConnection` |
| `src/renderer/src/components/workspace.tsx` | ChatView/GuidePage 挂载读回 + 同步 effect；GuidePage 按作用域 key 隔离；AM-IMPL3-3 注释修订 |
| `src/renderer/src/store/app-store.test.ts` | store 级用例（读写往返/关 Tab 清/删会话清/关项目清引导页草稿） |
| `docs/spec-v0.1.md` / `docs/design-layout.md` | 范围与引导页/输入区条目同步指向本文 |

## 8. 验证记录（2026-08-26）

- vitest 309/309（新增 6 用例：读写往返 ×2、关 Tab 清、删会话清、关项目清引导页草稿、拆连接清空）；typecheck 双侧、build 全绿
- 实现中发现并修复同 commit 卸载陷阱（§2.3）：发送成功路径改显式清 store，不依赖 effect

review 一轮修订（2026-08-26）：

- 「失败重试复用同一会话」限定为引导页存活期内（§3 表/场景 3 拆分 3b；design-layout §4 引导页条目同步修订）——key 隔离后 `pendingSession` 不跨重挂载，孤儿会话由 design-tab-memory §17 补开吸收
- 补记双行目录取舍（§3）：草稿按 directory 键、不带 projectId 维度，与 Tab 记忆归属语义一致
- 补拆连接清草稿用例（切 profile 防串）
