# 文件栏右键菜单（打开 / 打开方式 / 复制路径 / 刷新）— 设计文档

> 目标：右栏文件树支持右键菜单：打开、打开方式、复制路径、刷新。打开/打开方式委托系统（不在应用内消费文件）；复制路径复制绝对路径；刷新重列整个文件树。空白处或标题栏右键时对象为当前文件树根目录。「文件」标题栏另设刷新图标钮（2026-11-25 增补）。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：移动端文件消费走应用内渲染 + 系统分享面板（`design-file-view.md`），无右键/上下文菜单先例；桌面端文件树亦无菜单基建，本设计为新功能。参考项目 `openchamber` 的 openWith 语义是 Tab 打开路径集合，与本功能无关。
>
> 刷新入口参考来源（**2026-11-25 增补**）：移动端 `design-frontend.md` §7「下拉刷新」覆盖文件列表（§3.8 逐层进入式，非树形）。桌面端无下拉手势，改为「文件」标题栏钮 + 右键菜单项；刷新范围随形态调整——移动端只重列当前层，桌面端树同屏展示根与已展开目录多层，故重列根 + 本作用域曾展开过的全部目录。失败反馈口径：移动端 `design-network-error-handling.md`「读错误 vs 写错误的 UX 分层」把下拉刷新/文件浏览归为用户触发读，本端取舍见 §3。

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
| 打开方式… | 系统「打开方式」机制（§2.4，分平台） | 恒显示（**2026-08-31 修订**：目录行/空白处根目录同样提供——`xdg-mime` 对目录返回 `inode/directory`，Linux 枚举天然命中文件管理器；win32/darwin 系统对话框同样接受目录路径。原「目录无系统级打开方式语义」判断不成立） |
| 复制路径 | `navigator.clipboard.writeText(absolute)`（沿用 markdown.tsx 复制模式） | 恒显示 |
| 刷新 | `store.refreshFileTree()`：重列当前作用域**全部已加载目录**——根（`.`）恒在重列集合内，并上 `fileTreeNodes` 的 key（本作用域曾展开过的子目录：key 只随 `resetFileTree` 整体清空，目录收起后保留，重列无害）；懒加载语义不变（未展开目录不预取），展开记忆不动（design-file-tree-expand-memory）。根恒在 = 首载失败的重试入口：`loadFileNodes` 吞错，根首载失败时树区常驻「加载中…」且不自愈，刷新补拉根（**2026-11-25 review 一轮 #1 修订**——原「`fileTreeNodes` 全部 key」口径下此时集合为空，刷新发 0 个请求） | 恒显示（**2026-11-25 增补**）——树全局动作，与上方文件级动作以 `.context-menu-separator` 隔开置末；无论菜单对象是文件还是目录，均刷新整树 |

标题栏刷新钮（**2026-11-25 增补**）：「文件」标题行右侧 `.icon-btn` 图标钮（左栏 Plus 钮同模式，RefreshCw 12px），点击同走 `store.refreshFileTree()`。无项目空态无树，不放；根目录未加载时（含首载失败）两入口照常渲染——此时它们是唯一的手动重试入口（2026-11-25 review 一轮 #1）。刷新是显式重列而非去抖（`scheduleTreeRefresh` 是 watcher 事件合并机制，用户动作即时执行）；`loadFileNodes` 落地闸门自带切换/重连防御。

在途转圈（**2026-11-26 增补**）：触发即置位 `store.refreshingFileTree`，标题栏钮加 `.spinning`（复用 `typing-spin` keyframes，时长 1s 同既有用法，`prefers-reduced-motion` 下不转）；全部子请求落地（`loadFileNodes` 吞错必 resolve，成功/失败皆算完成）后收置位停转——转圈即真实获取进度；成功落地逐 key emit 重渲列表，展开状态全程保留。**最短呈现**：本地 server 重列数十 ms 即落地，置位/清除同帧 emit 被 App 订阅侧 rAF 合帧成一次渲染（false 已就位）转圈一帧画不出（dev 联调实测不可见），过短闪现肉眼亦不可辨——落地不足 500ms（`FILE_TREE_SPINNER_MIN_MS`）补足到最短再收，延迟期间 singleflight 照常占位，代次守卫同样约束补足定时器。singleflight：在途（空白+重列+补足全程）期间重复触发不另起轮次——当轮仍在推进 = 合并进当轮；数据已落地的补足尾段点击被忽略，标记收后即可再刷（措辞按 review n2 精确化）。

