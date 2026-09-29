# design-worktree-branch-sync.md — worktree 创建后的分支挂载（PC/移动双端）

> 日期：2026-09-29
> 状态：设计定稿，待实现（实现时同步 AGENTS.md 已锁定语义 + spec-v0.5）
> 关联：`design-worktree-sync.md`（库存数据源与对账，本文只管分支）；移动端参考
> `../openbuilder/docs/design-worktree-remove-cleanup.md`（删除时序与定向清理）

## 0. 问题与调研结论

### 0.1 现象与定性

v2 server `POST /api/worktree` 创建的 worktree 一律 **detached HEAD，不建分支**
（活体实证见 §1）。危害定性为**静默的责任转移**：提交落在 detached HEAD 上
不可见、反直觉——一般开发者不会在 detached HEAD 上提交，而 agent 会；删除
工作区（v2 DELETE 级联删该目录全部会话）后未保留提交变 unreachable，随 GC
消失。git 原生告知链路全程失效（git 2.55 实测）：

| 环节 | git 的告知 | 实测 |
|------|-----------|------|
| `git checkout <sha>` 进入 detached | 大 advice + `switch -c` 指引 | 触发（唯一生效处） |
| `git worktree add --detach`（server 的路径） | — | 仅一行「准备工作区（分离头指针 …）」 |
| detached 内每次提交 | — | 仅 `[detached HEAD sha]` 前缀，进 agent 工具输出 |
| 客户端 GUI | — | 无任何状态呈现 |

### 0.2 上游动机核对（anomalyco/opencode PR #26931，2026-05-11）

"fix(core): always start worktrees as detached"正文自述动机仅一句：TUI 工作区
「were creating an `opencode/<name>` branch for every workspace … no longer
creates a branch」。无关联 issue（N/A），提交保留/数据安全零讨论。曾推断的
候选理由逐条核对均不成立：v1 时代 remove 同步 `branch -D`（正常流无残留）；
桌面流随机名（不传 name）撞名概率≈0；随机唯一分支无双检出场景。结论：
上游改动是未权衡代价的直觉决策，客户端侧自救。

### 0.3 社区现状

- 上游**无任何 issue** 报 detached 工作区提交不可见/丢失；邻接反馈在聚：
  #39778（workspace 静默从当前 HEAD 分出、无基分支选择）、#42976（worktree
  分支显示错乱）、#50228（请求 tab 副标题显示 worktree 分支）、#20440（V1
  时代真丢过 worktree 工作）
- git 生态先例：GitHub Community #175962（要求 GitHub Desktop 对 detached
  补警告）；git 自身两道警告（进入 advice + 离开时 "leaving N commits
  behind" 带 SHA 与抢救指引）
- 后续可给上游提 issue（弹药：PR #26931 正文 + 告知链失效表 + 先例）；
  若上游回归建分支语义，本方案的 shell 路径整体退役

## 1. v2 契约活体实测（server 2.0.18，2026-09-29，本项目 projectID）

| # | 操作 | 结果 |
|---|------|------|
| A | `POST /api/worktree {projectID, name}` | 成功；worktree **detached @ 当前 HEAD**，无分支 |
| B | `+ branch:"opencode/新名"` | 400「无效引用」——`branch` 是**检出已有引用**，非新建 |
| C | `+ branch:"feat/attachments"`（已存在） | 成功；仍 **detached @ 该分支顶端**——`branch` 仅充当基引用 |
| D | `+ from:"main"` | 400「Worktree directory unavailable: main」——`from` 是**克隆源目录**（managed cloning），非基 ref |
| F | `POST /api/shell {command:"git switch -c opencode/<name> && git rev-parse --abbrev-ref HEAD", cwd:<worktree目录>}` | 成功——worktree 挂上分支；**纯 API 可达，移动端同用** |
| E | `DELETE /api/worktree {directory, force:true}`（挂分支态） | worktree 删除，**分支残留**——v2 删除不清分支 |

契约要点：

- `Worktree.CreateInput = {projectID!, from, branch, directory, name}`——
  **无任何建分支语义**；响应 `Worktree.Info` 仅 `{directory}`
- `/api/shell`：POST `{command!, cwd, timeout, metadata}`（经用户登录 shell，
  实测 fish）→ 响应 `data:{id:"sh_*", status}`；`GET /api/shell/{id}` 查状态、
  `GET /api/shell/{id}/output?cursor=` 取累积输出（响应带 `{data}` envelope）
