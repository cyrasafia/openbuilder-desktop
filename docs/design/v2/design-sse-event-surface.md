# v2 SSE 事件面迁移：审计与收敛策略 — 设计文档

> 目标：以 2026-10-07 活体 bug（回滚暂存后发送新消息，新消息不显示）为触发案例，落档三件事：① v1→v2 事件模型差异的系统表述（为什么 v1 的收敛前提在 v2 失效）；② v2.0.18 SSE 事件面全量审计矩阵（事件 × 发布者 × 客户端消费状态）；③ 状态收敛的通用模式（三层防御）与升 pin 审计流程。本文档是事件面契约基线，后续接事件/升 pin 以此核对。
>
> 参考来源：上游 v2.0.18 tag 源码核对（`packages/schema/src/*-event.ts`、`packages/core/src/`、`packages/server/src/`）；本仓库 M6c 迁移记录（commit `4bcc67f`）；design-message-revert（v1 时代收敛前提的原始记载）；design-v2-migration §SSE 与对账重设计。

## 1. 触发案例与根因链

**症状**：会话内「回滚到此消息」暂存后，编辑草稿再发送——新消息与回复均不显示，回滚条滞留；约 60s 后（周期对账）消息突然出现。

**根因链**（四环，缺一不病）：

1. **展示门控读本地合成状态**：`workspace.tsx:1316` 取 `findSession().revert?.messageID`，`message-merge.ts:123` 按 `id >= revertMessageID` 隐藏消息（消息 id 升序字典序可比，见 §2.4）。
2. **本地 revert 只有两个写入点**：`revertToMessage`（stage 响应合并，`app-store.ts:4171`）与 `unrevertSession`（clear 响应合并，`app-store.ts:4206`）。发送路径（`sendPrompt`/`sendCommand`）不清，SSE 路径无人接。
3. **server 提交只发一张事件**：下一条 prompt 时 `SessionRevert.commit` 仅发布 durable 事件 `session.revert.committed`（`session.ts:165-166`）；真正删消息 + 清 revert 的是 projector 异步批量 DB 删除（`projector.ts:744-775`）——**不发 v1 形状的 `session.updated`，也不发逐条 `message.removed`**。客户端三个事件分发层（`applyV2StreamEvent`/`applyV2SessionEvent`/`handleEvent` switch）均无此 case，事件按未知类型静默丢弃。
4. **新消息必然命中过滤**：新 user 消息与 assistant 流式回复的 id 均升序生成，恒大于 `revertMessageID` → 整轮被隐藏；同时 `refreshMessagesAfterPrompt` 发现投影落地后精确清除乐观副本（`app-store.ts:2003-2006`）→ 连乐观气泡都没有。

**「自愈」假象**：60s 对账/重连的会话快照整条替换 session 记录（`session-merge.ts:21`），且 `toInternalSession` 丢弃 `revert` 字段（`v2-adapter.ts:33-50`）→ 过滤解除。这解释了偶发性观感，也暴露了伴生缺陷：**本端已暂存的回滚态同样会被任意快照刷新抹掉**（回滚条消失、隐藏消息复现，但 server 侧仍 staged，下次发送仍会提交删除）。

**历史成因**：design-message-revert 按 v1（1.18.20）撰写，§3.3 前提是「提交时 `message.removed` 逐条删除已有处理、`session.updated` 带 revert」；M6c（2026-09-29）删掉 `message.removed` case 时未发现该前提已整体失效。

## 2. v1 → v2 事件模型差异

### 2.1 会话状态：统一全量事件 → 细粒度专项事件（本质差异）

- **v1**：会话任何状态变化都广播同一个 `session.updated`，载荷是**完整 Session 对象**（标题、回滚态、归档……全在其中）。客户端不需要知道改了什么，覆盖即可；漏听若干条也无害（下一条全量自愈）。
- **v2**：拆成一组具名事件（`session.renamed` / `session.metadata.updated` / `session.revert.staged`……），每个只带一项变化。客户端必须为关心的每一项写显式 case——**漏接哪项，哪项就永久停在旧状态**（本次 bug 的直接成因）。

### 2.2 消息：入口与删除方式变化（消息本身两边都是增量）

