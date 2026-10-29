# design-worktree-branch-fork-base.md — worktree 挂载分支记录 fork 基准

> 日期：2026-10-29
> 状态：已评审（2026-10-29，意见与修订见 §9）；范围扩大为挂载 + 消费侧
> 一并落地（见 §9 末段），实现与文档同批落地
> 关联：[`design-worktree-branch-sync.md`](design-worktree-branch-sync.md)（本文修订其 §2.2 挂载命令）；移动端同构设计 `../openbuilder` `docs/design/v2/design-branch-diff-fork-base.md`（问题发现与活体证据来源，该文档移动端评审中、尚未落库，引用以落库版为准；其 §3.2 diff 消费侧本端已随本文 §3.2 落地）
> 契约锚：挂载侧仅依赖 `/api/shell` + git 本地行为（2.0.18 起本端已实证，design-worktree-branch-sync §1 F），不新增契约面；问题链证据转引移动端 2026-10-29 活体实测（server v2.0.26）+ sst/opencode dev 源码

## 1. 问题

design-worktree-branch-sync（2026-09-29）的挂载命令是
`git switch -c opencode/<name>`——**无起点**，从 detached HEAD 拉分支。
git reflog 只记 `branch: Created from HEAD`。三层后果（转引移动端 §1，判别实证见 §2）：

1. **fork 来源结构性不可推断**：服务端 `/api/vcs/base` 的 reflog 推断
   （`namedRef()`）明确拒绝 `HEAD`/裸 SHA/revision 表达式——只认分支名。
2. **分支 diff 落 defaultBranch 兜底**：`Vcs.diff` 内部
   `options?.base ?? defaultBranch()`——`??` 右侧是
   `symbolic-ref refs/remotes/origin/HEAD`，该 symref 只在 clone /
   `git remote set-head` 时更新，上游默认分支变更后本地残留死 ref，
   merge-base 解析失败 → 503 `No merge base available for <死ref>`；
   且 `defaultBranch()` 不校验 ref 存在，死 ref 无后备。
3. **diff 不自动用 reflog 推断**：reflog 推断只被 `/api/vcs/base` 端点暴露，
   不在 diff 链路上。

而 worktree 的真实起点是**确定的**：服务端创建命令
`git worktree add --detach -- <dir> <ref ?? "HEAD">`，`ref` 缺省即 canonical
的 HEAD——也就是主工作区（canonical）**当前分支的 tip**（快照语义，移动端
逐字节实证）。fork 来源本来就知道，只是挂载时没记下来。

**为什么挂载侧与消费侧一并做**：挂载是 fork 记录的**生产点**——现在不改，
之后每建一个 worktree 都永久缺失 fork 记录（reflog 不可回填，§7）；本端
branch diff UI **已存在**（`DiffTabType` 三段之一，`loadDiffTab` 走
`listVcsDiff(directory, "branch")` 不带 base——正是 §2.2 实证的 503 路径），
消费点同样在链路上，一并落地（初稿曾按「本端无 diff UI」判后置，评审间
核对现状证伪，范围已扩大）。

## 2. 调研证据（2026-10-29，转引移动端活体实测 + dev 源码；本端未重复实验）

### 2.1 服务端源码链（dev 分支）

| 层 | 关键行为 |
|----|----------|
| worktree 创建（`core/src/git.ts` `worktreeCreate`） | `git worktree add --detach -- <dir> <ref ?? "HEAD">`——`--detach` 无条件；`branch` 参数作起始 ref 但永不检出（本端 2.0.18 实测 B/C/D 同结论） |
| diff base 解析（`VcsGit.diff`） | `const base = options?.base ?? defaultBranch()`；merge-base 失败 → 503 `No merge base available for <ref>` |
| reflog 推断（同 adapter `base()`） | 读分支 reflog `branch: Created from X`；`namedRef()` 拒 HEAD/oid/表达式，且要求创建点同时是 HEAD 与候选 ref 的祖先；失败 → 503 `Choose a review base` |
| 默认分支（`defaultBranch()`） | `symbolic-ref refs/remotes/<origin>/HEAD` 成功即用，**不校验 ref 存在**（死 ref 不落后备） |

