# 文件栏右键菜单（打开 / 打开方式 / 复制路径）— 设计文档

> 目标：右栏文件树支持右键菜单：打开、打开方式、复制路径。打开/打开方式委托系统（不在应用内消费文件）；复制路径复制绝对路径。空白处或标题栏右键时对象为当前文件树根目录。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：移动端文件消费走应用内渲染 + 系统分享面板（`design-file-view.md`），无右键/上下文菜单先例；桌面端文件树亦无菜单基建，本设计为新功能。参考项目 `openchamber` 的 openWith 语义是 Tab 打开路径集合，与本功能无关。

## 1. 问题

文件树目前只能把文件打开为应用内 Tab。用户需要用系统默认应用/指定应用打开文件（图片、PDF、二进制等应用内不渲染的类型尤甚），以及快速取文件绝对路径（贴到终端/会话里）。

## 2. 设计

### 2.1 菜单形态（D-1：应用内主题菜单，不用原生 Menu.popup）

应用内 HTML 菜单：`.popover` 基底 + `.context-menu` 变体（tokens 配色，与 model-switcher popover 同一视觉体系）。渲染层已知上下文（目标路径、平台、语言），无需 IPC 往返传菜单项文案；主进程只暴露动作通道（§2.4）。代价是菜单交互（Esc 关闭、外部点击关闭、视口钳制、方向键导航）自维护——模式沿用 model-switcher Popover（capture 阶段监听 + `useLayoutEffect` 首帧隐藏测量定位），成本可控。

### 2.2 触发点与对象

| 触发位置 | 菜单对象 |
|---|---|
| 文件行 | 该文件（`node.absolute`） |
| 目录行 | 该目录（`node.absolute`） |
| 空白处 / 「文件」标题栏 | 当前文件树根目录 = `scopeQuery.directory`（主工作区 = 项目根；worktree 作用域 = worktree 目录；global = 当前会话目录） |

- 行级 `contextmenu` stopPropagation，面板级兜底接空白/标题栏，单一入口不重复判断。
- 「项目根目录」取**当前作用域根**而非恒取 `project.worktree`：文件树按作用域渲染，菜单对象与用户所见树根一致（worktree 作用域下对空白处右键，期望打开的是正在看的目录）。

### 2.3 菜单项

| 项 | 行为 | 可见性 |
|---|---|---|
| 打开 | `shell.openPath`（文件 → 默认应用；目录 → 文件管理器） | 恒显示 |
| 打开方式… | 系统「打开方式」机制（§2.4，分平台） | 仅文件行 + 平台支持时（目录无系统级打开方式语义） |
| 复制路径 | `navigator.clipboard.writeText(absolute)`（沿用 markdown.tsx 复制模式） | 恒显示 |

### 2.4 「打开方式」跨平台策略（D-2）

系统级「打开方式」机制各平台不对称：

| 平台 | 机制 |
|---|---|
| win32 | `rundll32.exe shell32.dll,OpenAs_RunDLL <path>`——Windows 原生「打开方式」对话框（detached spawn，fire-and-forget） |
| darwin | 无系统对话框；`osascript` 调系统应用选择器（`choose application`）取 bundle id 后 `open -b <id> <path>`；用户取消选择器 = 静默无操作 |
| linux | **不显示该项**——GNOME 无系统级「打开方式」对话框（xdg-open 只有默认应用；portal OpenURI 亦无 chooser），伪造一个应用选择器违背「用系统的打开功能」初衷 |

判定依据是渲染层 `window.desktop.platform`（browser shim = "browser"，同样不显示）。

### 2.5 IPC 通道（renderer → main，动作单向）

| 通道 | 语义 |
|---|---|
| `shell:openPath` | `shell.openPath(path)`；resolve ""=成功，否则错误信息（shell.openPath 原契约） |
| `shell:openWith` | §2.4 分平台动作；linux 端防御性返回 unsupported（渲染层不会调用） |

- 返回 `Promise<string>`（错误信息）而非布尔：失败原因可诊断，渲染层当前仅静默（文件在列表后消失等罕见场景，不为此建 toast 基建）。
- 路径来源 = server 文件列表 / 作用域目录（本客户端信任域内），不加额外白名单。
- 复制路径不经 IPC：渲染层 `navigator.clipboard` 可用（markdown.tsx 先例），无需主进程 `clipboard` 模块。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 「在文件管理器中显示」（showItemInFolder） | 本需求未提；需要时同通道加一项即可 |
| Linux「打开方式」降级方案（回退打开/回退文件管理器） | 用户决策：无系统机制则不显示，不做语义替换 |
| 复制成功的 toast 反馈 | 菜单关闭本身即反馈；无全局 toast 基建 |
| 菜单项键盘可达之外的完整菜单语义（子菜单、快捷键标注） | 三项扁平菜单，不预建 |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/ipc.ts` | DesktopApi 增 `shellOpenPath` / `shellOpenWith` |
| `src/main/ipc.ts` | 两个通道实现（含 win32/darwin 打开方式） |
| `src/preload/index.ts` | 暴露通道 |
| `src/renderer/src/browser-shim.ts` | shim：两通道返回不支持 |
| `src/renderer/src/i18n/index.ts` | `fileOpen` / `fileOpenWith` / `fileCopyPath` |
| `src/renderer/src/components/file-panel.tsx` | 触发点接线 + `FileContextMenu` 组件 |
| `src/renderer/src/styles/app.css` | `.context-menu` / `.context-menu-item` |
| `src/renderer/src/components/file-panel.test.tsx` | 组件测试 |
