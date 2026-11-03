# design-worktree-shell-rescue.md — 空壳 worktree 的探测、拦截与删除兜底

> 日期：2026-11-03｜状态：已实现，待评审（实现增补：probe 三态按活体 500 实测定稿——§1.2/§3.2 修订，与初稿「目录消失同判 broken」不同）
> 关联：`design-worktree-sync.md` §3.4–§3.6（删除链路伪行防御三件套，本文件是其续篇）；
> `ref-pseudo-project-cleanup.md` §2（空壳形态）§3.4（燃料 6）§5.2（空壳处置式）；
> `design-worktree-branch-sync.md` §2.3（删除后分支清理，兜底路径汇合点）
> 实证背景：2026-11-03 happy-harbor 事故取证（外部 `rm -rf` 中途中断 → `.git` 指针
> 丢失 → 三重死锁删除必拒 → 53 分钟后伪项目行升格），全程见当日会话记录；
> 实现日活体复核 proud-moon 双例（shell 500 / DELETE 同型错误体）

## 0. 问题：空壳型残留是删除链路的盲区

「空壳」= worktree 目录仍在磁盘，但 `.git` 指针文件已丢失（典型成因：外部
`rm -rf` 中途中断——happy-harbor 实证 79ms 内三层 mtime 链，删除止于
`.venv/lib`）。它与两种已覆盖形态都不同：

| 形态 | 既有覆盖 | 空壳的差异 |
|---|---|---|
| 目录消失（他端删除/外部 rm 完成） | §3.6 #3 `LocationNotFoundError` 被动确证；refresh 清库存行 | 目录在 → realPath 成功 → **无任何错误信号** |
| 脏 worktree（正常删除面） | 确认弹窗 vcsStatus 预检 + `force:true` | `.git` 丢失后 git 侧已 prunable，`force` 无效（`forceRequired:null`） |

空壳的三重死锁（ref §2「空壳目录」行 + 本次实测）：`DELETE /api/worktree` 400
`WorktreeError{DirectoryUnavailable}`（server 先经 git 定位 worktree，`.git`
丢失即定位失败）；`refresh` 不清（只清目录消失行）；`git worktree remove`
不可用（prunable 只能 prune，server 链路不含）。桌面端表现：删除失败、行
复位、重试永远失败——用户对着一行死工作区无路可走。

升格链（ref §3.4 三订）在此形态下**无被动信号可拦**：任何带
`location[directory]=` 的请求 boot 即 `project.resolve`（上游
`core/src/location.ts:24`），resolve 兜底建档**先于任何响应返回**——客户端
拿到信号时伪项目行已诞生。happy-harbor 时间线：00:48:12 破坏 → 01:41 升格，
53 分钟窗口内客户端无感知。

## 1. 探测通道：runShell 是唯一零建档路径（红线修订的技术前提）

### 1.1 两通道对照（上游源码锚，2.1.3 核对）

location 中间件的目录取参（`server/src/location.ts:71-79` `requestRef`）：

```ts
const directory =
  query.get("location[directory]") ||
  (request.headers["x-opencode-directory"] ? decode(...) : process.cwd())
```

| 通道 | boot 目标目录？ | resolve/建档？ |
|---|---|---|
| `POST /api/shell`，**无** location query/header | 否（落到 `process.cwd()` 即 server cwd） | **否** |
| 任何带 `location[directory]=` 的请求（`vcs/status`、`GET /api/shell` 列表、`createSession` body location 等 §3.5 全部 17 方法） | 是 | **是，一发一行** |

`POST /api/shell` 的 body `cwd` 只是 shell 进程工作目录，不经过中间件。
桌面端 `runShell` 封装（`rest-client.ts:626`）恰好两者都不带——安全属性
当前成立。**注意 `GET /api/shell?location[directory]=`（listShells）带
location 会 boot**：同为 shell 域端点行为相反，封装与调用不得混用。

### 1.2 封装约束（把安全属性固化在签名层）