### 2.2 活体判别实验（plan-travel 项目）

worktree 经 API 创建、分支从 `iterate` 拉出
（`git switch -c opencode/x iterate`）、加一个 probe 提交后：

| 调用 | 结果 |
|------|------|
| `GET /api/vcs/base` | ✅ `{name: iterate, ref: refs/heads/iterate, source: "reflog"}` |
| `GET /api/vcs/diff?mode=branch`（不带 base） | ❌ 503 `No merge base available for origin/develop`（仍走 defaultBranch 死 ref） |
| `GET /api/vcs/diff?mode=branch&base=iterate` | ✅ 200，恰好只含 probe 文件改动 |
| `git rev-parse HEAD`（新 worktree） | == canonical HEAD，逐字节相等（起点 = canonical 当前分支 tip） |
| `git reflog show refs/heads/opencode/x` | `branch: Created from iterate` |

**结论**：挂载时从分支名拉分支即可让 fork 来源可推断；消费必须先查
`/api/vcs/base` 再显式传 `base`——两步都不能省（分别对应本文 §3.1/§3.2）。

### 2.3 竞态实证

实验期间 canonical 从 `iterate@b361b7fe` 移到 `master@c04d7140`，随后创建的
worktree 起点自动变为 `c04d7140`（快照跟随创建时刻）。若挂载时盲从「当前
读到的 canonical 分支名」拉分支，worktree 内容会被挪到旧/新 tip
（`git switch -c <new> <start>` 会检出 start 内容），**背离服务端创建时的
快照**——起点一致性校验是必须的守卫（§3 第 4 步）。

## 3. 设计

### 3.1 挂载改造：从 canonical 当前分支拉新分支（fork 记录）

修订 design-worktree-branch-sync §2.2 的挂载命令。`mountWorktreeBranch`
增补入参 canonical 目录（调用方 `createWorkspace` 已持有 `project.worktree`，
即 canonical；空/缺失 → base = null 走现状命令），流程：

1. slug 守卫（现状不变）：`^[a-z0-9][a-z0-9-]*$` 不过 → 整段跳过。
2. **读 fork 基准**：`git symbolic-ref --short HEAD`，cwd = canonical
   （5s 超时）。exit ≠ 0（canonical 自身 detached）→ base = null。输出
   trim 后使用；canonical HEAD 的 symbolic-ref 只会返回本地分支名
   （remote-tracking 检出 `origin/x` 不成立，无需特判——移动端 §6 核对）。
3. **base 名守卫**：`^[A-Za-z0-9][A-Za-z0-9._/-]*$`——分支名来自 git 输出，
   不受信，拼进命令前过滤；不过 → base = null。通过守卫的字符集在
   fish/POSIX shell 下均为字面量，与 slug 守卫同一防线。
4. **起点一致性校验**：`git rev-parse HEAD <base>`，cwd = worktree（5s）。
   exit 0 且输出中 hex 行（40 位，sha256 仓库 64 位）恰两行且**严格相等**
   （worktree 快照 == base 当前 tip）→ 保留 base；exit ≠ 0（base 分支已删）
   或不等（canonical 在创建与挂载之间前移/切分支，或 worktree 经 recover
   路径找回、起点已过期，§2.3）→ base = null。解析取 hex 行而非裸取前
   两行——rev-parse 输出混入 stderr 噪声行时不受扰。
5. **挂载**：base != null → `git switch -c opencode/<name> <base>`；
   base == null → 现状命令 `git switch -c opencode/<name>`。reflog 分别记
   `branch: Created from <base>` / `branch: Created from HEAD`。
6. 撞名 rand 后缀重试（≤2）逻辑不变，**重试沿用同一 base**（rand 换的是
   分支名不是起点）；shell 通道异常 / 全部失败 → 保持 detached + console.warn
   （现状降级）。

