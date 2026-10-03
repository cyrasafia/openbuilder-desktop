# 会话消息流向上滚动翻页（history pagination）— 设计文档

> 目标：消息流向上滚动接近顶部时自动加载更早的历史消息（每页 100 条），加载后视口锚定不跳动；顶部有加载指示，失败可点击/再次上滑重试；历史穷尽后不再请求。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-incremental-reconcile.md` —— 上滚触顶懒加载一页（`loadOnePage`）+ cursor 分页契约（`X-Next-Cursor`）+ 失败提示/链式加载（IR-1/IR-R4）+ 历史穷尽静默的完整设计
> - `openbuilder/docs/design-message-accumulation.md` —— REST 快照与 SSE 增量合并原则（不清空重置、窗口区间删除严格内部）
> - 本仓库 `message-merge.ts` `mergeSnapshotIntoMessages` 已实现「窗口区间删除严格内部」——更早分页消息天然在删除窗口之外，可安全累积

## 1. 问题

桌面端现状：`loadSessionMessages` 只拉最新 100 条（`limit=100`），`X-Next-Cursor` 响应头被丢弃。大会话（>100 条）在桌面端没有任何回看更早历史的途径。

## 2. 服务端契约（源码核对 `../opencode`，与移动端 1.18.3 实测一致）

`GET /session/{id}/message?directory=X`：

| 参数 | 行为 |
|---|---|
| 无 `limit` 或 `limit=0` | 全量返回，无 cursor 头 |
| `limit=N`（无 `before`） | 最新 N 条（ASC）；还有更早历史时响应带 `X-Next-Cursor` 头 + `Link` 头 |
| `limit=N` + `before=CURSOR` | 严格早于 CURSOR 锚点的下一页（更早 N 条，ASC）；到头则无 cursor 头 |
| `before` 不配 `limit` | 400 |
| `before` 非法（decode 失败） | 400 |

- cursor 值 `base64url(JSON({id, time}))`，锚定**本页最旧消息**；来自 DB 行，server 重启后仍有效；锚点消息被删除也不失效（仅作 `(time_created, id)` 比较锚，非 join）。
- 源码依据：`server/routes/instance/httpapi/handlers/session.ts` `messages` handler + `MessageV2.page`。
- 旧 server（忽略 `limit`）返回全量 + 无 cursor 头 → 客户端合并正确、判穷尽，天然降级。

## 3. 为什么不做移动端的「分段（segments）」模型

移动端 design-incremental-reconcile 的分段/断档来自两个桌面端不存在的来源：

1. **缓存预热**（`session.updated` 判断）——桌面端 v0.1 无消息本地持久化，不预热；
2. **多轮 reconcile 窗口不重叠**产生断档——桌面端消息全部来自三个通道：REST 最新窗口、REST `before` 分页、SSE 追加（只会更新/新增更晚消息）。三者合并进同一 flat map（`messagesBySession`），`mergeSnapshotIntoMessages` 的窗口区间删除是**严格内部** `(min, max)` 开区间：

- 最新窗口快照的 min 是窗口最旧消息 created；分页累积的更早消息 `created < min` → 永远不会被删除；
- `before` 页快照的 max 早于本地全部较新消息 → 较新消息不会被删除。

因此桌面端**无需分段模型**：cursor 单值（锚定当前最旧已加载消息）即可表达「还有更早历史」。这是对参考设计的简化而非语义走样——「断档不可滚过」在桌面端由「从未产生断档」保证。

## 4. 设计

### 4.1 REST 层（`rest-client.ts`）

```ts
interface MessagesPage { entries: MessageWithParts[]; nextCursor: string | null }

