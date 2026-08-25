# 回滚到指定消息（message revert）— 设计文档

> 目标：在会话中对某条用户消息「回滚到此」——server 暂存回滚点并**立即还原工作区文件**；回滚点之后的消息**从消息流中隐藏**待删，**发送下一条消息时提交**（server 删除这些消息）；期间可一键撤销回滚（unrevert，恢复文件与原状、消息重新显示）。
>
> 参考来源（按 AGENTS.md 约定先行检索）：
> - `openbuilder/lib/data/api/opencode_client.dart` `revert()` —— 移动端已实现 `POST /session/:id/revert` 封装，但**仅接口、未进 UI**（`openbuilder/docs/plan-overview.md` Phase 2「revert 仅接口、未进菜单」）。本次桌面端补齐完整交互
> - `../opencode` 官方 app：`packages/session-ui/src/components/message-part.tsx` —— 回滚入口只在**用户消息** hover 动作行（`ui.message.revertMessage`，reset 图标）；`packages/app/src/pages/session.tsx` `revertMutation` —— busy 时先 halt（interrupt）再 stage、乐观回填 composer 草稿（`prompt.set(draft(messageID))`）；`session-revert-dock.tsx` —— composer 上方回滚条
> - `../opencode` server：`packages/opencode/src/session/revert.ts`（revert/unrevert/cleanup 全部语义）、`session/prompt.ts:458`（下一条 prompt 时 cleanup 提交）

## 1. 需求

- 用户消息上提供「回滚到此消息」入口；
- 回滚暂存后：工作区文件立即还原到该消息之前的状态；回滚点及其后的消息**从消息流中隐藏**（将被删除；对齐官方 `visibleUserMessages` 过滤）；输入区回填该用户消息文本（可编辑重发）；composer 上方出现回滚条（可撤销）；
- 发送下一条消息 = 提交回滚：server 删除回滚点起的全部消息，回滚态清除；
- 撤销回滚（unrevert）= 恢复文件、清除暂存，被隐藏的消息重新显示；
- 会话进行中（busy/retry）点回滚：确认后先停止会话再回滚（对齐官方 `halt().then(stage)`）；
- 跨客户端/重连一致：回滚态随 `Session.revert` 字段走 SSE `session.updated` 与 REST 快照，天然同步。

## 2. 服务端契约（联调实测 + 源码核对）

实测环境：本机 opencode server `127.0.0.1:15120`（**1.18.20**），临时 git 目录会话即测即删。

### 2.1 端点

| 端点 | 语义 | 响应 |
|---|---|---|
| `POST /session/{id}/revert?directory=` body `{messageID, partID?}` | 暂存回滚：立即还原文件（快照恢复 + 逆向 patch），写 `session.revert` | 200 更新后的 Session；busy/retry 时 409 `SessionBusyError` |
| `POST /session/{id}/unrevert?directory=` | 撤销暂存：恢复快照、清 `session.revert` | 200 更新后的 Session（`revert: null`）；busy 时 409 |
| `POST /session/{id}/abort?directory=` | busy 中回滚的前置停止 | **等待 run 完全停止后才响应**（源码核对：`run-state.cancel` await `Fiber.interrupt` 并置 Idle）——abort 返回即非 busy，紧接的 revert 无 409 竞态窗口 |

契约源：`../openbuilder/opencode_openapi.json` `session.revert` / `session.unrevert`（v1 instance 路由，与移动端同源；**不用** v2 `/api/session/:id/revert/stage|commit|clear`）。

### 2.2 实测记录

