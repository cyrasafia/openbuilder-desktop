# design-new-project.md — 项目选择器「新建项目」（选文件夹 → 建项目 → 直接打开）

> 日期：2026-08-29
> 状态：已评审（两项决策经用户确认），待实现

## 1. 问题

左栏项目全集 = `GET /project`（opencode 数据库已注册项目）∪ global 会话目录（发现快照）。
目录只有被 server 注册过（创建过会话/被其他客户端打开过）才会出现——本客户端没有任何
"把一个新文件夹变成项目"的入口。用户想在新目录（如刚建的空项目目录）开工会话，目前做不到。

需求：项目选择器内增加「新建项目」——点击打开系统文件管理器选文件夹，选中后以其新建项目
并**直接打开**。

## 2. 调研

### 2.1 移动端现状（`../openbuilder`）

按设计前置约定先查同类：`lib/` 无目录选择器/新建项目相关实现（移动端无本地文件系统语义，
目录都来自 server 侧会话记录）。无现成设计可借鉴，本设计为新岸。

### 2.2 server 侧项目注册机制（opencode 源码核实）

server **没有** `POST /project`——项目是隐式注册的：

| 环节 | 事实 | 出处（`../opencode/packages/opencode/src`） |
|------|------|------|
| instance 路由 | 带 `?directory=` 的 instance 端点按目录引导实例：`InstanceStore.load({directory})` | `server/routes/instance/httpapi/middleware/workspace-routing.ts`；`project/instance-store.ts:54` |
| 项目注册 | 引导实例即调 `Project.fromDirectory(directory)`：解析目录 → **upsert 项目行**（git 仓库 → 独立项目；非 git → 归入 `global` 项目，worktree 恒 `/`） | `project/project.ts:213-310`（`project.ts:217` 非 git 分支） |
| 解析返回 | `GET /project/current?directory=X` 的 handler 即 `(yield* InstanceState.context).project`——注册与解析二合一，无其他副作用 | `server/routes/instance/httpapi/handlers/project.ts:19-21` |
| git init | `POST /project/git/init?directory=X` 可对非 git 目录执行 `git init` 使其成为独立项目 | `project/project.ts:366-375` |

即：**新建项目 = `GET /project/current?directory=<选中文件夹>`**，一次调用完成注册 + 返回
项目信息，不产生会话等副产物。

### 2.3 客户端既有设施

- 系统目录选择器 IPC 已有：`window.desktop.openPathPicker()` → main `dialog:openPath`
  （`properties: ["openDirectory", "createDirectory"]`），浏览器 shim 返回 null（取消语义）。
- 打开流已有两条（先切换后加载）：`openProject(projectId)`（独立项目行）、
  `openGlobalDirectory(directory)`（global 目录 entry；`globalDirectoryRowsAll` 对零会话
  已打开目录有 updated=0 兜底行）。
- 项目选择器（`sidebar.tsx` `ProjectPicker`）：700×560 固定尺寸弹窗（标题行/搜索框/列表），
  打开时刷新 global 发现快照。

## 3. 决策（用户确认）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **非 git 文件夹不动文件系统**：不自动 `git init`，注册后归入 global，直接以 global 目录 entry 打开 | `git init` 是对用户文件系统的侵入性副作用，不应在"打开文件夹"动作里静默发生；global entry 行视觉与项目行一致，会话/文件树全可用，后续用户可自行 git init（server fromDirectory 下次解析自动转正为独立项目） |
| D2 | **入口仅项目选择器内**（弹窗底部动作行），左栏标题行保持单 "+" 按钮 | 标题行空间有限且 "+"（打开项目）已是主路径；新建是低频动作，收进选择器避免误触 |

## 4. 设计

### 4.1 REST 层（`rest-client.ts`）

```ts
resolveProject(directory: string): Promise<Project> {
  return this.request<Project>(`/project/current${RestClient.dirQuery(directory)}`, {
    timeoutMs: 30000,
  })
}
```

超时放宽到 30s（默认 15s）：全新目录首次引导会初始化 LSP/插件/format 等实例服务
（`project/bootstrap.ts`），冷启动可能超过 15s。

### 4.2 store 层（`app-store.ts`）

```ts
async createProjectFromDirectory(directory: string, signal?: AbortSignal): Promise<void> {
  const client = this.client
  if (!client) throw new Error("未连接服务器")
  const project = await client.resolveProject(directory)
  if (signal?.aborted) return                    // 弹窗已关：静默中止
  if (this.client !== client) throw new Error("连接已断开，请重试")  // 在途闸门
  const fresh = await client.listProjects()      // 失败上抛（R1）
  if (signal?.aborted) return
  this.projects = fresh                          // 左栏/打开流的数据源必须先含新项目
  this.emit()
  if (project.id === GLOBAL_PROJECT_ID) return this.openGlobalDirectory(directory)  // D1
  return this.openProject(project.id)            // 直接打开
}
```

- 失败（resolveProject / listProjects 抛错、在途闸门）一律向上抛，由选择器呈现，
  弹窗不关可重试。**listProjects 失败必须上抛**（评审 R1）：吞掉后 `this.projects`
  仍是旧列表（不含新项目），继续 `openProject` 会落进"opened 指向不存在项目"的
  不一致态（currentProject 为 null、左栏无行，要等 60s syncWorktrees 才自愈）。