listMessagesPage(sessionID, directory, opts: { limit?: number; before?: string }): Promise<MessagesPage>
```

- `request` 现在不暴露响应头；抽出 `fetchResponse`（构建 fetch + 超时/错误分类），`request` 与 `listMessagesPage` 共用，后者多读一个 `X-Next-Cursor`。
- 现有 `listMessages` 保留（reconciler 消费，不需要 cursor）。

### 4.2 store 状态（`app-store.ts`）

```ts
interface SessionPageState {
  nextCursor: string | null   // 锚定当前最旧已加载消息
  exhausted: boolean          // 已确认历史穷尽（无 cursor 头 / 空页 / 零新增防御停链）
  loading: boolean
  error: boolean              // 上次分页/种子失败（下次尝试开始时清零，IR-R4）
}
sessionPages = new Map<string, SessionPageState>()
```

- 不变式：`exhausted ⇒ nextCursor == null`（逆命题不成立——`nextCursor == null` 为穷尽**或**可重试的 error 态，后者含挂载窗口加载失败的种子）。
- `canLoadEarlier(sessionID)`：有状态且 `!exhausted && !loading && !error`——UI 链式加载消费；error 态的**重试**走 `loadEarlierMessages` 显式入口（不视为"可继续加载"）。
- **`loadSessionMessages`（窗口加载）改为走 `listMessagesPage(limit=100)`**：
  - 合并逻辑不变（`mergeMessagePage`：快照合并 + pending parts 回放，返回本页新增条数）；
  - **cursor 只在缺失时写入**（不回退）：重激活重拉最新窗口返回的 cursor 锚定的是「最新 100 条的最旧」，比已分页深入的 cursor 新；回退会导致重复拉取已加载区间。
  - 窗口响应无 cursor 头（历史 ≤100 或旧 server）→ `exhausted: true`。仅当无既有状态时写入（已分页深入的会话不受重激活影响）。
  - **失败且无既有状态 → 写 error 种子**（cursor null + 未穷尽 = 可重试态）：空内容会话无滚动可言，error 行是其唯一重试入口。**error 种子的清除**（防"有内容却常驻失败行、链式被 error 态堵死"的矛盾态）：窗口加载成功时覆盖（该形状唯一标识"无分页进度可保护"）；对账 `onMessagesSnapshot` 回填成功时删除（回到无状态，走正常种子）。
- **`loadEarlierMessages(sessionID)`（上滚分页）**：
  - 无状态（挂载失败种子/断线重连后/SSE-only 会话）→ **先窗口加载种子 cursor**；种子失败置 `error`。种子成功且仍有历史 → 同一调用内继续 `before` 分页（用户手势一次见到更早消息；两次落地的锚定补偿见 §4.3 重新武装）；
  - 守卫：`loading` in-flight 去重；`exhausted` 直返（error 态允许重试）；
  - 在途落地按**状态对象身份**守卫：关 Tab 快速重开重建了新状态对象时，旧页整体丢弃（含消息合并，防写入新状态）；
  - 成功 → 合并 + 推进 cursor；`exhausted = 无 cursor 头 || 本页零新增`——后者防御违约 server（空/全重复页 + 非 null cursor）触发链式死循环；
  - 失败 → `error = true`（UI 提示），不穷尽、可重试。

### 4.3 UI（`workspace.tsx` ChatView）

- **触发**：`onScroll` 中 `scrollTop <= 64` → `maybeLoadEarlier()`（**store 侧守卫为权威**——in-flight/exhausted/error 语义全在 `loadEarlierMessages`，UI 不重复判定；无状态 = 种子路径，即挂载加载失败的重试入口）。
- **视口锚定（prepend 不跳动）**：触发时记录 `{ scrollHeight, scrollTop, headId }`（headId = 当前最旧 message id）；layout effect **只在头部真实增长**（headId 变化 **且** entries 变长）时消费补差：`scrollTop = 新 scrollHeight - 旧 scrollHeight + 旧 scrollTop`，随后**重新武装** anchor（以补差后的新几何为基准）——头部增长有分页与种子窗口两个来源，种子路径同调用内窗口 + before 两次落地，第二次 prepend 也须补偿（review P1 教训）。不消费/作废 anchor 的情形：
  - loading 指示行出现、底部流式增长等中间渲染（headId 不变）→ anchor 原地保留；
  - 头部 shrink（远端 `message.removed` 删了最旧消息）→ 陈旧 anchor 丢弃不补差；
  - 回到底部（pinned）→ anchor 作废（后续 prepend 由贴底逻辑接管）。
  现有 `pinnedToBottom` 为 false（用户在上滚）时底部吸附逻辑本就跳过，无冲突。
- **链式加载**：一页 100 条不足以填满视口（短消息会话）时，加载落地后复查 `scrollHeight <= clientHeight && canLoadEarlier` → 继续拉，直到填满/穷尽/失败（失败停链，IR-1）。
- **顶部指示行**（渲染在 `.message-list-inner` 头部，entries 之前）：
  - `loading` → spinner + 「加载更早消息」（w400 小字居中）；
  - `error && !loading` → 「加载失败，点击重试」（可点击 = `maybeLoadEarlier`；继续上滑同样触发；种子失败（cursor null + error）同样呈现）；
  - 穷尽 → 不渲染任何内容（极简，同移动端「不做的事」）。

### 4.4 i18n / 样式

- `loadingEarlier` / `loadEarlierFailed` 两条文案（中英，英文重写不翻译）。
- `.history-row`：居中、`--text-xs`、on-surface-variant；error 态可点击（cursor:pointer + hover）。

## 5. 场景验证

1. **小会话（≤100）**：窗口加载无 cursor → `nextCursor=null`，上滚无指示无请求。
2. **大会话首开**：窗口 `[m901..m1000]` + cursor_901 → 上滚分页 `[m801..m900]` … 直到无 cursor 头 → 穷尽。
3. **重激活不回退**：分页到 m501 后切走再切回，`loadSessionMessages` 重拉最新窗口（可能已是 `[m1101..m1200]`），cursor 仍锚 m501 侧；更早累积消息（m501..）不被窗口删除（严格内部）。
4. **SSE 流式中上滚**：分页合并不影响流式追加（排序层同一比较器）；`pinnedToBottom=false` 期间流式更新不抢滚动。
5. **失败重试**：断网分页失败 → error 提示；恢复后点击/上滑 → 重试成功，链条恢复。
6. **短消息链式**：一页不足视口 → 连续拉至填满。
7. **旧 server**：`limit` 被忽略返回全量、无 cursor 头 → 一次拉完、穷尽，行为等价现状。

## 6. 不做的事

| 项 | 原因 |
|---|---|
| 分段/断档模型 | §3：桌面端无缓存预热、无多轮窗口错位，断档不存在 |
| 「已到最早」提示 | 移动端同决策，极简 |
| 首屏「加载更早」手动按钮 | 上滚自动加载体验更顺 |
| 跨重启持久化分页进度 | 内存态即可：重开走 REST 快照 + 上滚恢复，成本一页请求 |
| 消息数上限/虚拟化 | 滚动性能优化是独立课题（移动端 scroll-perf 系列按需移植） |

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/rest-client.ts` | `fetchResponse` 抽取；`MessagesPage` + `listMessagesPage` |
| `src/shared/rest-client.test.ts` | 新增：cursor 头解析 / 无头判穷尽 / `before` 透传 / 400 透传 |
| `src/renderer/src/store/app-store.ts` | `sessionPages`（含 `exhausted`）；`canLoadEarlier`；`loadSessionMessages` 种子 cursor（不回退）；`loadEarlierMessages`（种子/身份守卫/零新增停链）；`mergeMessagePage`（返回新增数）；清理挂点 |
| `src/renderer/src/store/app-store.test.ts` | 新增 describe：种子/推进/穷尽/失败重试/去重/无状态种子路径/在途竞态丢弃/零新增停链/cursor 不回退 |
| `src/renderer/src/components/workspace.tsx` | ChatView 触顶触发 + 视口锚定 + 链式 + 顶部指示行 |
| `src/renderer/src/i18n/index.ts` | `loadingEarlier` / `loadEarlierFailed` |
| `src/renderer/src/styles/app.css` | `.history-row` |

## 8. 验收

- `npm run typecheck` / `npm run test` 全绿；
- 联调（`127.0.0.1:15120`）：大会话上滚分页流畅、位置不跳、穷尽后无请求；断连时提示与重试可用。