先清空再渲染（**2026-11-26 增补**，用户反馈「否则看不出来刷了」）：触发即清空 `fileTreeNodes`——树区回「加载中…」占位、展开记忆不动（key 集与节点快照在清空前取），`FILE_TREE_REFRESH_BLANK_MS`（150ms）后才发起重列。空白窗口是必要的：清空与落地若同帧 emit 会被 rAF 合帧吞掉，空白一帧不染、手势不可见（与转圈不可见同根源）。窗口内挂载效应不抢跑根首载（`FilePanel` 挂载效应闸 `refreshingFileTree`）：重列集合根恒在，抢跑会让根行提前回填、清空帧被吞；效应依赖含 `refreshingFileTree`（review m1）——同作用域 `resetFileTree` 收标记作废本轮后 hasLoaded 不再变化，不入依赖效应不重跑，根无人拉树卡「加载中…」。

两入口（标题栏钮/右键菜单）同走 store 方法，动效一致；菜单项点击后菜单即关，动效呈现在常驻的右栏。切作用域随 `resetFileTree` 作废在途轮（转圈即收 + 代次前进），代次守卫约束空白发起、落地、补足收标三处定时器。

失败回填（**2026-11-26 review M1**）：触发前快照节点（`prev`），落地 settle 时代次守卫通过后把缺失的 key 从快照补回并立即 emit——`loadFileNodes` 吞错不写入，不回填则根失败树区常驻「加载中…」不自愈、子目录失败呈「…」空壳（watcher 补拉闸门要求 key 已在 `fileTreeNodes`，丢了没人救）；本地 server 少见，远程连接超时/5xx 是现实场景。回填 = 上次内容（§3 失败反馈口径），成功 key 用新内容。部分失败的 key 保留展开态渲染。

滚动还原（**2026-11-26 review q1/R6-1 方案 B**）：先清空再渲染塌缩内容高度，浏览器把 `scrollTop` 钳到 0；且置位与清空同帧 emit（触发帧 `hasLoaded` 已是 false），layout effect 存不到——初版「触发沿存」实现因此不生效（二轮探针证伪；`ef33811` 正文与本文旧版的「dev 实测确认」系误记，未实际执行，见评审记录）。现版：两入口共用 `refreshTree()`，**点击时**（清空前）存滚动位并置 pending；layout effect 分支——轮收/作废只清 pending（不带旧值跨轮跨作用域，补足尾段用户已滚动不回写）；内容帧归位（layout 提交前，无跳顶闪烁），根先落地时高度不足被钳制则留 pending，待后续目录落地（`fileTreeNodes.size` 入依赖重触发）的内容帧重试。**收标滞后拍**（2026-11-26 三轮评审）：收标 emit 与最后落地 emit 至少隔一拍（`FILE_TREE_CLEAR_GAP_MS` = 50ms > rAF 合帧窗）——重列 ≥ 最短转圈时两者同帧合帧曾吞掉还原/重试机会（慢 server 跳顶复现，已修）。组件测试以 scrollTop 钳制语义模型覆盖探针 6 条 + 子目录晚落地；真实钳制行为仍待 dev 复核（窗口后台 rAF 节流时曾出现合帧假象，见评审 q-a）。

已接受的边缘（记录在案）：① 空白窗口内 watcher 去抖定时器（300ms）落地会把单行提前回填、局部吞掉该行清空帧——纯视觉、瞬态、自愈；② 刷新期间到达的 watcher 事件若落在「server 已读盘、响应未落地」之间，该目录不排去抖、等下一个事件才更新——与既有目录首载竞态同类，窗口 ≈ 一次往返；③ 失败回填孤儿 key：目录已从磁盘删除时重列失败回填会把旧节点补回（根新列表无此行、不渲染），此后每次手动刷新多发一个必败请求——与 d9db2ad–95861f4 行为等价（review n-a 接受不修）。①② 均不修（2026-11-26 review m2）。原 todo 文档（测试 fake timers 迁移）已随动效用例迁 fake timers 完成而删除。

### 2.4 「打开方式」跨平台策略（D-2）

系统级「打开方式」机制各平台不对称：

| 平台 | 机制 |
|---|---|
| win32 | `rundll32.exe shell32.dll,OpenAs_RunDLL <path>`——Windows 原生「打开方式」对话框（detached spawn，fire-and-forget） |
| darwin | 无系统对话框；`osascript` 调系统应用选择器（`choose application`）取 bundle id 后 `open -b <id> <path>`；用户取消选择器 = 静默无操作 |
| linux | ~~不显示该项~~（**2026-08-27 修订**：显示该项，走**应用内自建选择器**——xdg-mime 查 MIME → 枚举 .desktop → 弹窗选择 → gio launch，见 [design-linux-open-with.md](design-linux-open-with.md)；spec-v0.3 #8） |

目录对象（目录行/空白处根目录）在 linux 走同一选择器：对目录调 `xdg-mime query filetype` 返回 `inode/directory`（2026-08-31 真机验证），.desktop 枚举按 MimeType 命中文件管理器（Nautilus 等），无额外分支。