新增 `probeWorktreeHealth(directory): Promise<WorktreeHealth>`（`"ok" |
"broken" | "unknown"`，rest-client 单点封装），内部 `runShell`，**禁 location
参数**（现状即合规，签名与注释固化——防未来给 runShell 加 location query 使
属性静默失效）。路径零拼接：命令用相对路径，目录经 `opts.cwd` 传（body
JSON，不经 shell 解析，注入面归零——同 `mountWorktreeBranch` 的 cwd 传法）：

```
test -e .git   # exit 0 → "ok"（.git 在，文件或目录形态皆可）
               # exit ≠ 0 → "broken"（shell 已在目录内起且 test 失败
               #              = 目录确证存在、.git 丢失——空壳确证）
               # 请求失败 → "unknown"：目录消失时 server 无法 spawn
               #   （活体实测 2026-11-03 proud-moon = HTTP 500）与
               #   shell 端点故障**同状不可区分**；exit null 同判
```

fail 方向正确性：活 worktree 上 shell 必能起且 `test` 必过——`"broken"` 不可能
误报（shell 能起 = 目录在，test 失败 = `.git` 失）；`"unknown"` 不携带「目录
死」的确证，**消费方不得据此执行破坏性处置**（目录消失型的清理经无破坏性
收敛判据达成，§3.2）。初稿「目录无处起同判 broken」经活体证伪（500 非命令
执行），按三态定稿。

### 1.3 红线修订（2026-11-03，本设计落地的前置裁定）

原口径（design-worktree-sync §3.6 #3、AGENTS.md）：「**红线：不主动探测**——
probe 即建档燃料」。

**修订为**：「**不用 location 请求探测**——任何带 `location[directory]` 的
请求对死/空壳目录都是建档燃料（ref §3.4 三订，一发一行）；worktree 健康探测
只允许走 runShell（POST /api/shell 不带 location 参数，§1.1 论证零 boot）」。

修订依据：原红线的理由是「probe 即建档」，其燃料专指 location 请求；
runShell 探测不 boot 目标目录、不触发 resolve，不落入原理由的射程。红线
理由不变、字面收窄。AGENTS.md 与 design-worktree-sync §3.6 原句随本文同步
修订。

### 1.4 探测范围与 fail-open

- **只对 worktree 库存行目录探测**（`worktreeDirs` ∪ sandboxes union，同
  §3.6 `deadWorktreeOwner` 口径）：非 git 目录是合法 location（v2 目录哈希
  身份），`.git` 不存在不构成异常，**不得拦截**；**canonical 排除**（canonical
  死亡不是 worktree 删除语义，不越权处置——沿 §3.6 #3 既有口径）。
- shell 通道异常（网络失败/超时/非 0 以外的不确定态）→ `unknown`：
  **不拦截**（fail-open），留给删除兜底与既有错误呈现——探测是增强，不是闸门。

## 2. 探测点矩阵（交互时点探测；定时探测否决）

| 探测点 | 端 | 时机 | 动作 |
|---|---|---|---|
| 删除兜底（§3） | PC | `DELETE /api/worktree` 失败判别后 | 确证 → 自动空壳清理（免再确认） |
| 作用域进入 | PC | 切换/跨项目直达/移动跟随（§2.1 三路径） | 异步探测 → broken 状态化 → 拦截新会话创建 + 提示删除 |
| 会话创建 | app（openbuilder） | `createSession` 前 | 探测 → 空壳弹框阻断 + 提示删除工作区 |

**定时探测否决（裁定记录）**：曾候选「60s 对账周期对库存行逐个探测」。
否决理由：探测到空壳后，处置（rm）是破坏性操作须用户确认——定时探测的
提前量**不兑现为任何自动动作**，只能弹提示等用户；而用户真正需要被拦截的
时刻（切进去、建会话、点删除）都有各自的探测点覆盖。定时成本与提示噪声
不产生对价收益。伪行预防的「断燃料窗口」价值随之放弃，由上游治本承接
（§5）。

### 2.1 PC：切换探测与会话创建闸门

