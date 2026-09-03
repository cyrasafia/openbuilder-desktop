# v0.3 功能范围

承接 v0.1/v0.2 已落地能力（聊天/项目/工作区/文件树/Tab 记忆/diff/图片与 markdown 预览等）。本文档确认 v0.3 范围与验收口径；各功能技术细节见对应 `design-*.md`（随实现产出）。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 栏收起/展开 | 左/右栏收起后**完全不展示**（无残留窄条）；收起/展开按钮放在标题栏（导航条）右侧、最小化按钮左边，左右栏各一个。折叠态与各栏宽度持久化（`layout.state` IPC 键），重启还原；补齐拖拽调宽 |
| 2 | 快捷键体系 | Ctrl+T 新建 Tab、Ctrl+W 关闭激活 Tab（chat 沿用流式确认+归档语义）、Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PgUp / Ctrl+PgDn 切换。**Ctrl+Shift+T 恢复刚关闭的 Tab**：关闭栈记录已关 Tab，chat 恢复=重开（取消归档）、file/diff/browser 按标识重开、**终端恢复=在原 cwd 新建一个终端**（原 pty 已随关 Tab 销毁）；会话已被删除则跳过该项。**Ctrl+Alt+↑/↓ 在左栏项目/工作区间切换**：按左栏显示顺序（项目行 → 其下工作区行，自上而下）移动当前作用域，等价于点击对应行（先切换后加载），到边界循环。不做 Ctrl+数字跳转（与系统/输入法快捷键易冲突） |
| 3 | Tab 拖动与重命名 | Tab 条内 HTML5 拖拽重排序（仅当前作用域可见 Tab 间；2026-08-29 修订为**实时预览 + 所见即所得**落位，与左栏项目行拖拽同模式），顺序写入 Tab 记忆。**重命名仅限 chat Tab**（= 会话重命名，`PATCH /session/{id}` title），双击标签行内编辑，Enter 提交 / Esc 取消 |
| 4 | 文件引用 | 把当前作用域文件/目录引用进消息（`FilePartInput.source`，零字节、服务端注入内容，契约移植移动端 `design-file-reference`）。三种入口：输入框打 `@` 弹文件搜索浮层选中；文件树右键「引用到会话」；文件树拖拽进输入框（2026-08-29 修订：悬停即见引用条末位**占位 chip 实时预览**，drop 落位与预览一致）。引用以 chip 呈现于输入区（可删），支持纯引用发送；用户气泡渲染引用回灌 |
| 5 | 终端 Tab | 内嵌终端（xterm.js + server pty API：`POST /pty` 创建、connect-token + WebSocket 连接、`?cursor=` 断线续传回放、`PUT` resize、`DELETE` 销毁）。新建终端 cwd = 当前作用域目录，Tab 归作用域；**关闭 Tab = 杀掉 pty**（运行中二次确认）；**终端恒深色渲染，不随主题切换** |
| 6 | 浏览器 Tab | WebContentsView 内嵌浏览器（地址栏 + 前进/后退/刷新 + 打开本地文件），Tab 归作用域。**文件树点击 `.html/.htm` 默认在浏览器 Tab 打开（`file://` URL）**；右键菜单提供「查看源码」，在文件 Tab 打开 HTML 源码（文件 Tab 仅源码、无预览，原 iframe 预览方案废弃）。导航安全：远端页面禁跳 `file://`，外链走系统浏览器 |
| 7 | PDF 预览 | 文件 Tab 内预览 PDF：文件 Tab 内嵌专用 WebContentsView + 顶层 `file://` 导航（Chromium 内置 PDFium 查看器渲染；iframe/embed/pdfjs 路线实测不可行，见 design-pdf-preview §0）。仅预览态；非二进制/错误走占位（随文件监听刷新），内容变更重开 Tab 即见 |
| 8 | Linux Open With | 文件树右键「打开方式…」在 Linux 恢复显示：`xdg-mime` 查 MIME → 解析 .desktop 枚举支持该类型的应用 → 应用内选择器 → `gio launch` 启动。修订 design-file-panel-context-menu §2.4 原「Linux 不提供」决策；win32/darwin 原路径不变。**2026-08-31 修订**：目录行/空白处（作用域根目录）同样提供——目录 MIME 为 `inode/directory`，命中文件管理器，枚举/启动链路零改动 |
| 9 | 会话任务列表展示 | ChatFooter 第三类卡片（见 [design-task-list.md](design-task-list.md)）：agent 用 todowrite 维护的任务清单在会话底部展示，默认收起（头部 done/total 计数，点击展开进度条 + 逐条状态行）；任务全部完成（completed/cancelled）时整卡隐藏；有待处理授权/问题卡时不渲染（不遮挡人机交互卡） |
| 10 | 会话 Tab 右键菜单（重命名/Fork） | chat Tab 右键弹菜单（[design-session-tab-context-menu.md](design-session-tab-context-menu.md)）：**重命名** = 双击行内编辑的菜单入口；**Fork 会话** = `POST /session/{id}/fork` 复制会话（省略 messageID = 全量复制），**fire-and-forget**——发起不等结果、不自动切换；新 Tab 由 SSE `session.created` 经实时补开自然打开（末尾追加、不抢焦点，实测 0.3s），消息在复制期间逐步流入；REST 响应（同步长端点，大会话实测 24s+，不设超时）仅做数据收敛。源会话不动；仅 chat Tab 有菜单，其余 kind 右键仅屏蔽默认菜单 |