- **用户消息入口**：v1 `message.updated`（role=user 分支）→ v2 `session.inbox.enqueued` / `delivered`（M6c 已换绑）。
- **助手流式**：v1 part 增量（`message.part.updated`）→ v2 更细的 `session.step.*` / `session.text.*` / `session.reasoning.*` / `session.tool.*` 事件族（M4a 翻译层已接）。
- **消息删除**：v1 逐条 `message.removed` 通知 → v2 回滚提交是 projector **静默批量删**，只发一张 `session.revert.committed`。删了哪些，客户端要重拉清单才知道（既有 `mergeSnapshotIntoMessages` 窗口开区间删除即此用途，见 §4.4）。

### 2.3 事件改名：`session.next.*` 中缀移除

v1.18.x 的 `session.next.agent.switched` / `session.next.model.switched` / `session.next.revert.*` 在 v2.0.18 改名为 `session.agent.selected` / `session.model.selected` / `session.revert.*`。客户端仍监听 v1 名的 case 永不触发（§3 表 D）。**新接事件必须标注 pin 版本**，升 pin 时 grep 复核。

### 2.4 附带事实：消息 id 单调可比较

v2 消息 id = `msg_ + ascending()`（`packages/schema/src/identifier.ts`：时间戳×0x1000+计数器，ULID 变体）——升序、字典序可比。这是 `filterRevertedEntries` 按 `id >=` 过滤的语义依据，也保证「提交后新消息 id 必然大于回滚点」。

### 2.5 不变项：volatile 契约

断线期间事件必丢、无补偿重放。无论 v1/v2，客户端都要靠重连全量对账兜底（既有 Reconciler）。差异在于：v1 靠全量事件天然补偿细粒度遗漏；v2 必须「事件 + 回执 + 快照」三层配合（§4）。

## 3. 事件面审计矩阵（v2.0.18）

**方法**：SSE 可见集 = `EventManifest.ServerDefinitions`（`event-feed.ts` 按 `isOpenCodeEvent` 过滤，**定义了≠收得到**）× 发布者核查（core/server 内 `bus.publish` 调用点 grep）× 客户端消费核查（`handleEvent` / `applyV2SessionEvent` / `applyV2StreamEvent` 全 case）。三类陷阱都有实例：「定义了但没发布」（表 C）、「发布了但收不到」（`mcp.tools.changed` 不在 ServerDefinitions）、「发布了但客户端没接」（表 A/B）。

### 表 A：有发布者、客户端未接、损害状态正确性（应修）

| 事件 | 载荷 | 影响 |
|---|---|---|
| `session.revert.staged` | `{sessionID, revert}` | 跨端回滚不呈现；快照刷新抹本端 staged 态（§1 伴生缺陷） |
| `session.revert.cleared` | `{sessionID}` | 跨端撤销回滚不同步 |
| `session.revert.committed` | `{sessionID, to}` | **本次 bug**：提交后本地回滚态残留，新消息整轮隐藏 |
| `session.agent.selected` / `session.model.selected` | `{sessionID, messageID, agent/model}` | 客户端仍监听 v1 旧名（`app-store.ts:1859/1865`）→ v2 上跨端切换补丁永不触发（他端/TUI 切 agent/model 本端不反映） |
| `session.inbox.cancelled` | `{sessionID, inboxID}` | 排队消息被他端/CLI 取消（`session.inbox.cancel` RPC，`handlers/session.ts:543`）→ 无投影到达 → 乐观气泡悬挂（现有清除只在「新 user 消息出现」时触发） |
| `session.step.failed` | `{sessionID, assistantMessageID, error, …}` | 客户端只接 `step.started/ended`；失败步不发 `ended`（`publish-llm-event.ts` 二者互斥）→ 流式骨架滞留 streaming 态，靠对账/重取自愈 |

### 表 B：有发布者、未接、功能降级（按功能排期，不在本轮）

