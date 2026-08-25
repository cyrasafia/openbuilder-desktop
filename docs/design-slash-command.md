# 会话 Tab 斜杠命令查询与发送 — 设计文档

> 参考移动端同类设计：`../openbuilder/docs/design-slash-command-refresh.md`（列表缓存与空响应防护）、
> `../openbuilder/docs/design-slash-command-echo.md`（回显 part 契约与渲染）。
> 本文落地桌面端，交互按桌面习惯调整（键盘导航菜单替代移动端点选列表）。

## 问题

会话 Tab 输入框此前只能发普通文本（`prompt_async`）。需要：

1. 输入 `/` 时查询并展示可用命令（含 builtin / config / MCP prompt / skill）；
2. 选中命令发送后由服务端展开模板执行（而非把 `/review` 当字面文本发给模型）。

## 背景：移动端踩过的坑（本设计直接规避）

| 坑 | 来源 | 桌面端对策 |
|---|---|---|
| **v2 `/api/command`/`/api/skill` 不可用**：未 GA、source 注册制无外部 skill 扫描、不合并 skill，且只认 deepObject `location[directory]` 参数、忽略 flat `?directory=`（恒返回默认目录数据） | refresh 文档 2026-08-17 追加 | 单源 **v1 instance 路由 `GET /command?directory=`**——与执行端点同一注册表（builtin init/review + config/插件 + MCP + 全量 skill 含 `~/.claude`、`~/.agents`）。实测 15120（1.18.x）：44 项 |
| **网络抖动恢复期 200+空 body**：连接池吐空响应不抛错，被当"真·空"信任会覆盖好缓存（内置命令恒在，200 空=瞬态） | refresh 文档根因调研 | `shared/command-cache.ts` 纯函数移植：suspiciousEmpty 保留同目录完整好缓存 + 连击计数器（3 次耗尽后信任空）+ 抛错（degraded）不消耗预算 + 目录隔离 |
| **客户端展开是死代码**：服务端已覆盖全部三类命令展开（`$1..$n`/`$ARGUMENTS`/sh 代码块/model/agent/subtask） | refresh 文档"为什么完全移除另三个源" | 客户端**零展开**：只传 `{command, arguments}`，模板处理全在服务端 |
| **subtask part 的 `text` 恒空**：展开 prompt 在 `prompt` 字段，读 `text` 得到空气泡 | echo 文档 SC-1（一次评审 🔴） | 读取链 `prompt → text → description`；实测本机 server 复核确认 |
| **subtask 标签单独渲染像 chip**：mono 标签行与 Markdown 正文观感割裂 | echo 文档 SC-2（二次评审 🟡） | `**subtask: <command>**` 加粗标签行与 prompt 正文合并为单一字符串，统一交 `Markdown` 组件渲染 |

## 设计

### 查询（列表）

- 数据源：`GET /command?directory=<会话目录>`，响应为裸数组（rest-client `listCommands`）。
- 缓存：全局单份（per-server），收敛在 `shared/command-cache.ts`（纯函数 `applyCommandFetch`，
  与 session-merge 同模式，单测覆盖）。

#### 状态模型

```ts
interface CommandCacheState {
  commands: CommandInfo[]  // 当前命令列表
  cacheDir: string | null  // 列表对应的 directory（目录隔离标记）
  complete: boolean        // 是否来自一次完全成功的拉取（只有完整列表才值得保护）
  degraded: boolean        // 最近一次刷新降级——下次输入 `/` 重试
  suspiciousStreak: number // 连续 200-OK-但空 次数（连击计数器）
}
```

| 字段 | suspiciousEmpty 保留时 | 连击耗尽信任空时 | 恢复后 |
|------|----------------------|-----------------|--------|
| `commands` | **不变（保留好缓存）** | 覆盖为空 | 覆盖为新结果 |
| `cacheDir` | 不变 | 更新 | 更新 |
| `complete` | 不变（仍 true） | true | true |
| `degraded` | true（下次 `/` 重试） | false（信任） | false |
| `suspiciousStreak` | ++（1→2→3，第 4 次耗尽） | ++ | 0（重置） |

连击语义（与移动端一致）：`kMaxSuspiciousRetries = 3`，中间任一次非可疑空的成功刷新立即清零；
**纯抛错（degraded）不计入连击、不消耗预算**——断网永久保留缓存是预期行为。

- 拉取时机（三层，对齐移动端"事件驱动自愈 + 缓存保留兜底"互补结构）：
  1. **进入命令模式按需拉**：输入 `/`（其后无空白）且未拉过该目录或上次 degraded 时；
  2. **发送前强制拉**：发送 `/xxx` 前重拉注册表再匹配，保证最新命令集；
  3. **事件驱动**：SSE `catalog.updated` / `mcp.tools.changed`（1.5s 去抖合并多订阅流重复事件）+
     SSE 重连成功（onReconnected，对齐移动端 server.connected 自愈）。