1. `POST revert {messageID: <user msg>}` → 200：`revert: { messageID, snapshot: "<sha>", diff: "" }`（无 partID 时不出现），`summary: { additions, deletions, files }` = 被回滚区间（messageID ≥ 回滚点）的改动汇总；
2. 会话处于 **retry 态**（配额耗尽退避）时 revert → **409** `{"_tag":"SessionBusyError","message":"Session is busy: ..."}` —— retry 与 busy 同等拒绝；`abort` 终止退避后再 revert 成功；
3. `POST unrevert` → 200，`revert: null`；
4. SSE：staging/unrevert 均广播信封 `session.updated`（info 含 `revert`/`summary`）；staging 另有 `session.diff` 事件（本端不消费——回滚信息已随 session.updated 到达）；
5. 提交时机（源码核对）：`prompt.ts` 每轮 prompt 起始调用 `SessionRevert.cleanup` —— 删除 `id >= revert.messageID` 的全部消息（带 partID 时仅截断该消息 partID 起的 parts），然后 `clearRevert`。即**消息删除只发生在下一条 prompt**，客户端经既有 `message.removed` / `session.updated` 事件被动收敛，无需专门处理。

### 2.3 回滚点归属（源码 `revert.ts`）

- 回滚 user 消息：回滚点 = 该消息自身（其后全部删除）；
- 回滚 assistant 消息：回滚点 = 该轮最近的 user 消息（整轮回滚）。
- 因此 UI 入口**只放用户消息**（与官方 session-ui 一致），无歧义。

## 3. 客户端设计

### 3.1 REST（`rest-client.ts`）

```ts
revertMessage(sessionID, directory, messageID): Promise<Session>   // POST /session/:id/revert
unrevertSession(sessionID, directory): Promise<Session>            // POST /session/:id/unrevert
```

默认 15s 超时。409 经 `ApiError` 透传（调用方映射文案）。

### 3.2 类型（`api-types.ts`）

```ts
export interface SessionRevert { messageID: string; partID?: string; snapshot?: string; diff?: string }
// Session 增补：
revert?: SessionRevert | null
summary?: { additions: number; deletions: number; files: number }
```

（此前靠 `[k: string]: unknown` 透传；显式声明以便消费。）

### 3.3 Store（`app-store.ts`）

- `revertToMessage(sessionID, messageID): Promise<{ok, error?}>`
  - busy/retry（`isSessionActive`）：**先 `abortSession` 再 revert**（官方 halt→stage 语义）。UI 侧在 busy 时先 confirm（停止会话不可逆，区别于暂存本身可撤销）；
  - 成功：`mergeSessionUpdate(响应 Session)`（乐观落地，不等 SSE）+ 回填草稿（见下）；
  - **响应无 `revert` 字段 = server 未暂存**（消息已不存在，如他端先行删除/提交；源码 `revert.ts` `if (!rev) return session`）：不回填、返回 `{ok:false}` + `connectionError`「回滚未生效」明示——不得静默 ok；
  - 失败：`connectionError` 记录（左栏状态行可见）+ 返回 `{ok:false}`。409 专映射「会话进行中」文案。
- `unrevertSession(sessionID): Promise<{ok, error?}>`：同上合并路径。
- **草稿回填**（官方 `prompt.set(draft(messageID))` 语义）：成功后取回滚点 user 消息的 text parts 拼文本存 `revertDrafts: Map<sessionID,string>` 并 `revertDraftVersion++`；ChatView effect 消费（`takeRevertDraft`）置入输入框。无 text（纯附件/命令回显）则不回填。
- **撤销清输入框**（官方 `restore→promptSession.reset()` 语义）：仅当种子**已被消费**（`revertDraftConsumed` 集——输入框正承载本地回填文本）时置**空种子**（`""`），ChatView 消费即清空草稿。**跨客户端暂存**（本端从未回填）或无文本回滚不置种子——不得误清用户自输内容。空种子本身不记消费（防二次撤销误判）。
- 清理：`teardownConnection` 与 `cleanupSessionState` 清 `revertDrafts`/`revertDraftConsumed`。
- 事件侧零改动：`session.updated` 已合并含 `revert` 的 info（跨客户端/重连一致）；提交时 `message.removed` 逐条删除已有处理；分页游标锚定最旧消息，尾部删除不影响。

