# design-worktree-sync.md — 他端创建/删除 worktree 的同步

> 日期：2026-08-28
> 状态：已实现，待评审

## 1. 问题

左栏 worktree 列表数据源是 `Project.sandboxes`（`listProjects()` 快照）。本端创建/删除
（`createWorkspace`/`removeWorkspace`）会同步重拉，但他端操作时本端无感知——直到本端同
项目新建 worktree 才重拉刷新。现象：通过 CLI/TUI/移动端创建或删除 worktree 后，桌面端
左栏不更新。

## 2. 调研

### 2.1 server 事件契约（`../openbuilder/opencode_openapi.json` + opencode 源码核实）

| 操作 | SSE 事件 | 说明 |
|------|---------|------|
| 创建（`POST /experimental/worktree`）| `worktree.ready` / `worktree.failed` | boot 流程结束发 `ready`（`packages/opencode/src/worktree/index.ts:268`）；boot 失败发 `failed`。信封带 `{directory, project, workspace, payload}`。官方 app 靠此事件收尾 busy 态（`packages/app/src/pages/layout.tsx:390`） |
| 删除（`DELETE /experimental/worktree`）| **无任何事件** | `Worktree.remove`（`packages/opencode/src/worktree/index.ts:376`）全程不发 SSE，只返回 HTTP 成功 |

### 2.2 移动端现状（`../openbuilder`）

- `design-worktree-remove-cleanup.md`：删除走本地定向清理（`ServerStore.removeWorktree`），他端删除靠 `server.connected` 触发的 `_scheduleReconcile`（800ms 延迟全量快照）兜底，非实时。
- 创建：`_createWorktree`（`server_store.dart:270`）创建后 `refresh()`，靠 `worktree.ready` SSE？——实际 `_onEvent` 的 switch 未处理 `worktree.ready`（未实现），创建后靠 `refresh()` 全局拉取。

### 2.3 结论

- **创建**：可用 `worktree.ready` SSE 实时刷新（server 有事件）。
- **删除**：只能靠 `listProjects()` diff 检测（server 无事件）。
- **双重保证**：SSE 负责创建实时性，刷新负责删除检测 + SSE 丢消息补偿（`worktree.ready` 只发一次，断连期间丢失不补发，靠刷新兜底）。

## 3. 设计

### 3.1 SSE 监听创建（`worktree.ready`）

**改动点**：

1. `api-types.ts`：`OpencodeEvent` 联合新增 `worktree.ready`/`worktree.failed`（payload
   `{name, branch?}` / `{message}`）。
2. `sse-subscriber.ts`：`onEvent` 签名扩展第三参 `meta?: SseEventMeta`（`{project?, workspace?}`，
   取自信封 `envelope.project`/`envelope.workspace`）。无 project/workspace 字段时 meta 为
   `undefined`（不创建空对象，避免高频事件无意义分配）。
3. `app-store.ts` `handleEvent`：在目录闸门**之前**处理 `worktree.ready`/`failed`——新 directory
   尚未进本地 `sandboxes`，`isOpenedDirectory` 会误杀，改按信封 `meta.project`（projectID）
   判断"该项目是否打开"。

**闸门逻辑**：
```
projectId = meta?.project
if (!projectId || !openedProjects.some(p => p.id === projectId)) return
```

**处理**：
- `worktree.ready`：`void refreshWorkspacesForProject(project)`（重拉 `listProjects()`，
  `sandboxes` 即时含新 directory，左栏多一行）。本端创建已 `await` 刷新，此事件对他端创建生效。
- `worktree.failed`：忽略（`createWorkspace` 是同步 `await`，无 busy UI 需复位，不崩溃即可）。

**为什么不在 createWorkspace 内乐观更新 sandboxes？** SSE 事件到达即刷新更简单可靠；乐观
更新需处理 failed 回滚。创建路径已有 `await refreshWorkspacesForProject`，重复刷新幂等。

### 3.2 刷新检测删除（`syncWorktrees`）

新增方法 `syncWorktrees()`：`listProjects()` diff，对消失的 directory 执行清理。

```ts
async syncWorktrees(): Promise<void> {
  const fresh = await client.listProjects()
  // diff 每个打开项目的 sandboxes（未打开项目不影响左栏展示，跳过）
  for (const old of before) {
    if (old.id === GLOBAL || !openedProjects.has(old.id)) continue
    const next = fresh.find(p => p.id === old.id)
    for (const d of old.sandboxes) {
      if (!next.sandboxes.has(d)) toUnload.push({directory: d, projectId: old.id, isCurrent})
    }
  }
  this.projects = fresh
  for ({directory, projectId, isCurrent} of toUnload) {
    const restored = await this.unloadWorktreeDirectory(directory, projectId, isCurrent)
    if (restored) restoreScopeTabs(project.worktree, true)
  }
}
```