Shell 数 happy path 1 → 3（symbolic-ref + rev-parse + switch），各步失败
即短路（步骤 2 失败则 3/4 跳过，直接现状命令，2 发）。整体仍置于
`refreshWorkspacesForProject`/`setCurrentWorkspace` **之后**并在
`createWorkspace` 内 await——左栏出现与作用域切换不依赖挂载（现状不变）；
最坏超时叠加（撞名重试路径 8 发 × 5s）与现状同量级，可接受（见 D5）。

### 3.2 消费侧改造：branch 模式先解析 base 再请求

`loadDiffTab` 的 branch 分支（diff Tab 三段之一）改为（对齐移动端 §3.2，
结构差异见 §6）：

1. `rest-client` 新增 `vcsBase(directory)` → `GET /api/vcs/base`（pin 的
   openapi_v2.json（2.1.3）契约面内已核对）：
   - 200 `data` 非 null → `{name, ref, source}`（envelope 内层形状，解包
     `res.data` 后），取 `ref`（`refs/heads/<name>` 全名直接透传）；
   - 200 `data: null`（pin 200 schema `Vcs.Base | null`）或 503
     （`Choose a review base`：无 reflog 记录且不在默认分支上）或网络等
     其余异常 → **null 静默降级**——503/null 是「不可推断」的正常表达
     （存量 `Created from HEAD` 分支常态出现），非错误；
   - **例外上抛**：LocationNotFoundError（死目录结构化 404）不吞——
     `withLocation` 的被动确证回调（onDeadLocation，design-worktree-sync
     §3.6）与消费方 `isExpectedLocationMiss` 吸收判别都依赖它原样到达。
2. `listVcsDiff` 增可选 `base`（`/api/vcs/diff` query 追加，契约已有参数）。
3. `loadDiffTab`：type == branch 时先 `vcsBase`，非 null 传
   `{base: ref}`；null 不传（服务端落 defaultBranch，现状行为）。
   uncommitted（`mode=working`）与 round（`/api/session/{id}/diff`）无
   base 语义，不查。
4. **单 Tab 重载语义下每次加载重查 `vcsBase`**——本端 diff 是单 Tab 三段
   切换（`switchDiffType`），无移动端「列表→详情」两屏并存结构，不存在
   两屏 base 不一致问题（移动端 D5 的路由透传在本端无对应物，判据同理：
   同一加载上下文内 base 只解析一次、随请求显式传递）。

### 3.3 降级矩阵

| 场景 | base 记录 | `/api/vcs/base` 解析 |
|------|-----------|----------------------|
| 正常：canonical 在分支上、创建后立刻挂载 | `Created from <base>` | reflog 命中 → 分支 diff 对比 fork 分支 ✅ |
| canonical detached / base 名含元字符 / 起点不一致 / rev-parse 失败 / 挂载失败 | `Created from HEAD` 或无分支 | 503/null → 不传 base（现状：defaultBranch，死 ref 则 503 + 错误态） |
| 用户手工从某分支切出的分支（非本端 worktree） | git 自记 `Created from X` | reflog 命中 ✅（顺带收益） |
| fork 分支后被 rebase/force-push 重写 | 记录仍在 | ancestor 校验失败 → default 兜底/503（现状行为） |

## 4. 测试要点

`app-store.test.ts` 挂载 describe 改造（mock `runShell`）：

- 成功路径：三步 shell 序列——`symbolic-ref`（cwd=canonical）→
  `rev-parse HEAD <base>`（cwd=worktree，两行相等）→
  `switch -c opencode/<name> <base>`（cwd=worktree）
- canonical detached（symbolic-ref exit ≠ 0）→ 直接现状命令（无起点），
  仅 2 发、无 rev-parse
- base 名守卫不过（symbolic-ref 输出含空格/元字符）→ 同上
- 起点不一致（rev-parse 两行不等）→ 同上；rev-parse exit ≠ 0（base 分支
  已删）→ 同上
- canonical 空/缺失 → 不发 symbolic-ref，直接现状命令
- 撞名重试沿用同一 base：`switch -c x <base>` → show-ref 判撞名 →
  `switch -c x-<rand> <base>`（base 不变）
