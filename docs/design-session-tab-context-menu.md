# 会话 Tab 右键菜单（重命名 / Fork）— 设计文档

> 对应 spec-v0.3 #10。chat Tab 右键弹菜单：重命名（复用双击行内编辑）、Fork
> （`POST /session/{id}/fork` 复制会话，新 Tab 打开激活）。store/通信层为主，
> UI 为 FileContextMenu 模式第 4 处实例。
>
> 参考先例（按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`）：移动端
> 无 Tab 条（单会话路由），无右键菜单/fork 先例；fork API 仅在
> design-v2-migration 中列为 v2 新增端点——**实测 v1 server 1.18.20 已具备**
> （`../openbuilder/opencode_openapi.json` 亦含该端点，契约以 openapi + 实测为准），
> 迁移文档的"v2 新增"表述过时。

## 1. 问题

- 重命名（design-tab-drag-rename §2）只有双击一个入口，可发现性弱；桌面惯例是右键菜单。
- 无会话 fork：想从某会话当前状态岔出一条支线继续（试另一种方案/模型/指令），
  只能新开会话重贴上下文。

## 2. 设计

### 2.1 菜单形态与触发

- **仅 chat Tab** 右键弹菜单（重命名/fork 都是会话语义）；file/diff/terminal/browser
  Tab 右键只 preventDefault（不弹空菜单）。重命名态（行内输入框）中的 Tab 不弹
  （输入优先，避免菜单动作与编辑态打架）。
- 菜单目标 = **被右键的 Tab**（快照入 state，不随菜单存活期内的列表变化重定目标）；
  右键不激活 Tab（与浏览器 Tab 惯例一致）。
- 菜单基建复用 FileContextMenu 模式（首帧隐藏测量钳制 + capture 四触发关闭 +
  浮层计数 z-order + 方向键导航），第 4 处实例；`.popover context-menu` 样式零新增。
- 两项：**重命名** → 复用双击路径，以 Tab 当前标题进 `renaming` 编辑态（提交/
  取消/IME 守卫全走既有 commitRename）；**Fork 会话** → `store.forkSession`。
  动作统一"先关菜单再执行"（run 模式）。

### 2.2 fork API 契约（实测 server 1.18.20）

| 项 | 契约 |
|---|---|
| 端点 | `POST /session/{sessionID}/fork?directory=`（directory 同其他会话端点必带，定位 instance） |
| body | `{messageID?}` 可选——省略 = 复制全部消息（最新状态分叉）；携带 = 从该消息点分叉（本版 UI 不提供选点，rest-client 保留参数） |
| 响应 | 新会话完整 `Session`：新 id、同 directory/projectID、**title 自动加 `" (fork #N)"` 后缀**（同源会话重复 fork 编号递增）、cost/tokens 清零、无 parentID（非 subagent，`visibleSessions` 的 `!parentID` 过滤可透过） |
| 空体 | `{}` + Content-Type JSON 实测 200；源会话不受扰动（fork 对源只读） |
| **延迟** | **同步端点：server handler 复制源会话全部消息后才响应，耗时随会话体积线性——小会话 <1s，大会话实测 24–28s（2026-09-02 联调实测 40+ 消息会话）** |

> **2026-09-02 修订（fork 后新 Tab 不显示 bug）**：初版沿用 rest-client 默认 15s
> 超时——大会话 fork 必然超时：client 按失败处理（catch → connectionError、不开
> Tab），而 server 实际仍在复制并最终成功，会话经 SSE `session.created`/快照静默
> 落地，直到切换 worktree 经 §17 补开才可见（即"fork 后新 Tab 默认未展示，切换
> worktree 后才出来"）。修复 = **`timeoutMs: 0` 无限等待**（sendCommand 同款先例：
> 同步长端点、耗时无安全上限、官方 SDK v2 client 默认整体关超时）。E2E 复验：
> 大会话 fork 28s 后新 Tab 打开并激活、无 connectionError。
>
> **2026-09-02 修订二（提前开 Tab）**：server fork 时序 = `createNext` **先建壳**
> （落库 + 即发 `session.created`，带完整 Session.Info 与 fork 标题）→ 逐条复制
> 消息（每条发 `message.updated`/`message.part.updated`）→ 全部完成后才回 HTTP
> 响应（`../opencode` session.ts 源码核实）。据此 fork 不必等 REST：发起即挂
> `pendingFork` 关联窗口，SSE `session.created` 按 **directory + fork 标题模式**
> （getForkedTitle：`base (fork #N)`，编号不收紧到 N+1——并发 fork 时 server
> 全局编号会偏移）命中即开 Tab；消息在复制期间经既有 message.* 合并路径逐步
> 流入（**消息条数增长即天然进度显示**）；REST 响应到达后 `openChatTab` 幂等
> 收敛。误报面 = pending 窗口内他端 fork 同 base 标题会话——开的是真实会话，
> REST 到达后再开真 fork Tab，无害；REST 失败（4xx/断网）窗口已清、SSE 命中
> 开的 Tab 对应真实存在的会话，不撤销。E2E 实测：Tab **0.7s** 出现并激活
> （此前 28s），收敛后 211 条消息全量在场。
>
> **2026-09-02 修订三（与实时补开协同）**：同日 design-tab-memory §17 修订引入
> 「实时补开」——当前作用域的 `session.created` 一律被动开 Tab（末尾追加、不激
> 活）。两分支共存且 **fork 关联优先并 break**：fork 命中走 `openChatTab`
> （**激活**，用户动作的直接反馈）；其余新建（含引导页 `openTab:false` 流程的
> 建会话回环）走被动开不激活。详见 design-tab-memory §17 修订块。
>
> **2026-09-02 修订四（废弃关联，fork 改 fire-and-forget）**：修订二/三的标题
> 关联（directory + getForkedTitle 模式）**不可靠**——v1 协议的 `session.created`
> 无 fork 来源字段，而标题在同名会话、并发 fork（server 全局编号偏移）下误报
> 不可控；REST 响应虽带确定的新会话 ID，但要等复制完成（大会话 24s+），无法
> 用于即时激活。据此放弃关联：**forkSession 改 fire-and-forget**——发起 POST
> 后不等结果、不开 Tab 不激活；新 Tab 由 `session.created` 经实时补开**自然
> 打开**（同他端新建一条路径：末尾追加、不抢焦点，E2E 实测 0.3s）。REST 响应
> （timeoutMs: 0）到达仅做数据收敛：合并快照 + 当前作用域被动补开（SSE 丢失
> 的兜底，幂等）；失败置 connectionError。UX 变化：fork 不再自动切到新会话
> （用户自行点击）；大会话复制期间新 Tab 消息逐步流入（条数增长即进度）。
> E2E 实测：fork 点击 → 0.3s Tab 末尾出现、active 保持原 Tab → 复制完成后
> 焦点不被顶替。修订二/三的 pendingFork/forkTitlePattern 机制随本修订移除。

### 2.3 store 路径（app-store `forkSession`，修订四：fire-and-forget）

1. directory 解析：**调用方直传优先**（菜单层传 chat Tab 的作用域 directory），
   `findSession` 兜底——本地无源会话记录的僵尸 Tab（server 会话仍在，如快照间隙）
   也能发起；两者皆无 → 不发请求
2. **发起即走**：POST（timeoutMs: 0，复制完才回）不阻塞 UI、不开 Tab 不激活；
   新 Tab 由 SSE `session.created` 经实时补开（§17 修订）自然打开——同他端新建
   一条路径（末尾追加、不抢焦点），消息在复制期间经 message.* 事件逐步流入
3. REST 响应到达仅做数据收敛：合并快照进 `sessionsByProject` + 当前作用域被动
   补开（`openChatTabPassive`，SSE 丢失的兜底，同路径幂等）；非当前作用域不
   开（切回经 §17 补开）
4. 失败：`connectionError`（左栏状态行可见，无 toast 基建同文件菜单取舍），
   fire-and-forget 无返回值，菜单层无等待

### 2.4 流式中的 fork

不拦截：fork 对源会话只读，server 在其当前消息边界原子复制；进行中的流继续写源。
与 revert 的 busy 确认（design-message-revert）不同——fork 无破坏性，无需确认。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 消息级 fork 入口（messageID 选点 UI） | 回滚菜单（revert）已覆盖"从某消息重开"语义；选点 fork 待真实需求 |
| fork 历史树 / 祖先展示（parentID、`GET /session/{id}/forks`） | 本版 fork 是"快照式岔路"，不建谱系 UI |
| 非 chat Tab 的右键菜单项 | 无会话语义；关闭已有按钮/Ctrl+W |
| 菜单基建组件化统一（4 处实例抽取） | 各处条目/可见性差异小但存在，抽取收益不及迁移面；沿用既有"复用模式"惯例，出现第 5 处再议 |
| fork 中/成功 toast | 新 Tab 打开即反馈；无全局 toast 基建 |
| fork 进行中的显式反馈（进度条/禁点/复制中标记） | Tab 经实时补开即时可见 + 消息条数增长即进度；v1 无 fork 总量事件，显式进度只能本地伪装 |
| REST↔SSE 事件关联（fork 结果即时激活） | v1 协议无来源字段，标题模式同名/并发误报不可控（修订四废弃）；REST 响应虽带确定 ID 但需等复制完成（大会话 24s+），激活无即时通道 |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/rest-client.ts` | `forkSession(sessionID, directory, {messageID?})`：POST fork 端点（timeoutMs: 0） |
| `src/renderer/src/store/app-store.ts` | `forkSession`：fire-and-forget——REST then 合并快照（迟到守卫：本地更新更晚跳过）+ 当前作用域被动补开；失败 connectionError |
| `src/renderer/src/components/workspace.tsx` | Tab `onContextMenu`（chat 门禁 + 快照 state）；`TabContextMenu` 组件（FileContextMenu 模式） |
| `src/renderer/src/i18n/index.ts` | `forkSession`（"Fork 会话"/"Fork session"；重命名复用 `renameTab`） |
| 测试 | rest-client：URL/body 形态与无超时信号；store：fire-and-forget 合并+被动补开不激活 / SSE 先到幂等 / directory 直传 / 失败 / 双缺 no-op |

## 5. 验收

- chat Tab 右键弹菜单（重命名 / Fork 会话两项）；file/diff/terminal/browser Tab 右键无菜单
- 重命名项进入与双击相同的行内编辑（Enter 提交、Esc 取消、IME 安全）
- fork 点击后新 Tab 经 SSE `session.created` 实时补开**立即**出现（实测 0.3s，
  末尾追加、**不激活不抢焦点**），标题带 "(fork #N)" 后缀，消息在 server 复制
  期间逐步流入（条数增长即进度）；REST 收敛后焦点不被顶替、Tab 不重复；
  源 Tab/源会话不受扰动；重复 fork 编号递增（2026-09-02 修订四）
- SSE 丢失时：REST 响应到达被动补开（当前作用域）或切回作用域补开
- fork 失败（断连/会话已删）经左栏状态行可见错误，无残留 Tab
- 流式中的会话可 fork（快照至当前消息边界）
- `npm run test` / `typecheck` / `build` 全绿
