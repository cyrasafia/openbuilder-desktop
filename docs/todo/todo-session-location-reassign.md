# 会话位置失效时的重选恢复路径（todo-session-location-reassign）

> 状态：待办（暂不做，优先级不高，实施时另开分支）。来源：官方 v2.2.0 #56087「Let you choose a new directory or worktree when a session location is unavailable」的借鉴评估（2026-10-27 会话裁定）。

## 背景

worktree/目录在**应用外被手动删除**后，该 location 死亡。当前策略（design-worktree-sync §3.6，2026-10-25）：

- 死目录预期失败静默吸收（`_tag` 判别/删除窗口/最近删除集）
- `LocationNotFoundError` 回执被动确证 → unload + evict + 库存剥离
- 红线（2026-11-03 收窄，design-worktree-shell-rescue §1.3）：不用 location 请求探测（probe 即建档燃料专指带 `location[directory]` 的请求；runShell 零建档通道不受限）

会话本身仍在库存里，但失去可用 location。官方 v2.2.0 提供的路径：位置不可用时让用户**另选目录或 worktree** 继续该会话。

## 候选方案（实施时再定形）

- 死目录确证收敛时，会话不直接随 location 卸载，呈「位置失效」态
- 用户提供新目录/worktree 后会话重挂（server 是否支持会话迁移 location 未核实——2.2.0 契约审计项之一）

## 适用范围与优先级理由

- 仅覆盖「应用外手动删目录」路径；应用内删除走级联删会话（D2），不产生孤儿会话
- 非主要路径，用户裁定优先级不高（2026-10-27）

## 红线维持

- 不引入主动探测；重选入口必须由既有死目录确证回执触发

## canonical 场景边界（2026-10-30 源码核查，2.1.3/2.2.0 一致）

canonical 死亡/移动是**项目级**问题，不在本 todo 射程。server 自有处置（core/src/project.ts）：

- **项目 ID**：git = remote URL ?? 缓存 ?? 根提交哈希（移动不变）；非 git = 目录哈希（移动即新 ID，无自愈）
- **persist 即时重锚**：resolve 时库存 canonical 不存在 → 改写 `ProjectTable.worktree` 并发 `project.updated`
- **sweep 小时级**（仅空闲 >1h 项目）：canonical 死亡 → 有另一个存活主检出则重锚；**只剩 linked worktree 则不动**（死锚不归档）；全死则自动归档
- 我们「canonical 死亡不处置」（design-worktree-sync §3.6）与其互补：终局归档经 60s 项目 diff 收行；canonical 移动（git）的恢复入口 = 在新路径重新打开项目，已有，无需新功能

**真正缺口**：canonical 重锚只改项目行，老会话的 directory 仍指旧路径——新路径下看不到也续不了老会话。若未来覆盖 canonical 场景，实质需求是**会话 directory 迁移**（server 无现成端点，需先查可行性），届时另开 todo/设计，不并入本项

**重锚条件实测（2026-10-30 活体 + 日志）**：persist 替换 = 旧 canonical 已死 **且** 发生一次 resolve，缺一不可。iw_analyzer 案例：第二次移动后重开时旧目录仍存活（11:47 旧路径 boot 成功）→ 不重锚；旧目录删除后未再 resolve → canonical 悬空至 sweep 归档。my-nas 复制案例：原 canonical 存活 → 不替换，复制体作为同项目主检出入 WorktreeTable（普通 location 行，设计如此）。推论：① 移动恢复顺序必须「先移动后重开」，先开后删需删除后再触发 resolve；② 复制场景手动重锚可走 `PATCH /api/project/{id}` body `{canonical}`（Project.update 支持）；③ 本机项目 ID 实证 = `.git/opencode` 缓存 ?? 根提交（45 个 git 行全 40 位，无 remote 派生行）——移动/复制同 repo 不会 fork 新项目行；④ **恢复入口 = 目录选择器打开活路径，而非重开旧项目行**（同日 13:29 实证：旧 canonical 归档后左栏仅剩死路径伪行，重开伪行请求仍打死路径；在活路径 `GET /api/vcs/status?location[directory]=…` 触发一次 resolve 即完成重锚 + 取消归档）