- 作用域进入**三条路径同覆盖**（review 2026-11-03 #1 修订：初稿只挂
  `setCurrentWorkspace` 一条，跨项目直达与移动跟随是闸门盲区）：①
  `setCurrentWorkspace(directory)`（同项目切换）；② `openProject(projectId,
  workspaceDirectory)`（跨项目点工作区行直达——workspace 经 sandboxes 校验
  成立时）；③ `moveSession` followsActive（会话移入工作区跟随激活）。三处
  均 fire-and-forget `probeWorkspaceAfterSwitch`（canonical 排除/epoch 校验/
  fail-open 见下），**异步**不阻塞切换（探测 ~百 ms 级；文件树/快照请求与
  探测并行，不因探测慢半拍）。
- 结果 broken → `brokenWorkspaces: Set<directory>` 登记 + emit；UI 在会话
  创建入口（输入框首条消息、新建 chat Tab）呈现阻断提示——**常驻红字**
  （`.form-note.attach-error`，`--status-error`）+ 发送按钮置灰，与 tooLarge
  超限占位同式（design-session-attachments §2b 2026-10-12 修订同款演进：
  持续错误态不用 4 秒 notice）；文案「工作区已损坏（git 元数据丢失），请在
  左栏删除该工作区后重建」，删除动作直达 `removeWorkspace`（其内部走 §3
  兜底，一次点击完成清理）。
- `createSession`（app-store，会话创建唯一入口）闸门：`scopeQuery.directory ∈
  brokenWorkspaces` → 不发 `POST /session`（该请求带 location body——对
  空壳是一发建档燃料，拦截即省下）→ 返回 null + 提示。
- 状态生命周期：目录从库存消失（删除完成/refresh diff）即移出集合；
  同名重建的新 worktree 目录不命中旧登记（按 directory 字符串，重建后
  探测重新跑，健康即不登记）。
- **启动/重连恢复探测（2026-11-03 复测补丁一，实测 sunny-sailor）**：持久化
  恢复不走 setCurrentWorkspace——`connect` 在 `refreshAllOpenedProjects`
  （库存 union 完成，currentWorkspace 可解析）后经 `probeRestoredWorkspaceScope`
  对恢复的作用域补一次探测。缺此挂点则「刷新页面（Ctrl+R）后停在空壳作用域」
  登记集为空，闸门失效。**同目录重切早退**（点击当前工作区行）同样补探测
  ——点击是显式交互时点，外部修复/破坏后登记随最新探测刷新。
- **创建前兜底校验（2026-11-03 复测补丁二，推翻下方原「陈旧窗口接受」）**：
  登记集是缓存，可能缺失（探测挂点漏覆盖/fail-open/陈旧）——`createSession`
  入口双层：① 快路径（登记命中直接拦，零 RTT）；② 兜底（未命中且作用域为
  worktree 行 → 实时探测一发：broken 现场登记 + 拦，红字随 emit 出现、后续
  走快路径；ok/unknown 放行 fail-open）。POST /session 带 location body 是
  建档燃料，创建是显式用户动作——一次 ~百 ms 级 RTT 换确定性拦截，代价可
  接受。原「陈旧窗口接受（不重复 RTT）」声明作废：探测挂点再多也有覆盖缝，
  兜底把确定性落在动作点上。
- **非零建档声明**：切换探测拦的是「新会话创建」，不是「零建档切换」——
  作用域切换自身的 fs 请求（listFiles 等带 location）在探测结果返回前
  已可能发出、已可能建档。本设计不试图拦这（拦文件树 = 大改且体验劣化），
  价值序列是：拦截 > 引导删除 > 全自动清理，建档与否不是目标函数。

### 2.2 app（openbuilder 同构约定，实施另议——移动端仓库默认只读）

创建会话前对目标 directory 发同式探测（`POST /api/shell` **不带**
location，命令 `test -e .git`、cwd=目标目录）；broken → 弹框阻断创建 +
提示「删除工作区」。与 PC 的差异：app 无「作用域切换」重交互，探测点
直接放创建会话时（一次性、同步判定后再决定是否 POST /session）。
口径与 §1.3 红线修订同步进 openbuilder 的对应设计文档。

