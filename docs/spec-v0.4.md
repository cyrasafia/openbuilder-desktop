# v0.4 功能范围

主题：**开箱即用**——从安装应用到第一次对话的完整闭环，外加输入面补全（附件）。承接 v0.1–v0.3 已落地能力（连接/聊天/项目/工作区/文件树/Tab 体系/diff 与各类预览/终端/浏览器等）。本文档确认 v0.4 范围与验收口径；各功能技术细节见对应 `design-*.md`（随实现产出）。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 欢迎屏（首次启动引导） | **触发条件：无激活 profile**（2026-09-05 修订，原"仅启动时判定"：`activeProfileId` 为空即触发——首次安装、删光 profile 后重启、**运行中删光/清空激活 profile** 均即时回欢迎屏；连接态降级即有 profile 但 server 失联不触发，走重连路径），连接失败走现有 `connectionError` 展示。**全页向导（非三栏主界面**，三栏依赖服务器，无服务器空壳状态已移除）。**欢迎页只呈现「添加服务器」入口，点击后同源复用「添加服务器」引导式流程（2026-09-06 修订，原"入口二选一 → managed/attach 分支 → provider 检查"链路废弃，见 [design-welcome-screen.md](./design-welcome-screen.md)）**：发现视图双扫描（见 #3，scanServers + scanBinaries 并行、先到先列），attach/managed 候选混排（来源徽标 + 版本），点击候选一键「建档 + 激活 + 连接」（managed 候选 spawn + 健康 + connect；固定 id 重试不堆 profile）；双路皆空给**安装指引文案 + 安装命令复制按钮**（不自动安装，见范围外）；「手动配置…」进手动页（复用 ProfileFormView，模式段置顶，主按钮 = 连接/启动并连接）。**连接成功直接进主界面**（2026-09-06 修订：provider/默认模型检查删除）——连接成功且无已打开项目时直达项目选择器（`connect({openPickerAfter})`，同设置页新增流；否则中栏为「打开项目」引导页）。欢迎屏底部「打开设置」入口 |
| 2 | managed 模式配置流程完善 | ① profile 表单按模式分化（2026-09-05 修订：**添加服务器改为引导式**，见 [design-guided-add-server.md](./design-guided-add-server.md)——点「添加」先进发现视图，同时并行扫描运行中的 server（#3）与本机 opencode 二进制，attach/managed 候选混排、搜到即列；**2026-09-06 修订：点击候选/手动新增保存即启用**——激活新 profile + 断开旧连接（先于改激活，managed 旧进程正确 stop）+ `connect({openPickerAfter})`，连接成功且无已打开项目时直达项目选择器；**2026-09-06 修订 2：启用流挂起期间设置弹窗保持打开**（loading 行 + 动作全冻结），成功关弹窗直达项目列表，失败回到原视图（discover/manual 草稿保留）+ `connectionError` 左栏可见；编辑既有 profile 仍只 upsert 不激活，激活走列表「切换」（**2026-09-07 修订**：原「启用」按钮更名「切换」并改走同一挂起流——成功关弹窗**直达主页面**（不带 `openPickerAfter`，不弹项目列表），失败留列表可重试）；手动入口常驻，进手动配置页：模式选择置顶为 segment control + 两模式一句话说明）：managed 隐藏 baseUrl/username/password（随机端口+自动凭据不变），新增**二进制路径**字段（默认自动发现，可手动指定/从扫描候选选择，取代 `OPENCODE_BIN` 环境变量 hack，env 仍优先生效）；attach 表单不变。② **版本检测**：扫描/spawn 前跑 `opencode --version` 展示；连接后 health 返回 version 校验最低版本（单全局 SSE 需 ≥ v1.0.66），低于**仅提示不阻断**。③ **崩溃自动重启**：managed server 非主动停止退出（现状：exit 事件发了但 renderer 没接）→ 主进程按退避自动重启（参考 design-terminal-tab §1.2a 退避思路，1s 起指数上封），重启成功通知 renderer 重连（走既有全量对账）；主动 stop（断开/切 profile/退出应用）不重启；重启期间连接状态可见（现有 connecting/disconnected 体系内表达 + 提示文案）。④ **日志可观察**：接入现有 `managed:event`（log/exit 当前无人订阅）——managed profile 的连接区/设置内提供 server 日志尾部只读查看（最近 N 行 + 复制），异常退出给可见提示 |
| 3 | 自动扫描 | **managed 二进制扫描**（欢迎屏与 profile 表单共用）：PATH + 常见安装落点（`~/.opencode/bin`、`~/.local/bin`、npm global bin、`/opt/homebrew/bin`、`/usr/local/bin`）→ 去重候选列表，逐项 `--version` 展示。**attach server 扫描**（欢迎屏与 attach 表单共用）：loopback 探测（默认端口 4096；不做网段端口扫描）+ **mDNS 发现**（main 进程 bonjour-service 浏览 `_http._tcp`，按 server 原生发布格式过滤 `opencode-{port}` 服务名——server 侧 `--mdns` 且非 loopback hostname 才发布，与 opencode 同库互通）；每个候选 `GET /global/health` 验证并显示版本，一键填入 URL。扫描均手动触发（进入向导/表单时自动跑一轮 + 手动重扫按钮），不后台常驻 |
| 4 | Provider/Model 配置 | 设置弹窗新增 **Provider 页签**：provider 列表（名称、source、key 配置状态、模型数，`GET /config/providers` 按当前作用域目录查）+ **API key 设置/删除**（`PUT /auth/{providerID}` `{type:"api", key}` / `DELETE /auth/{providerID}`，仅 API key 形态）。**Model 配置 = 默认模型选择**（复用现有「默认」页签 agent/model）。范围外见下（OAuth、config 编辑等） |
| 5 | 会话附件（文件与贴图） | 三个入口：**粘贴**（clipboard 图片 → 附件；文本粘贴不变）、**拖拽外部文件**进输入框（工作区文件树拖入仍是 source 引用不变，v0.3）、输入框**附件按钮**（系统文件选择器，多选）。通路（参考 openbuilder [design-attachments](../../../openbuilder/docs/design-attachments.md) + [design-image-attachment-thumbnail](../../../openbuilder/docs/design-image-attachment-thumbnail.md)，协议已验证：**无独立上传端点**，`FilePartInput` data URL 内联进 `prompt_async` parts）：读字节 → mime 推断 → 图片压缩（尺寸/质量上限）→ base64 data URL → `{type:"file", mime, url, filename}`；**客户端体积上限**（base64 后，默认 4MB；图片压缩后同限校验，超出拒绝并提示）。展示：输入区附件条（图片缩略图/文件 chip，可删，复用引用 chip 模式）；用户气泡 file part 渲染区分 source 引用与 data URL 附件（复用 v0.3 引用回灌渲染路径）；**图片缩略图 + 点击放大**；重开历史会话时接收侧缩略图**惰性生成**（从 data URL 惰性解码，不做同步全量解码——openbuilder 踩坑：内存膨胀+乐观→权威过渡缩略图丢失）。乐观消息附件随上屏 |
| 6 | 设置页快捷键列表 | 设置弹窗新增「快捷键」页签（[design-keyboard-shortcuts §8](./design-keyboard-shortcuts.md)）：平台分支展示全部快捷键——全局组（Tab/面板/作用域遍历/项目与工作区管理 Alt 系，mac ⌘ 系键位与非 mac Ctrl+Tab 系互斥行）+ 输入与视图组（Enter 系/Ctrl+F/终端复制粘贴/Esc）；数据源 `SHORTCUT_GROUPS` 与分发同文件维护防漂移 |
| 7 | 项目/worktree 管理快捷键（Alt 系重构） | **修饰键域划分：Alt 系 = 项目/worktree 管理专域（强关联且互斥），Ctrl 系维持 Tab/面板/编辑域**（[design-keyboard-shortcuts §0/§1.2](./design-keyboard-shortcuts.md)，2026-09-06 重构，spec-v0.3 #2 主体不回溯修订）。新增四键：**Alt+O（mac ⌘⌥O）打开项目选择器——自 Ctrl+O 迁移，不保留别名，Ctrl+O 放行**（Electron 默认菜单无该加速键，核查见 §0.2）；**Alt+C（⌘⌥C）关闭当前激活 entry**（global 目录 entry 亦可；单 entry 不动作，对齐左栏"最后一个不关"；纯客户端状态无二次确认）；**Alt+N（⌘⌥N）当前项目新建 worktree**（name 省略 server 随机 slug，成功默认切换过去；global/未连接不动作）；**Alt+⌫（⌘⌥⌫）删除当前作用域 worktree**（项目根作用域/global/删除中不动作）——**二次确认保留，确认弹窗增 Enter 确认 / Esc 取消**（ConfirmDialog 通用增强，§4.1）。既有 **Alt+↑/↓ 作用域遍历**归入 Alt 域、语义不变。弹窗遮挡（overlayCount>0）时四键仅消费不动作。键位核查结论（§0.2）：⌘⌥D 为系统"显示/隐藏 Dock"弃用、按 code 匹配（mac ⌥ 系 key 产特殊字符）、Linux AltGr 上报 ctrl+alt 被 !ctrl 排除、live 终端归 pty/dead 终端释放、浏览器 Tab before-input-event 转发过滤扩展 |