- 生命周期：`teardownConnection` 清缓存与 in-flight 表；同目录 in-flight **共享同一
  Promise**（发送前的强制重拉等待在途请求完成而非读旧缓存）；在途结果按 client 身份
  守卫丢弃（迟到于 teardown 的旧 fetch 不得把旧 server 命令写进新连接缓存）。

### 发送

- 输入 `/cmd args` 发送时：重拉注册表 → 按命令名（大小写不敏感）精确匹配 →
  - 命中：`POST /session/:id/command {command, arguments}`（`sendCommand`）；
  - 未命中：按字面文本走 `prompt_async`（服务端不会展开未注册命令，当普通消息处理是正确降级）。
- 命令名与参数以**任意空白**分隔（空格/换行/Tab——Shift+Enter 多行参数可达），
  参数取首段空白之后的剩余文本（trim）。
- 端点语义：**同步**——server handler await 完整执行循环，执行完才响应（openapi success =
  最终 assistant 消息，对比 prompt_async 的 NoContent）；但执行 runner 挂 server instance
  scope，客户端断连不取消执行，user 回显与回复全走 SSE。故 `sendCommand` 传 `timeoutMs: 0`
  **无限等待**（对齐官方 SDK v2 `req.timeout = false` 与移动端 dio 无 receiveTimeout）；
  失败只剩快速真错误（400 未注册/404）与断网。~~15s 默认超时~~是回显 bug 根源，见评审 SC-4。
- 乐观消息：回显原始 `/cmd args`（与 prompt 路径共用机制，真实 user `message.updated` 到达即清）；
  POST 失败撤回乐观 + **草稿回填输入框**（文本不丢，普通消息路径同样补了回填）。

### 回显渲染

- subtask 命令（如 `/review`）：真实 user 消息 part 为 `type:"subtask"`，渲染
  `**subtask: <command>**` + prompt 正文（单一 Markdown 块）；
- 非 subtask 命令（skill 等）：服务端展开为 `type:"text"` part，走既有纯文本渲染；
- 合并层（message-merge）：subtask part 在 REST/SSE 竞态合并时取 `prompt` 更完整者
  （SSE 早事件可能缺 prompt，与 text 的"取更长者"规则同理）。

### 菜单交互（桌面）

- 触发：草稿以 `/` 开头且其后无任何空白；Esc 关闭（改草稿重开）；
- 过滤：`/name` 前缀匹配（大小写不敏感），同移动端；
- 键盘：↑/↓ 移动选中（循环），Enter/Tab 补全为 `/name `（菜单开时 Enter 不发送），Esc 关闭；
  选中项 `scrollIntoView(nearest)` 跟随；
- 点击：mousedown 选中（防 textarea 失焦），补全后焦点留在输入框；
- 空态：仅加载中显示提示行；无匹配静默（同移动端）。

## 场景验证

| 场景 | 行为 |
|---|---|
| 输入 `/rev` | 菜单过滤出 `/review`，Enter 补全为 `/review ` |
| 发送 `/review --help` | 走 command 端点；气泡先显 `/review --help`（乐观），SSE 真实消息到达后显 `**subtask: review**` + 展开 prompt |
| 发送 `/不存在` | 重拉后未命中 → 按 `prompt_async` 字面发送 |
| 断网中输入 `/` | 拉取抛错：无缓存则空列表 + degraded（下次 `/` 重试）；有缓存则保留展示 |
| 抖动恢复期 200 空 | 同目录好缓存保留（≤3 次连击），SSE 重连自动重拉覆盖 |
| 切项目/断开 | 缓存清空（teardownConnection），不串显旧项目命令 |

## 关键设计决策

### 决策 1：单源 v1 `GET /command`，不碰 v2 `/api/*`

依据见背景坑表首行。核心：它是 `POST /session/:id/command` 执行所用的**同一注册表**，
三类（builtin/config+插件+MCP/skill）全覆盖；v2 未 GA 且忽略 flat `?directory=`。
移动端经过"三源并发合并 → 四源 → 单源"三轮迭代收敛于此，桌面端直接采用终态。

### 决策 2：客户端零展开

服务端展开链（`$1..$n` 位置替换 / `$ARGUMENTS` 整体替换 / 无占位符追加 / sh 代码块执行 /
model/agent/subtask 解析）已覆盖全部命令类型，客户端拿模板没用——移动端已把客户端展开
实现并删除（死代码），桌面端不重蹈。

### 决策 3：发送前强制重拉，同目录 in-flight 共享 Promise 而非丢弃