- shell 通道异常 → 降级 detached 不阻塞创建（既有用例保留，fake 无
  runShell = 降级路径回归）
- 既有删除侧用例不受影响（cleanupWorktreeBranch 未动）

`app-store.test.ts` diff Tab describe 补消费侧（mock `vcsBase`）：

- branch 模式先 `vcsBase`（目录 = 作用域目录）再显式传
  `{base: refs/heads/…}`（全名透传）
- `vcsBase` null（不可推断）→ 不传 base（现状行为）；uncommitted 不查
  `vcsBase`
- `vcsBase` 死目录 404（`_tag` 判别）上抛 → `isExpectedLocationMiss`
  吸收：无错误态、diff 请求不发

`rest-client.test.ts`：

- `vcsBase`：200 envelope 解包；200 `data: null` → null；503 → null
  静默；LocationNotFoundError（`_tag` 体）上抛——空体/无 tag 404 不在
  上抛列（吞为 null）
- `listVcsDiff`：`base` 可选透传（缺省不传）

实现后活体回归（本机）：创建一个 worktree，`git reflog show
refs/heads/opencode/<name>` 验 `Created from <canonical 当前分支>`；
diff Tab 切分支段验 base 生效（死 `origin/HEAD` 项目不再 503）。

## 5. 关键设计决策

- **D1 创建后从 canonical 拉分支（方案 B），而非先建分支再传 `branch`
  参数建 worktree（方案 A）**：A 依赖 `branch` 参数跨版本行为（本端 2.0.18
  实测其只控起点不控检出）且 worktree 创建失败需回收预建分支；B 纯客户端
  后置自救，失败模式只有降级到现状。（转引移动端 D1，双端同判）
- **D2 显式起点，挂载侧记录**：reflog 推断不在 diff 链路上、`??` 兜底是
  defaultBranch（§2.2 判别实证）——fork 来源必须在挂载时写进 reflog；
  消费侧显式传 base 同判，两侧同批落地（D6）。
- **D3 起点严格相等校验（rev-parse 两行比对），不盲从分支名**：
  `switch -c <new> <start>` 会检出 start 内容；canonical 前移后盲从会把
  worktree 内容挪离服务端快照（§2.3 实证）。只接受严格相等，不等即降级。
  校验与挂载间的残余 TOCTOU（canonical 再前移）窗口仅一次本地 shell
  往返，内容至多差一个提交且 reflog 记录仍正确，接受不加锁（评审 nit 5
  备案）。
- **D4 base 名守卫**：与 slug 守卫同思路——git 输出不受信，字符集外即放弃，
  注入面归零。
- **D5 维持 `createWorkspace` 内 await，不引入 unawaited**：与移动端
  （unawaited 挂创建流程外）的差异点是本端现状——createWorkspace 本就
  await 挂载且挂载在刷新/切换之后（用户可见路径不阻塞）；引入 fire-and-forget
  换不来用户可感收益，反而丢测试确定性与失败可观测性。shell 3 连发毫秒级，
  最坏超时叠加与现状撞名路径同量级。
- **D6 生产点与消费点一并落地**：挂载侧记 fork 来源（生产），branch diff
  显式传 base（消费）——只做生产侧时新建 worktree 的记录立即正确、但
  diff 仍 503（死 ref 项目）；只做消费侧时存量 `Created from HEAD` 全部
  落 defaultBranch 兜底。两侧同批落地，链路一次闭环（初稿曾因「本端无
  diff UI」误判后置，§1 末段）。

## 6. 与移动端的差异

| 点 | 移动端 | 本端 |
|----|--------|------|
| 挂载时序 | unawaited（会话创建路径时序约束） | createWorkspace 内 await（D5） |
| base 解析容错 | 输出两行 SHA 相等 | 取 hex 行（40/64 位）恰两行且相等（stderr 噪声防御，实现细节级差异） |
| 消费侧结构 | 列表/详情两屏，base 经路由透传（其 D5） | 单 Tab 三段切换，每次加载重查 `vcsBase`（§3.2 第 4 点） |
| `vcsBase` 静默范围 | 503/任何异常 → null | 503/`data: null`/其余异常 → null；LocationNotFoundError 上抛（死目录确证与吸收判别依赖，本端特有机制） |