## 3. 删除兜底：`removeWorkspace` 的空壳分支

### 3.1 触发与判别（双保险，缺一不走清理）

现有链路（§3.5 屏障 → 级联删会话 → `awaitLocationIdle` →
`DELETE /api/worktree`）的 DELETE 失败 catch 中：

1. **错误判别**（`isWorktreeUnavailableError`，前置）：`ApiError.tag ===
   "WorktreeError"` 且 message 含 unavailable（2.1.3 形状 `{_tag, name,
   data:{message}}`，`data.message` 前缀 `Worktree directory unavailable:`；
   旧形状 `{name, data}` 双读兼容——同 §3.6 #1 解析口径）。**空壳与目录
   消失两型 DELETE 错误体同型**（活体实测 2026-11-03 happy-harbor +
   proud-moon 双例）——判别即同时覆盖两型，不进入清理的非 WorktreeError
   （网络错/其他 400）连探测也不发；
2. **磁盘确证/收敛判据**（`rescueBrokenWorktree`，probe 三态分流见 §3.2）：
   `"ok"` = 活 worktree（server 拒删另有原因）不清理；`"broken"` = 空壳
   确证可 rm；`"unknown"` = 不可确证，只走无破坏性 refresh + 重拉收敛。

判别不可省：tag 判别防网络错误入，确证/收敛保证 rm 只落在「git 元数据
已失」的目录上（server 版本语义漂移也被挡）。

### 3.2 清理流程（probe 三态分流，与成功路径汇合）

```
probeWorktreeHealth(directory)
├─ "ok"（.git 在）→ 活 worktree：server 拒删另有原因，不清理（原样抛出）
├─ "broken"（目录确证在、.git 失）
│    ① runShell('rm -rf "$PWD"', {cwd: dir})——$PWD 由 shell 自行展开，
│       路径零拼接（§1.2 同理），注入面归零；exit ≠ 0（文件占用等）→
│       放弃兜底（残留目录更残缺但不误删，可重试）
│    ② POST /api/worktree/refresh（目录已消失，refresh 必清库存死行）
└─ "unknown"（目录消失与端点故障同状，活体 500）
     **不 rm**——无「目录死」确证；仅 ② refresh（只清「目录已消失」行，
     无破坏性：活目录不会被 refresh 删）
收敛判据（"unknown" 路径的关键，"broken" 路径同过一道）：
  重拉 listWorktrees——行已消 = 清理成立；行仍在 = 端点故障误报/真异常、
  **重拉失败（网络）同判**（review 2026-11-03 #2：unknown 路径无 rm 无「目录
  死」确证，null 不得放行为成功——不做 noteLocationDeleted/evict/unload/
  分支清理的整套成功链；broken 路径 rm 虽成的假失败只是可重试收敛：重试走
  unknown → refresh → 行已消即成功）→ 不清理（原样抛出，诚实失败）
清理成立 → 汇合既有成功路径：noteLocationDeleted → evictLocation →
  refreshWorkspacesForProject → unloadWorktreeDirectory →
  cleanupWorktreeBranch（前置 `git worktree prune`——2026-11-03 eager-moon
  实测增补：空壳/外部 rm 场景 canonical 侧 worktree 元数据残留为 prunable，
  分支被死元数据标记检出 → branch -D 必被 git 拒（误报 branchNotice）；
  prune 只清 gitdir 失效死条目（幂等无害，正常删除路径 no-op），失败
  best-effort 不阻断——真被活 worktree 检出时 branchNotice 照旧兜底；
  空壳场景 git 分支照存 canonical，-D 同式清理）
任一步失败 → 退回 {ok:false, error} 呈现（可重试/手动处置），finally
resume/复位逻辑沿用现状
```

### 3.3 免二次确认（裁定论证）