发送前的重拉语义是"匹配必须基于最新注册表"。若同目录已有在途请求（通常是输入 `/` 时
触发的按需拉），**丢弃式去重**会让匹配跑在旧缓存上——服务端新注册的命令会被误判未命中、
当字面文本发给模型。共享同一 Promise 让两条触发路径都等到最新结果落地，且天然串行化
同目录请求。跨目录不共享：各目录独立 in-flight，互不阻塞（REST 连接池预算内）。

### 决策 4：未命中降级为字面 prompt

`/不存在` 走 `prompt_async` 当普通消息发送。理由：服务端不会展开未注册命令（实测 400），
字面发送是用户可理解的降级（模型会回应"没有这个命令"之类），比阻断+弹错更平滑。
代价：命令刚注册、缓存尚未更新的窗口内可能误降级——由决策 3 的发送前重拉收窄该窗口，
SSE `catalog.updated` 事件驱动重拉兜底。

### 决策 5：命令名与参数以任意空白分隔

桌面输入框支持 Shift+Enter 多行，`/review\n--help` 必须仍按命令处理。分隔符用 `/\s/`
（空格/换行/Tab），参数取首段空白之后的剩余文本（trim 后发送）。菜单触发条件同步收紧
为"其后无任何空白"（换行不算命令名的一部分）。

### 决策 6：全局单缓存 + 目录隔离标记（不做 per-directory）

同移动端决策：per-directory 多缓存引入一致性与内存问题，且事件驱动刷新只刷"当前所见"
目录。`cacheDir` 标记 + 异目录不保留，切目录重拉即可；`commandsFor(dir)` 对异目录返回空，
杜绝 B 项目展示 A 项目命令。

### 决策 7：菜单 Enter 语义 = 补全优先于发送

菜单打开且有匹配时，裸 Enter 补全选中项（`/name `）而非直接发送当前草稿。理由：用户
此时的高频意图是"选中我看到的命令"；直接发送半截命令名（`/rev`）要么误降级为字面文本、
要么发出错误命令。Tab 同义；Enter 发送在菜单关闭或无匹配时恢复。

## 不做的事

- **不做客户端模板展开**（移动端已证明是死代码）；
- **不持久化命令缓存**（冷启动首拉即可，持久化引入目录失效问题收益低）；
- **不做 per-directory 多缓存**（全局单份 + 目录隔离标记，切目录重拉，同移动端决策）；
- **不做 shell 模式**（`!` 前缀，v0.1 范围外）；
- **命令附件 parts**（openapi 支持 command 带 file parts，本项目 v0.1 无附件功能）。

## 实现落点

- `src/shared/api-types.ts`：`CommandInfo`、`SubtaskPart`、PartType 加 `subtask`
- `src/shared/rest-client.ts`：`listCommands` / `sendCommand`
- `src/shared/command-cache.ts`（新）：缓存防护纯函数 + `command-cache.test.ts` 8 用例
- `src/shared/message-merge.ts`：subtask 合并规则
- `src/renderer/src/store/app-store.ts`：`refreshCommands`（per-directory in-flight Promise
  map + client 身份守卫）/ `sendCommand` / SSE 事件与重连钩子 / `teardownConnection` 清理
- `src/renderer/src/components/workspace.tsx`：`CommandHints` 菜单 + 键盘交互 + `sendSlash`
  分流 + subtask 渲染

## 验证

- 15120 实机（server 1.18.x）：`GET /command` 44 项（builtin+插件+skill）；
  user 消息 part `subtask`/`prompt` 有值、`text` 空（与移动端实测一致）。
  **订正**：初版记录"`POST /session/:id/command` 立即返回"有误——对照官方 `packages/app`
  提交链（fire-and-forget + 仅 `.catch` 回填）与 SDK v2 client（`req.timeout = false`）、
  及 server 源码（handler await 完整执行循环、openapi success=WithParts），该端点为同步
  端点，见评审 SC-4；
- vitest：初版落地 36/36（含 command-cache 8 用例）；SC-4 新增 4 用例（rest-client
  超时策略 2 + app-store sendCommand 分支 2），全量 265/265 通过、typecheck 双侧、
  electron-vite build 通过。

## 评审意见

> 评审日期：2026-08-24。实现完成后全量 diff 评审，3 项问题全部修复。

### SC-1（🟡）同目录 in-flight 去重不等待，破坏"发送前强制重拉"保证

初版 `refreshCommands` 用 `commandsRefreshing + commandsRefreshDir` 布尔去重：同目录在途时
直接 `return`，`sendSlash` 的 `await` 立即返回——匹配跑在**拉取前**的旧缓存上。慢连接下
在途请求可挂 15s，窗口不小；场景：服务端新注册命令 → 用户输入 `/新命令`（旧缓存无匹配）→
在途请求未完成时 Enter → 误降级为字面 prompt 发给模型。