## 范围外（明确不做）

- Tab 拖出主窗口成新窗口；编辑器 Tab（CodeMirror 可编辑，留后续版本）
- 浏览器 Tab 的书签/历史/多窗口、缩放控制
- 终端分屏/多路复用、自定义主题色（恒深色）
- 文件引用的 `SymbolSource`/`ResourceSource`（仅文件与目录）
- macOS/Windows 的应用选择器自建（沿用系统机制）

## 新增 API 映射

| 功能 | API |
|------|-----|
| 文件搜索（@ 引用） | `GET /find/file?query=&directory=`（相对路径，客户端拼绝对路径） |
| 会话重命名 | `PATCH /session/{id}`（`title`，rest-client 已具备） |
| 终端创建/列表/销毁 | `POST /pty`（cwd/command）｜`GET /pty`｜`DELETE /pty/{id}` |
| 终端连接 | `POST /pty/{id}/connect-token`（头 `x-opencode-ticket: 1`）→ WS `/pty/{id}/connect?ticket=&cursor=`（控制帧 `0x00`+JSON 携带 cursor） |
| 终端 resize | `PUT /pty/{id}`（`size: {rows, cols}`） |
| Shell 列表 | `GET /pty/shells` |
| 会话任务列表 | `GET /session/{id}/todo`（全量列表）；SSE `todo.updated`（sessionID + 全量 todos） |
| 会话 fork | `POST /session/{id}/fork`（body `{messageID?}` 省略 = 全量复制；响应 = 新 Session，title 自动后缀） |
| 文件引用发送 | `POST /session/{id}/prompt_async` parts 扩 `FilePartInput`（`url` = absolute `file://`，`source.type=file`，mime 占位 `text/plain`） |

## 验收口径

- [ ] 左/右栏可收起展开（收起后完全不展示），宽度与折叠态重启还原；拖拽调宽生效
- [ ] 全部快捷键工作；Ctrl+Shift+T 依次恢复刚关闭的 chat（取消归档）/file/browser Tab，已删会话跳过；恢复终端=原目录新建终端（新 pty）；Ctrl+Alt+↑/↓ 在左栏项目/工作区间循环切换作用域
- [ ] Tab 拖拽重排后切走再切回、重启顺序保持；双击 chat Tab 重命名，服务端同步、他端可见
- [ ] 三种引用入口各添加一个文件 + 一个目录，chip 正确、纯引用可发送，AI 收到文件/目录内容；@ 浮层搜索可用键盘选择
- [ ] 新建终端落在当前作用域目录，输入输出/中文/resize 正常；切走再切回内容经 cursor 回放不丢；关 Tab 后 `GET /pty` 无该会话；浅色主题下终端仍深色
- [ ] 点击 .html 开浏览器 Tab 渲染正确（本地相对资源可加载）；右键「查看源码」在文件 Tab 打开源码；地址栏导航、前进/后退、打开本地文件可用；远端页面无法跳转 `file://`
- [ ] PDF 文件在文件 Tab 内渲染预览（PDFium），非二进制/错误占位随文件监听更新；内容变更重开 Tab 即见
- [ ] Linux 右键「打开方式…」列出支持该 MIME 的应用，选择后文件被对应应用打开；目录行/空白处（根目录）同提供，选择后文件管理器打开该目录（2026-08-31 修订）
- [ ] agent 更新任务（todowrite）时会话底部出现任务卡：默认收起、头部计数正确，展开可见进度条与逐条状态；全部完成后整卡隐藏；授权/问题卡在队时任务卡不渲染，应答后自动回归
- [ ] chat Tab 右键弹菜单：重命名进入行内编辑（同双击）；Fork 后新 Tab 打开激活、标题带 "(fork #N)"、消息全量复制，源会话不动；其余 kind Tab 右键无菜单