删除流程入口的确认（vcsStatus 脏检 + 确认弹窗）已表达「删除该 worktree」
的完整意图；空壳分支只是**实现手段替换**（server 拒删 → 客户端代行
rm + refresh），不是新的破坏性决定。风险辩护三层：

- **双判别**（§3.1）保证 rm 只作用于 git 元数据已失的目录；
- 该目录的 git 管理内容（提交、暂存、未提交跟踪文件）**已随 `.git` 丢失
  而不可恢复**——git 视角 prunable，rm 不产生额外数据损失（happy-harbor
  残留仅 AGENTS.md/node_modules/.venv 等非 git 管理物）；
- 级联删会话（D2 语义）在 DELETE 尝试前已完成，时序上无「删了会话却没
  删掉目录」的新中间态。

### 3.4 与 §3.5 屏障的交互

兜底触发时该目录的 location 请求仍处挂起窗口（gate 生效中）——rm/refresh
均不带 location 参数，不受屏障影响也不破坏屏障；屏障在 finally 解除时
库存行已清、`noteLocationDeleted` 已登记（TTL 5 分钟吸收窗口内漏网），
与 §3.6 #2 ③ 判别源无缝衔接。

## 4. 测试口径

| 用例 | 断言 |
|---|---|
| 探测封装不带 location | fetch 层断言 `/api/shell` 请求无 query、无 `x-opencode-directory` header、body 只有 command/cwd/timeout |
| probe 三态 | exit 0/≠0/null → ok/broken/unknown；POST 失败（500，目录消失活体形状）→ unknown 不抛 |
| DELETE 400 空壳 → 自动清理 | tag 前置判别 → probe broken → rm（cwd 落点、`rm -rf "$PWD"`）→ refresh → 走 evict/unload/分支清理；免确认无二次弹窗 |
| probe ok（活 worktree）| 不 rm 不 refresh，原样失败，行保留 |
| unknown + 行仍在（端点故障误报）| 无 rm，refresh 后重拉行在 → 放弃，原样失败 |
| unknown + 重拉失败（网络）| 同判放弃（null 不放行为成功，不走成功链） |
| unknown + 行已消（目录消失型）| 无 rm，refresh → 清理成功 |
| rm 失败（exit ≠ 0）| 放弃兜底，原样失败可重试 |
| 非 WorktreeError（网络等）| 探测也不发，直接呈现错误 |
| 切换探测 broken → createSession 闸门 | 快路径拦截时不发 POST /session；探测转 ok → 登记清除、创建恢复 |
| createSession 兜底校验 | 登记未命中 + worktree 行作用域：broken → 现场登记 + 拦（不发 POST）；ok/unknown/探测缺失 → 放行不抛；canonical 不探测 |
| 启动恢复探测 | 恢复作用域（Ctrl+R 场景）经 probeRestoredWorkspaceScope 登记；同目录重切早退同样重探测 |
| canonical 不探测；探测通道异常 fail-open | 探测方法缺失不登记、不拦会话 |
| 生命周期 | 删除完成（unload）即移除登记；重建同名不误拦 |

## 5. 上游治本（本设计的退路与终局）

客户端三件套（§2/§3 + 既有 §3.4–3.6）是止血。治本四点（ref §8 issue
待提，本设计不阻塞）：resolve 对非 git 目录不兜底建档（掐灭升格）；
`LocationNotFoundError` 覆盖「目录在但 `.git` 失」（打通被动确证对空壳的
覆盖，探测可退役）；refresh 识别 `git worktree list --porcelain` 的
prunable 标记（rm 与兜底分支可退役）；`idleTimeToLive` 配置化。上游任一
落地后，对应客户端分支按 todo 收编退役。

## 6. 同步落点

- `AGENTS.md` worktree 段：红线句改为 §1.3 收窄口径 + 指向本文；
- `design-worktree-sync.md` §3.6 #3 红线句加修订注（同 §1.3）；
- openbuilder 侧 §2.2 同构约定随其 v2 对齐排期（本文只记账，不动其仓库）。