**修复**：per-directory `Map<string, Promise<void>>`，同目录共享同一 Promise（决策 3）；
`commandsRefreshing` 退化为派生 getter。跨目录并发天然支持，迟到的同目录旧请求按 Promise
身份比对删除，不误删重连后的新条目。

### SC-2（🟡）在途 fetch 跨越 teardown 写入旧 server 数据

初版在途请求完成时无条件写 `commandCache`。`teardownConnection`（断开/切 profile）无法
取消 fetch，迟到的旧 server 结果会写进新连接的空缓存——若新 profile 有同路径项目
（同 repo 不同 server），`commandsFor(dir)` 展示错误注册表，发送未注册命令 400。

**修复**：请求闭包捕获发起时的 `client`，落地前 `this.client !== client` 则丢弃；
`teardownConnection` 顺带清空 in-flight 表（条目本身已无害化，清理是防泄漏）。

### SC-3（🟡）命令名只按字面空格分段

`text.indexOf(" ")`：`/review\n--help`（Shift+Enter 多行参数）的 token 变成
`review\n--help`，注册命令匹配不到、误降级字面发送；`cmdMode` 判定同样只查空格，
换行草稿仍当命令模式。

**修复**：分隔符改 `rest.search(/\s/)`（决策 5），`cmdMode` 判定改 `/\s/.test()`。

### SC-4（🔴 线上反馈）15s 默认超时误杀执行中的命令 → 草稿回显至输入框

**症状**：发送斜杠命令后约 15s，命令文本回显到输入框；聊天里命令却照常执行。

**根因**：`POST /session/:id/command` 是**同步端点**——server handler（opencode 官方
`httpapi/handlers/session.ts` 的 `command`）直接 await `promptSvc.command` → 完整执行
循环，openapi success 是最终 assistant 消息（WithParts），与 `prompt`（同步）同型、
与 `prompt_async`（fork 后立即 NoContent）相反。本文初版"实测立即返回"的结论沿用了
移动端 `opencode_client.dart` 的过期注释，未对照 openapi 契约（契约本身就写着
WithParts）。`RestClient.sendCommand` 未指定 `timeoutMs`，走默认 15s：命令执行超 15s
（几乎所有真实命令）→ `AbortSignal.timeout` 掐断 → `ApiError(timeout)` →
`sendCommand` 返回 `{ok:false}` → `workspace.tsx` 失败分支 `setDraft(text)` 回填 +
误撤乐观消息。而执行 runner 挂 server instance scope（`Runner.make(data.scope)`），
客户端断连不取消执行，SSE 照常吐回显与回复——输入框与聊天流两份状态打架。

**参考实现对照**（2026-08-25 用户指示）：
- 官方 `packages/app`（opencode-desktop renderer 即此包）`prompt-input/submit.ts`：
  命令分支 `clearInput()` 后对 `api.session.command(...)` **fire-and-forget**，仅
  `.catch`（真实错误）才 toast + `restoreInput()` 回填 + 状态回 idle；
- 官方 SDK v2 `createOpencodeClient` 默认 fetch 显式 `req.timeout = false`——
  对该链路整体关闭超时；
- 移动端 dio 无 receiveTimeout，无限等待执行完成。
三者同答案：**命令请求不设客户端超时；仅真实错误（秒回的 400/404 或断网）触发回填**。

**修复**：`fetchResponse` 支持 `timeoutMs: 0` = 无限等待（不挂 `AbortSignal.timeout`）；
`sendCommand` 传 `timeoutMs: 0`。失败分支语义不变（撤乐观 + 回填），但现在只有真实
错误能到达。乐观消息保留（真实 user 消息 SSE 到达即清），与官方"无乐观、纯等 SSE"
相比即时反馈更好，无副作用。

**验证**：rest-client 测试断言 `sendCommand` 不挂超时 signal、默认端点仍挂；
app-store 测试覆盖长时执行在途时乐观保留、成功/失败两分支。用户中止路径经
server 源码核实无回填风险：`runner.cancel` 使在途 command 请求走 `onInterrupt`
（= lastAssistant，返回被打断消息）→ **200**，不进失败分支。

### 未处理（评估后接受）

- 发送失败草稿回填（`setDraft(text)`）会覆盖请求在途期间用户的新输入：SC-4 后回填仅由
  快速真错误（400/404/断网）触发，窗口更短，恢复原文本优于丢弃，接受；
- `timeoutMs: 0` 下若 server 进程被 `kill -9`（无 TCP FIN），sendCommand 的 fetch 永久
  悬挂、乐观消息滞留：SSE 同死，重连/对账与状态行 degraded 提示兜底，与移动端同暴露面，
  接受（官方 app 同行为）；
- 菜单 `key={c.name}` 依赖 server 注册表命令名全局唯一：builtin/config/MCP/skill 四类
  共享一个命名空间，server 侧注册时已保证（同名后注册覆盖前注册），接受。