**`unloadWorktreeDirectory`（重构自 `removeWorkspace`）**：卸载会话/Tab/记忆/状态/pty/浏览器
视图/草稿，复位 `currentWorkspaceId`（当前项目删当前 worktree 时）。`removeWorkspace` 改调
此方法，消除重复代码。

**为什么只检测打开项目？** 未打开项目的 worktree 变化不影响左栏展示（项目行只在打开时展开
worktree 列表），且 `unloadWorktreeDirectory` 对未打开项目无意义（无 Tab/会话/记忆在内存）。

### 3.3 触发时机

| 时机 | 触发 | 说明 |
|------|------|------|
| 应用启动 | `connect()` 末尾 `startWorktreeSyncTimer()` | 启动定时器（启动时 `listProjects` 刚拉过，不额外调一次） |
| 窗口 focus | `app.tsx` onFocus → `syncWorktrees()` | 切回应用即见最新态（删除主通道，用户主动行为） |
| 定时 | 60s `setInterval` | 用户不操作时兜底（低频，兼顾 server 负载） |
| SSE 重连 | `onReconnected` → `syncWorktrees()` | 补偿断连窗口内丢失的 `worktree.ready`（只发一次不补发）+ 删除检测 |

**为什么 60s？** worktree 增删是低频操作（分钟~小时级），60s 足够感知延迟且 server 负载可忽略。
用户高频交互场景（focus/重连）已覆盖，定时仅兜底用。

**连接拆除时停定时器**：`teardownConnection` 调 `stopWorktreeSyncTimer()`，防 disconnect 后
空转（client 已 null，`syncWorktrees` 首行 return）。

## 4. 边界与防御

| 场景 | 行为 |
|------|------|
| SSE 丢 `worktree.ready`（断连窗口内他端创建） | 重连时 `syncWorktrees` 兜底（diff 出新 directory，已在 sandboxes，无副作用——`syncWorktrees` 只处理删除，新增靠 sandboxes 随 projects 更新自然出现在左栏） |
| `syncWorktrees` 在途时 disconnect | `client !== client` 闸门丢弃（同 reconciler 模式） |
| 同一目录被 global 会话和 git worktree 共用 | `unloadWorktreeDirectory` 按 `projectId` 过滤 Tab（同 `removeWorkspace`），不误关 global entry 的 Tab |
| 删除当前 worktree（当前作用域） | `currentWorkspaceId` 复位 null + `restoreScopeTabs(project.worktree)`（同 `removeWorkspace`） |
| `listProjects` 失败 | `syncWorktrees` 直接 return（不覆盖本地 projects，同 `refreshWorkspacesForProject`） |

## 5. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/shared/api-types.ts` | `OpencodeEvent` 新增 `worktree.ready`/`worktree.failed` |
| `src/shared/sse-subscriber.ts` | `onEvent` 签名 + `SseEventMeta` 类型；`onmessage` 透传 meta |
| `src/renderer/src/store/app-store.ts` | `handleEvent` worktree.ready/failed 处理；`unloadWorktreeDirectory` 重构；`syncWorktrees`；`worktreeSyncTimer`；`onReconnected` 加 syncWorktrees；`teardownConnection` 停定时器 |
| `src/renderer/src/app.tsx` | onFocus 加 `syncWorktrees()` |

## 6. 测试

- `sse-subscriber.test.ts`：meta 透传（worktree.ready 携带 project/workspace；普通事件 meta undefined）——3 用例
- `app-store.test.ts`：worktree.ready 重拉刷新、闸门（未打开项目忽略）、failed 忽略、syncWorktrees 删除检测/幂等/未打开项目跳过——6 用例

## 7. 不做的事

- **不接 `worktree.failed` 做 busy UI**：`createWorkspace` 同步 await，无 busy 态需复位。
- **不向 server 提 issue 要求删除发 SSE**：可选的根治方向，不在本次范围（删除靠刷新已够用）。
- **不做乐观展示**：他端创建的 worktree 出现在列表底部不突兀，刷新延迟可接受。
- **不定时拉取会话快照**：worktree 同步只 diff sandboxes，会话靠现有 reconciler 对账（已覆盖断连恢复）。