- vcs 端点全只读（`/api/vcs`、`/api/vcs/branch`…），无 checkout/建 ref API

## 2. 设计

### 2.1 总则

- **语义目标**：客户端 create 流程结束时，worktree 位于分支
  `opencode/{worktree-name}` 上——提交自动可见、可合并、删除前有明确保留对象
- **实现载体**：统一走 `POST /api/shell`——双端同一算法、同一契约，PC 不依赖
  本地 git 可执行文件（Electron 主进程 execFile 方案弃用，保持双端同构）
- **非阻塞**：挂载失败不回滚创建（worktree 已建成），降级 detached + 日志；
  detached 本就是 server 默认态，降级无副作用

### 2.2 创建流程（createWorkspace 增补）

1. `POST /api/worktree {projectID, name?}` → `{directory}`（现状不变）
2. `name = basename(directory)`；目标分支 `opencode/<name>`
3. `POST /api/shell {command:"git switch -c <branch>", cwd: directory,
   timeout: 15s}` → 轮询至终态（`GET /api/shell/{id}`）：
   - 成功即完成（`switch -c` 输出「切换到一个新分支」即证据）
   - 撞名（「分支已存在」，历史残留）：改 `opencode/<name>-<rand>` 重试 ≤2
     次；仍失败 → 保持 detached，日志
4. 库存刷新逻辑不变（库存只记 directory，与分支正交）

### 2.3 删除流程（removeWorkspace 增补）

现状：DELETE force（级联删会话，D2 裁定）+ 定向 list。增补（DELETE 成功后）：

1. 在**项目 canonical** 下操作（worktree 目录已消失，不能 `-C` 进去）：
   检查 `opencode/<name>` 是否存在
2. 存在 → 判断是否已并入其他 ref：`git rev-parse` 取 tip +
   `git for-each-ref --contains <tip> refs/heads refs/remotes`（排除自身）
   - 非空 = 已并入 → `git branch -D opencode/<name>` 清理
   - 空 = **未并入 → 保留分支 + UI 提示「分支已保留：opencode/<name>
     （含未合并提交）」**——零静默丢失、零长期污染
3. 用户在 worktree 内自切的其他分支不碰（只认 `opencode/<name>` 归属）

### 2.4 失败降级与边界

| 场景 | 行为 |
|------|------|
| `/api/shell` 端点不存在（旧 v2）或超时 | 保持 detached，日志，不阻塞创建 |
| `switch -c` 撞名 | 后缀重试 ≤2 → 放弃（detached） |
| 官方 desktop 建的 detached worktree（如 curious-cabin） | **不主动补挂**——只管自己 create 流程 |
| 外部 `git worktree add` 的 worktree | 同上不动（库存正常显示，见 design-worktree-sync） |
| 删除时分支检查 shell 失败 | 保留分支（宁残留不误删），无重试 |
| shell 经用户登录 shell（fish/bash/zsh）执行 | 命令保持 POSIX 子集（`&&`、`$()` 实测 fish 可用），不用 bashism |

### 2.5 双端落点

| 端 | 文件 | 改动 |
|----|------|------|
| PC | `src/shared/rest-client.ts` | 新增 `runShell`（POST /api/shell + 状态轮询封装） |
| PC | `src/renderer/src/store/app-store.ts` | `createWorkspace`（:2804）增挂载；`removeWorkspace`（:2840）增分支处理 |
| 移动 | `lib/data/api/opencode_client.dart` | `createWorktree`（:167）旁增同构 shell 方法 |
| 移动 | `lib/core/session/server_store.dart` | create 调用点（:474）增挂载；`removeWorktree`（:381）增分支处理 |

行为一致点：分支命名、撞名策略、删除保留规则；UI 提示文案各自平台风格。

## 3. 测试要点

- `rest-client.test.ts`：runShell payload/轮询/超时/无端点降级
- `app-store.test.ts`：创建成功挂分支；撞名重试；shell 失败降级 detached；
  删除已并入清理 / 未并入保留；既有 worktree 用例全保留（fake 无 shell
  端点 = 降级路径回归）
- 移动端对应用例同构

## 4. 不做的事

- 不给存量 detached worktree 补挂分支（官方 desktop/外部 git 建的）
- 不做分支显示 UI（上游 #50228 属 tab 副标题，另案）
- 不改 server、不 fork（上游 issue 另提；若上游回归 v1 `-b` 语义则本方案退役）
- 不做未合并提交的合并建议——只保留分支 + 提示，保留后动作归用户