| 事件 | 说明 |
|---|---|
| `session.compaction.started/delta/ended/failed` | auto-compaction 全程无呈现 |
| `session.usage.recorded` / `session.usage.updated` | 成本/token 实时记账 |
| `session.moved` | 会话移动；M4 暂缓裁定维持（重连对账兜底） |
| `session.synthetic` | 官方合成消息事件，可替代 D3 本地 start-notice 启发式 |
| `session.shell.started` / `session.shell.ended` | server 侧 shell 执行可见性 |
| `session.forked` | REST + `session.created` 已覆盖（低） |
| `session.inbox.delivery.changed` | steer/queue 模式变化（低） |
| `session.permissions`、`session.instructions.updated` | 低 |
| `filesystem.changed` | `{file, event: add/change/unlink}`；**v2.0.18 唯一发布者是 LocationWatcher，只监听 `.git/HEAD`（分支切换检测，`location-watcher.ts:29`）**——全树监听仍不可得，迁移文档附录 B3 结论维持；载荷形状先记录，上游恢复全树发布后可直接接 |
| `vcs.branch.updated` | 分支切换广播（worktree 分支挂载的外部变化可感知） |
| `location.shutdown` | location 关停预告（带显式 location ref） |
| `installation.updated` / `installation.update-available` | server 更新通知 |
| `command.updated`、`skill.updated`、`config.updated`、`agent.updated`、`provider.updated`、`model.updated`、`integration.updated`、`models-dev.refreshed` | 目录/配置失效触发（v1 `catalog.updated` 的 v2 等价物，M6c 删了旧处理）——命令菜单缓存失效可接 `command.updated`/`skill.updated`；`config.updated` 发布于配置重载（`config.ts:276`） |
| `credential.switched` / `credential.updated` | 发布带 `{global: true}`——**信封无 location**，接时需闸门旁路（§4.1） |
| `pty.created/updated/exited/deleted`、`shell.created/deleted/exited` | 跨端终端生命周期；本端终端自管 WS+REST，设计上不展示他端终端（低） |
| `mcp.status.changed`、`mcp.resources.changed` | MCP 状态/资源变化 |
| `reference.updated`、`plugin.updated`、`websearch.updated` | 低 |

### 表 C：定义了但 v2.0.18 无发布者（勿接）

| 事件 | 说明 |
|---|---|
| `session.status` / `session.idle` | 客户端已留兼容 case（正确做法——官方 dev 后续接线，接线后自动生效） |
| `session.message.content.updated` | M6c 活体结论维持 |
| `session.skill.activated`、`worktree.resolved`、`tui.*` | core/server 无发布者 |
| `mcp.tools.changed` | **有发布者但不在 ServerDefinitions——SSE 收不到**，勿误接（易踩：grep 到 publish 以为可用） |

### 表 D：客户端 v1 遗留死 case（升 pin 复核清单素材）

| case | 状态 |
|---|---|
| `session.next.agent.switched` / `session.next.model.switched`（`app-store.ts:1859/1865`） | v1.18.x 名；v2 改名后永不触发——A 组修复项的成因 |
| `permission.updated`（`app-store.ts:1686`） | v2 只有 asked/replied；死 case 无害 |
| `session.updated`（v1 `properties.info` 形状，`app-store.ts:1665`） | v2 不发；v0.5 起仅支持 v2，属待清理死代码 |
| `file.watcher.updated`、`worktree.ready` / `worktree.failed` | v1/早期 v2 遗留名，v2.0.18 不发（design-file-watcher 迁移注记已有记载） |

## 4. 收敛策略：三层防御（通用模式）

v1 靠「全量事件 + 覆盖」一层就够；v2 每项会话状态都要三层配合。以回滚为例（其他状态迁移同构）：

### 4.1 层 1：SSE 事件驱动（权威路径）

`handleEvent` 增三个 case：

- `session.revert.staged`：`mergeSessionUpdate({ ...session, revert })`——跨端回滚实时呈现；
- `session.revert.cleared`：清 revert + 输入框语义复用 `unrevertSession` 的 `revertDraftConsumed` 判定（提炼私有 helper，REST/事件两路共用——跨端撤销不得误清本端用户自输内容）；
- `session.revert.committed`：清 revert + **终结草稿记账**（摘 `revertDrafts`/`revertDraftConsumed`——consumed 残留会让后续跨端 cleared 误清用户已改写的输入；不置空种子：提交不清输入框，区别于撤销语义。review 2026-10-07）+ **按 `to`（边界消息 id）本地确定性清除缓存**：`id >= to` 且 `created <` 事件时刻（见 §4.4——时间戳下界排除新轮次消息；无事件时刻则跳过清除，重取兜底）+ `void refreshConversationTail(sessionID)`（拉取新轮次消息）。