## 7. 不做的事

- 存量已挂分支（`Created from HEAD`）不回填 reflog——porcelain 无此能力，
  `update-ref -m` 伪造记录属 hack，不做（移动端同判）。
- 不设 upstream（`--set-upstream-to`）——推送语义超范围。
- 不修 `origin/HEAD` 过期本身（用户侧 `git remote set-head origin --auto`
  可自愈；服务端 `defaultBranch()` 不校验 ref 存在属上游缺陷，另提 issue）。
- 不给非本端创建的 worktree 补挂/补记录（现状边界不变）。
- 删除链路不动：分支命名规则未变，`cleanupWorktreeBranch` 的
  show-ref / `branch -D` 逻辑不受影响。
- 不做分支选择器 UI（移动端 D7 同判；降级路径可接受，有需求再议）。

## 8. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/renderer/src/store/app-store.ts` | `mountWorktreeBranch` 增 canonical 入参 + fork 基准读取/守卫/起点校验；`createWorkspace` 调用点传 `project.worktree`；`loadDiffTab` branch 分支先 `vcsBase` 再显式传 base（§3.2） |
| `src/shared/rest-client.ts` | 新增 `vcsBase`（`GET /api/vcs/base`，静默降级 + LocationNotFoundError 上抛例外）；`listVcsDiff` 增可选 `base` |
| `src/renderer/src/store/app-store.test.ts` | 挂载 describe 按 §4 改造；diff Tab describe 补消费侧用例；fake client 增 `vcsBase` 默认 null |
| `src/shared/rest-client.test.ts` | `vcsBase` 四路径 + `listVcsDiff` base 透传 |
| `docs/design/v2/design-worktree-branch-sync.md` | §2.2 挂载命令加修订指针（指向本文，实现时同步） |
| `AGENTS.md` | 「分支挂载」锁定语义段补 fork 基准 + 消费侧一句（实现时同步） |

## 9. 评审意见

2026-10-29 reviewer 只读评审：事实链全数核对属实（契约面 / 服务端源码三
断言 / 现状描述 / 移动端差异表），设计 D1–D6 无异议，建议澄清后合入。
已修订：

1. （非阻塞 1）todo「已随该设计实施」改「随其实施生效」——文档与实现
   分批落库时不构成假陈述；§8 branch-sync 行补「实现时同步」标注
   （与 AGENTS.md 行一致）。
2. （非阻塞 2）两处移动端引用注明「评审中、尚未落库」——防交叉引用
   悬空。
3. （nit 3）todo 补 200 `data: null` → null 契约情形（pin 的 200 schema
   是 `{location, data: Vcs.Base | null}`）+ envelope 内层形状说明。
4. （nit 4）todo「lastMessage」改本端命名「round」（一词一义，
   `DiffTabType` 对齐）。
5. （nit 5）D3 备案校验与挂载间的残余 TOCTOU 窗口（毫秒级、后果限于
   内容差一个提交，接受不加锁）。

**范围变更（评审后，用户确认）**：核对现状发现本端 branch diff UI 已存在
（`DiffTabType` 三段之一、`loadDiffTab` 不带 base——正是 §2.2 实证的 503
路径），初稿「消费侧后置 todo」的前提（本端无 diff UI）不成立，范围扩大
为挂载 + 消费一并落地；todo 文件撤销，§1/§3.2/§4/D6/§6/§8 相应改写。

**第二轮（实现后，全文评审）**：事实链与实现符合度全数核对属实，无阻塞项。
修订：① 头部关联/§2.2 结论/D2 三处「归 todo」残留改写（范围扩大时的改写
遗漏，其一悬空引用已删文件）；② §3.1 步骤 4 hex 过滤放宽至 40/64 位
（sha256 仓库不再恒降级——移动端裸两行比对天然支持，本端过滤不应引入
行为差异），实现与 §6 差异表同步；③ rest-client 测试补空体 404 → null
负路径断言（§4 列出而无断言）。