## 范围外（明确不做）

- **opencode 二进制自动安装/升级**（v0.1 已定范围外，0.4 维持）：仅检测 + 安装命令指引/复制；升级只做版本展示与低版本提示
- **provider OAuth / wellknown 登录流**（`/provider/{id}/oauth/*`）：仅 API key；OAuth 回调服务器、token 刷新留后续
- **opencode config 表单化编辑**（`GET/PATCH /config`、`/global/config`）与 MCP 管理、自定义模型定义——外部编辑器解决（不做大而全）
- LAN 主动网段端口扫描（mDNS 之外不扫网）
- 附件的 `SymbolSource`/`ResourceSource` 引用（维持 v0.3 范围外）；clipboard 非图片文件（文件管理器复制）粘贴；附件转工作区引用/落盘
- 欢迎屏多步骤产品介绍页（一屏完成，不做轮播引导）

## 新增 API 映射

| 功能 | API |
|------|-----|
| Provider 列表（含 key 状态） | `GET /config/providers?directory=` |
| API key 设置/删除 | `PUT /auth/{providerID}`（`{type:"api", key}`）｜`DELETE /auth/{providerID}` |
| 扫描验证/版本 | `GET /global/health`（复用，返回 version） |
| 二进制版本 | 本地 `opencode --version`（spawn 探测，非 HTTP） |
| 附件发送 | `POST /session/{id}/prompt_async` parts 扩 data URL 形态 `FilePartInput`（`url = data:<mime>;base64,…`，v0.3 仅用 source 形态） |
| mDNS 发现 | 非HTTP：bonjour-service 浏览 `_http._tcp`（与 server 发布同库互通） |