`inode/directory` 的应用枚举/启动链路无需改动（§2.3 2026-08-31 修订）：main 侧 `listOpenWithApps`/`openWithApp` 不区分文件与目录，`gio launch <desktop> <目录>` 与文件同契约。

判定依据是渲染层 `window.desktop.platform`（browser shim = "browser"，不显示）。

> 2026-08-31 修订触发点：用户需求「为文件夹也增加 open with 功能，包含点击文件树空白处（= 打开项目根目录）」。此前 §2.3 判定「目录无系统级打开方式语义」，实测不成立（`xdg-mime` 对目录返回 `inode/directory`，win32/darwin 系统机制也接受目录路径），故放开目录限制。

### 2.5 IPC 通道（renderer → main，动作单向）

| 通道 | 语义 |
|---|---|
| `shell:openPath` | `shell.openPath(path)`；resolve ""=成功，否则错误信息（shell.openPath 原契约）。Linux/darwin 改走自管 spawn（净化 env，防 dev 变量泄漏破坏外部应用——见 design-linux-open-with §1.2 修订） |
| `shell:openWith` | §2.4 分平台动作（win32/darwin）；linux 走 §2.4 修订的自建选择器（shellListOpenWithApps/shellOpenWithApp，见 design-linux-open-with） |

- 返回 `Promise<string>`（错误信息）而非布尔：失败原因可诊断，渲染层当前仅静默（文件在列表后消失等罕见场景，不为此建 toast 基建）。
- 路径来源 = server 文件列表 / 作用域目录（本客户端信任域内），不加额外白名单。
- 复制路径不经 IPC：渲染层 `navigator.clipboard` 可用（markdown.tsx 先例），无需主进程 `clipboard` 模块。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 「在文件管理器中显示」（showItemInFolder） | 本需求未提；需要时同通道加一项即可 |
| ~~Linux「打开方式」降级方案~~（v0.3 修订：自建选择器落地，见 design-linux-open-with） | — |
| 复制成功的 toast 反馈 | 菜单关闭本身即反馈；无全局 toast 基建 |
| 刷新失败的错误反馈（toast / 错误态，2026-11-25 增补；2026-11-26 修订） | 无全局 toast 基建（同上行口径）。`loadFileNodes` 沿既有吞错口径；**2026-11-25 原文「重列失败时树区保留上次内容」在先清空再渲染落地后曾一度失效**（清空 + 失败不写入 = 丢树，review M1）——已由触发前快照 + 落地回填恢复该语义（§2.3 失败回填）：失败 key 回填上次内容，树保持可用。根未加载时树区常驻「加载中…」，刷新入口兼手动重试（§2.3，review 一轮 #1）。移动端 design-network-error-handling 对用户触发读给「error state / fixed SnackBar + 手动重试」，本端暂只取手动重试一半 |
| 菜单项键盘可达之外的完整菜单语义（子菜单、快捷键标注） | 三项扁平菜单，不预建 |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/ipc.ts` | DesktopApi 增 `shellOpenPath` / `shellOpenWith` |
| `src/main/ipc.ts` | 两个通道实现（含 win32/darwin 打开方式） |
| `src/preload/index.ts` | 暴露通道 |
| `src/renderer/src/browser-shim.ts` | shim：两通道返回不支持 |
| `src/renderer/src/i18n/index.ts` | `fileOpen` / `fileOpenWith` / `fileCopyPath`；`fileRefresh`（2026-11-25 增补） |
| `src/renderer/src/components/file-panel.tsx` | 触发点接线 + `FileContextMenu` 组件；标题栏刷新钮（2026-11-25 增补） |
| `src/renderer/src/store/app-store.ts` | `refreshFileTree()`（2026-11-25 增补） |
| `src/renderer/src/styles/app.css` | `.context-menu` / `.context-menu-item` |
| `src/renderer/src/components/file-panel.test.tsx` | 组件测试 |
| `src/renderer/src/store/app-store.test.ts` | `refreshFileTree` 动效时序用例（fake timers，2026-11-26 增补） |

## 5. 评审记录

- 2026-11-26 两轮只读评审（reviewer 子代理探针/变异 + 主会话实跑核对），过程与
  证据见 [../review/review-file-tree-refresh.md](../review/review-file-tree-refresh.md)。
  一轮 M1（失败丢树）按回填方向闭环；M2（空用例）经 fake timers 重写并在修订提交
  自证变异。二轮 R6-1（滚动还原不生效，初版实现被探针证伪）按方案 B 重做并补
  钳制模型用例；R6-2（空白窗口字面量钉住）、n-a/n-b/n-c/n-d/n-e 已处置（n-a 记
  已接受边缘 ③，n-e 维持随版本 bump）。待三轮评审确认。