### 3.4 UI（`workspace.tsx` ChatView）

- **入口**：紧贴用户气泡左侧、纵向居中的 hover 动作行（`.msg-actions` 为 `.msg.user` flex 子项、DOM 序先于气泡，`align-items: center` 居中；常驻占位 + opacity/visibility 显形——显隐零布局位移），`RotateCcw` 图标按钮 + tooltip「回滚到此消息」；乐观气泡与空文本消息不显示。
- **回滚条**（`RevertBar`，composer 内、textarea 上方）：`session.revert` 存在时渲染——文案「已回滚：回滚点起 N 条消息将在发送后删除」+ 按钮「撤销回滚」（`btn-tonal`）；busy 时按钮禁用（409 前置防御）。
- **隐藏**：`message id >= revert.messageID` 的消息从渲染列表剔除——纯函数 `filterRevertedEntries`（`message-merge.ts`，含边界单测；乐观消息恒显）——对齐官方 timeline 只渲染 `visibleUserMessages`（`session.tsx:2109`）。纯呈现层：store entries 不动，撤销回滚即恢复显示；分页头部基准/游标不受尾部隐藏影响。滚动布局 effect 依赖切到 `visibleEntries`——隐藏尾部引起条数变化时贴底重定位仍触发（条数减少走 auto 无动画）。回滚条计数 = `entries.length - visibleEntries.length`（与隐藏共用同一边界，无二份比较逻辑）。
- **跨客户端覆盖窗口**：他端暂存的回滚点可能早于本端已加载窗口（此时全部已加载消息被隐藏、计数偏小）——ChatView effect 检测「无已加载消息落在回滚点之前」即持续 `loadEarlierMessages`，直到窗口覆盖回滚点或历史穷尽（复用分页 loading/exhausted/error 守卫）。本地发起的回滚不受影响（回滚点必然已加载）。
- **busy confirm**：`confirm(t.confirmRevertBusy)` 通过才走 store（同 `confirmCloseStreamingTab` 模式）。

### 3.5 i18n（zh/en 对称）

`revertToHere` 回滚到此消息 / Revert to here；`unrevert` 撤销回滚 / Undo revert；`revertBarHint` 已回滚：回滚点起 {count} 条消息将在发送后删除 / Reverted: {count} messages from this point will be removed on next send；`confirmRevertBusy` 会话进行中，回滚将先停止会话。继续？/ Session is running — reverting stops it first. Continue?。409（仍 busy）文案走 store `connectionError` 映射（左栏状态行），不入 catalog。

## 4. 明确不做

- **partID 级回滚**（半条消息）：官方仅 timeline 编辑场景用；本端无 part 级入口；
- **逐条 restore**（官方 revert dock 的 per-item 恢复）：v1 只给整体撤销（unrevert）；
- **回滚 diff 详情展示**：`session.summary`/`revert.diff` 只作契约记录，改动查看走既有改动 Tab；
- 回滚的快捷键体系（随 v0.2+ 快捷键整体规划）。

## 5. 验收

1. 空闲会话点用户消息「回滚到此消息」：文件即还原（工作区改动消失）、该消息起从消息流消失、回滚条出现、输入框回填该消息文本；
2. 回滚条「撤销回滚」：文件恢复、被隐藏消息重新显示、回滚条消失、**输入框清空**（回填文本随撤销清除；跨客户端暂存/无回填会话不清用户自输内容）；
3. 回滚态下发送新消息：回滚点起消息正式删除（`message.removed`）、回滚态清除、新轮次正常；
4. busy 中点回滚：确认后停止并回滚成功；取消则无副作用；
5. 重连/切 Tab 回来：回滚态仍在（`Session.revert` 随快照）；
6. 跨客户端：TUI/他端触发的回滚经 `session.updated` 在本端同样呈现。