## 验收口径

- [ ] 全新数据目录启动（无 profile）出现全页欢迎屏（无三栏）：入口页仅「添加服务器」+ 设置入口（未进入流程不扫描）；点击进入发现视图双扫描混排（运行中 server + 本机 opencode 候选，多行卡片按模式标题区分 + 明细行地址/路径 + 版本，2026-09-06 修订），点 managed 候选一键启动连接、attach 候选一键连接；连接成功直接进主界面（无 provider/默认模型引导），中栏为「打开项目」引导页；删除全部 profile（重启或运行中）欢迎屏复现；已有激活 profile 启动不出现
- [ ] 发现视图双路皆空（无 server 无本机 opencode）：给安装指引与命令复制，安装后「重新搜索」可继续；「手动配置…」进手动页（模式段置顶）手填 URL+凭据可测试并连接
- [ ] attach 扫描发现：本机 `opencode serve`（默认端口）出现在候选并可一键填入连接；LAN 内他机 `opencode serve --mdns`（非 loopback hostname）被发现、验证、填入、可连接
- [ ] 设置「添加」进发现视图：运行中的 server 与本机 opencode 候选混排、先到先列（两路并行，互不等待）；点击 attach/managed 候选或手动新增保存**即启用**（关设置弹窗 → 连接，成功且无已打开项目直达项目选择器）；编辑既有 profile 保存不激活；手动入口任意时刻可见，进手动配置页模式段置顶（segment + 一句话说明）
- [ ] managed profile 表单：URL/凭据字段隐藏，二进制路径可改且生效（改路径后连接用新二进制）；显示发现候选与版本
- [ ] kill 掉 managed server 进程：自动退避重启并重连，期间状态可见，恢复后消息/会话与 server 一致（对账无重复丢失）；主动断开不触发重启；server 日志尾部可查看、异常退出有提示
- [ ] 连接低于最低版本的 server（含 attach）有版本提示但不阻断使用
- [ ] Provider 页签：列表与 key 状态正确（含按作用域目录）；设置 key 后对应 provider 模型可选用并能完成一次对话；删除 key 后失效（欢迎流程内引导已随 2026-09-06 修订删除——配置入口 = 主界面设置）
- [ ] 粘贴截图/拖入外部图片/附件按钮选图：输入区出现缩略图 chip 可删除；随消息发送后用户气泡正确渲染附件、AI 能读到内容并正确回应；超限文件（>4MB base64 后）被拒绝并提示原因
- [ ] 任意非图片文件（拖入/按钮）同通路发送成功且渲染为文件 chip；工作区内文件树拖入输入框仍走 source 引用（不内联 data URL）
- [ ] 重开含图片附件的历史会话：缩略图正常显示（惰性生成）、点击放大可用；无同步解码卡顿
- [ ] Alt 系四键全链路：Alt+O 打开项目选择器且 **Ctrl+O 不再触发、放行无副作用**；Alt+C 关闭激活 entry（global 目录 entry 亦可、单 entry 不动作）；Alt+N 当前项目新建 worktree 并切换到新 worktree；Alt+⌫ 删除当前作用域 worktree（项目根/global 不动作）；弹窗遮挡（选择器/设置/确认等）时四键仅消费不动作
- [ ] Alt+⌫ 二次确认弹窗：**Enter 确认**（非阻塞删除、左栏行禁用 + loading，与删除按钮同路径）、**Esc 取消**；loading 中两键无效
- [ ] 键位边界：live 终端内 Alt 系不生效（xterm 归 pty 属预期）、dead 终端生效；浏览器 Tab 内生效（转发）；Alt+↑/↓ 回归不受影响
- [ ] 设置「快捷键」页签展示 Alt 系新键位（平台分支正确，与分发表同源无漂移）