**闸门注意**：三事件均 durable；信封 `location` 是否携带**需活体验证**（`execution.*` 家族实测无 location）。若无，照抄 execution 的旁路模式：按 `sessionID` 反查 `session.directory` 过 `isOpenedDirectory` 闸门。`credential.*`（`{global:true}` 发布）同理。

### 4.2 层 2：回执驱动（不依赖 SSE 时序）

SSE 是 volatile 契约，事件可丢。`sendPrompt` 与 `sendCommand` 的 POST 成功后**无条件清本地 revert + 同步按预捕获集合清一次缓存**（幂等；`sendPrompt` 在重取合并后再清一次，收敛 projector 滞后带回的已删消息——review 2026-10-07：只挂重取之后的话，SSE 断线窗口内过滤已解除而旧消息仍在，复现到重取完成；重取失败早退则清除整段丢失）——斜杠命令同样走 server prompt、同样触发提交，两条路径都要。这与乐观消息的回执驱动同风格。

### 4.3 层 3：快照适配（防状态抹除）

`api-v2-types.ts` 的 `SessionInfo` 增 `revert` 字段（wire 契约有此字段，spec `Session.Info.revert` 证实）；`v2-adapter.ts` `toInternalSession` 映射之。效果：60s 对账 / 重连 / `refreshSessionsForProject` 的整条替换不再抹掉 staged 态——本端回滚条不闪没，跨端 staged 重连后仍呈现。**落地前活体确认一次 `GET /api/session` 响应确实携带 `revert`**（spec 证实字段存在，但 spec ≠ 活体行为——层 3 整体成立的前提，遵循本文档方法论）。

### 4.4 缓存清理：确定性清除为主，窗口删除兜底

被删消息不做逐条事件（v2 无 `message.removed`）。两级机制：

- **主路径（确定性）**：两条实现路径，语义同为「清除提交时点已知会被删的旧消息」：
  - **SSE committed 事件**：按 `id >= to` 且 `created <` 事件时刻清除——与 projector 的 `seq >= boundary` 删除同语义（id 升序字典序可比）。**时间戳下界是必要的**（实现期精化）：新轮次 user 消息的 `created` 取自 committed 之后发布的 `InboxEnqueued` 事件（`admit` 以 `event.created` 落库，同 server 时钟），恒 >= committed 时刻；本端发送时回执路径可能先于 committed 事件合并新消息——事后按边界裸扫会误删，`created <` 界精确排除。无事件时刻（meta 缺失）跳过清除，重取兜底。
  - **发送回执（sendPrompt/sendCommand）**：**POST 前预捕获** `id >= 边界` 的缓存 id 集合，成功后按精确集合删除（sendPrompt 挂在重取合并之后，收敛 projector 滞后页带回的已删消息）。预捕获同样是防误删：命令回显在 await 期间经 inbox 链路落地，id 同样 > 边界。
  这是 v1 `message.removed` 逐条删除的 v2 等价物，只是由边界一次算出，不经快照、无时序依赖。
- **兜底（快照窗口开区间删除）**：`mergeSnapshotIntoMessages`（`message-merge.ts:143-156`）——覆盖事件丢失（volatile 契约）后靠重取收敛的场景：被删消息的 `created` 落在重取快照的 `(min, max)` 开区间内即清除。边界：快照 <2 条不开窗口（既有守卫）。

**兜底路径的已知竞态（review 2026-10-07）**：窗口删除的 `max` 端依赖新消息已投影落地。若重取早于投影（POST 返回/committed 事件均可能早于落地——`refreshMessagesAfterPrompt` 自带投影落地判定即证明该窗口存在），快照 `max` = 最新保留消息的 `created` < 被删消息 `created`，窗口删除失配——若此刻 revert 已清、过滤已解除，被删消息**短暂幽灵复现**。自愈：投影落地触发 `session.inbox.enqueued` → `refreshConversationTail`（`app-store.ts:1742`），第二次重取 `max` 抬高后清除。主路径（确定性清除）不受此竞态影响——这也是它作为主路径的理由。