- 在途闸门（注册期间断连/切 profile）改抛错而非静默返回（评审 R2）：静默会让
  选择器按成功关窗、什么都没打开且无提示。
- **signal 中止**（评审 R3）：选择器弹窗被关闭（Escape/遮罩/重开）时卸载并 abort
  在途创建——各 await 之间检查，中止后不再打开/切换作用域（此时弹窗已卸载，
  错误无呈现方，静默返回）。
- 打开流复用既有语义：`openProject`/`openGlobalDirectory` 自带先切换后加载、持久化、
  快照刷新、Tab 记忆恢复；重复创建幂等（server upsert + opened 已含 key 仅切换）。
- **不新增 busy 状态字段**：注册通常秒级；选择器局部 `creating` 态即可（§4.3）。

### 4.3 UI 层（`sidebar.tsx` `ProjectPicker`）

弹窗底部新增动作行（`.dialog-footer`）：

```
[ （错误信息，可省）            ] [ ⊕ 新建项目 ]
```

交互：

1. 点击 → `window.desktop.openPathPicker()`（系统文件管理器）。
2. 取消（null）→ 无操作，留在选择器，`creating` 复位。
3. 选中 → `await store.createProjectFromDirectory(dir)` → 成功关弹窗（左侧栏即时多一行/切作用域）。
4. 失败 → 错误信息内联展示（红字，`--error`），弹窗不关，按钮恢复可点重试。
5. `creating` 期间按钮禁用 + `LoaderCircle` 旋转（复用 `typing-spinner`），文案「正在打开…」。

不进搜索框键盘流（↑↓/Enter 只作用于候选列表）；按钮 Tab 可达。

### 4.4 样式（`app.css`）

`.dialog-project .dialog-footer`：flex 行，左右 28px 边距（与标题/搜索/列表同缘），错误
信息 `flex:1` 省略号截断，按钮 `btn-tonal` 族 + 14px 图标。

## 5. 边界与防御

| 场景 | 行为 |
|------|------|
| 选中的是已打开项目的子目录 | server `fromDirectory` 解析到 git 根项目（子目录进 `sandboxes`），`openProject` 打开项目根——与 CLI 打开子目录同机制，子目录以工作区行出现 |
| 选中的是 global 已知目录（已有会话） | `openGlobalDirectory` 幂等（opened 已含 key = 仅切换作用域） |
| 非 git 新目录（零会话） | global entry 打开后 `globalDirectoryRowsAll` 兜底行保证左栏可见可导航（updated=0） |
| 注册期间断连/切 profile | 在途闸门抛错"连接已断开，请重试"（评审 R2：静默会让弹窗按成功关闭），弹窗不关可重试 |
| 弹窗在途被关闭（Escape/遮罩） | 卸载即 abort 在途创建（AbortSignal，评审 R3），各 await 之间检查后静默返回——不打开不切作用域 |
| 目录不存在/无权限等 resolve 失败 | 错误内联展示，弹窗不关可重试 |
| 浏览器 shim（无 Electron） | `openPathPicker` 返回 null = 取消，无操作 |
| server 版本过旧不认 `?directory=` | 契约源 `opencode_openapi.json` 已含该参数（与移动端同源），不做降级 |

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/shared/rest-client.ts` | 新增 `resolveProject(directory)` |
| `src/renderer/src/store/app-store.ts` | 新增 `createProjectFromDirectory` |
| `src/renderer/src/components/sidebar.tsx` | `ProjectPicker` 底部新建入口（busy/错误/取消） |
| `src/renderer/src/i18n/index.ts` | `newProject`/`newProjectCreating`（zh/en） |
| `src/renderer/src/styles/app.css` | `.dialog-project .dialog-footer` 等 |
| `docs/spec-v0.1.md` | §3 项目管理行补「新建项目」入口一句 |

## 7. 测试

- `app-store.test.ts`：
  - git 文件夹 → `resolveProject` 调用 + projects 刷新 + `openProject`（opened/current 落位）
  - 非 git 文件夹（返回 global）→ `openGlobalDirectory`（global entry 打开，文件系统无前提）
  - resolveProject 失败 → 异常上抛、状态不变
  - listProjects 失败 → 异常上抛、不打开（评审 R1）
  - 在途闸门：注册后 client 置 null → 抛错不打开（评审 R2）
  - signal 中止 → 不刷新不打开（评审 R3）
- 手工验收：选 git 目录 → 独立项目行出现并激活；选非 git 目录 → global 行出现并激活；
  取消选择无副作用。

## 8. 不做的事

- **不自动 `git init`**（D1）：`POST /project/git/init` 能力存在，但文件系统副作用须用户显式
  发起；后续如做，入口放项目行右键菜单而非本流程。
- **不在左栏标题行加入口**（D2）。
- **不做"新建项目"命名/图标编辑**：项目名 = 目录末段（server 语义），改名走 `PATCH /project`
  属另一功能。
- **不新建会话**：注册与打开即可，首条消息在引导页 composer 发送时自然建会话（既有流程）。