### 4.5 边界情形

- **staged 事件 vs REST 响应竞态**：`revertToMessage` 已乐观合并，事件幂等合并即可；
- **committed 早于重取到达**：清 revert 先行，重取后合并新消息，无冲突；
- **他端 committed**：本端无乐观，仅清状态 + 重取尾部；
- **断线窗口内 staged/cleared 交错**：重连全量对账以快照为准（层 3 保证快照携带 revert）；
- **重取早于新消息投影**（§4.4 兜底竞态）：确定性清除为主路径后仅影响事件丢失场景，瞬时幽灵由 `inbox.enqueued` 二次重取自愈。

### 4.6 落点表

| 文件 | 改动 |
|---|---|
| `src/shared/api-v2-types.ts` | `SessionInfo` 增 `revert?: V2SessionRevert`（`{messageID, partID?, snapshot?, files?}`） |
| `src/shared/v2-adapter.ts` | `toInternalSession` 映射 `revert` |
| `src/shared/api-types.ts` | `OpencodeEvent` 增 revert 三事件成员（标注 pin 2.0.18 与载荷） |
| `src/renderer/src/store/app-store.ts` | `handleEvent` 增三 case（含闸门旁路；committed 按 `to` 确定性清缓存）；`sendPrompt`/`sendCommand` 回执清 revert；`unrevertSession` 输入框判定提炼共用 helper |
| `docs/design/v2/design-message-revert.md` | §2/§3 修订：v2 事件收敛前提 + 三层策略引用本文档（实现时同步） |
| `docs/spec/spec-v0.5.md` | API 映射表补事件行 |

### 4.7 测试

- `v2-adapter.test.ts`：revert 映射（有/无/undefined）；
- `app-store.test.ts`：三事件 case（含 committed 不误删先行合并的新消息、meta 缺失跳过清除）；两发送路径后本地 revert 清除与预捕获集合清除；
- `message-merge.test.ts`：既有 `filterRevertedEntries` 边界维持（无改动，回归）。

## 5. 维护实践：升 pin 审计流程

本文档 §3 矩阵是 v2.0.18 事件面契约基线。升 pin 三步：

1. **schema 定义 diff**：`git diff <old> <new> -- packages/schema/src/*-event.ts`（ServerDefinitions 成员增删改名）；
2. **发布者核查**：对候选事件在 core/server grep `bus.publish` 调用点（事件符号，非字符串）；
3. **客户端 case 比对**：`handleEvent` / `applyV2*` / `api-types` 联合，新事件补 case、改名事件换绑。

规则：**审计基线必须是 schema 定义全集，不能是活体抓包**——M6c 的教训：抓包只见「收到了什么」，看不见「定义了没发布」「发布了收不到」「发布了没接」三类陷阱（§3 各有实例）。客户端消费的每个事件标注 pin 版本，升 pin 时 grep 复核（`session.next.*` 静默改名即漏网例）。

## 6. 明确不做

1. 不逐条接表 B 事件——按功能排期另行 design（Keep Lean：无消费场景不接）；
2. 不恢复 `message.removed` 处理——v2 无发布者，缓存收敛走窗口删除（§4.4）；
3. 不做事件补偿/重放请求——volatile 契约下重连对账已覆盖；
4. 不在本轮清理表 D 的 v1 死 case——单独清理提交，避免与行为变更混淆。

## 7. 验收

1. 回滚态发送新消息：新消息与回复立即可见、回滚条消失、被回滚消息不复活、60s 对账无跳变；
2. 斜杠命令路径同上；
3. 他端 stage / clear / commit：本端回滚条、隐藏、恢复实时呈现；重连后回滚态与 server 一致（快照携带）；
4. staged 期间经历 60s 对账：回滚条不消失、隐藏消息不复现；
5. 升 pin 回归：按 §5 流程重跑审计矩阵，新增/改名事件逐一处置。
