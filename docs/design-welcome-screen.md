# 欢迎屏（首次启动引导）设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #1。从安装应用到第一次对话的完整闭环入口。依赖已合并的功能 #3（扫描）、#2（managed spawn/版本）。**2026-09-06 修订：流程与「添加服务器」引导式统一**（[design-guided-add-server.md](./design-guided-add-server.md)）——欢迎页只呈现「添加服务器」入口，点击后**同源复用**设置弹窗的引导式流程（DiscoverView 搜索 + ProfileFormView 手动配置，单一来源非复制）；provider/默认模型引导删除（连接成功直接进主界面的「打开项目」引导页）。

## 1. 触发与生命周期

- **触发 = 无激活 profile（无服务器）**（2026-09-05 修订，原"仅启动时判定"）：首次安装、删光 profile 后重启、**运行中删光/清空激活 profile**（`saveProfiles` activeId→null 时置 `welcomeOpen`，同一 emit 内切渲染分支）均触发。三栏主界面依赖服务器，无服务器时是空壳（左栏 connectFirst 空态/右栏空文件树）——该状态已随该修订移除，"稍后配置"入口一并删除（其唯一作用正是进入空壳）
- `store.welcomeOpen: boolean`，doInit 尾部置 `!activeProfileId`；`closeWelcome()` 显式关闭。**连接成功（`connectionState === "streaming"`）由 WelcomeScreen 挂载侧 effect 直接关闭**（2026-09-06 修订：原"检查完成后关闭"随 provider 检查删除；仍由组件侧驱动——store 不代劳，与既有测试语义一致）
- 渲染：`ready && welcomeOpen` 时 `WelcomeScreen` 全页替代 `Shell`（App.tsx 分支）；**TitleBar 照常渲染**（Linux frameless 下拖拽区/窗口控制不可缺）——欢迎屏 = 标题栏 + 居中卡片容器，非三栏
- 连接失败走现有 `connectionError` 展示（欢迎屏卡片底部错误行 + 重试=再点候选），不弹独立错误弹窗
- 连接态降级（有 profile 但 server 失联）**不**回欢迎页——走既有状态行 + 重连/设置路径（SSE 重连恢复体验不因欢迎屏中断）

## 2. 入口视图（entry，默认视图）

- 应用标识 + 副标题 + **唯一动作「添加服务器」**（满宽主按钮）+ 底部「打开设置」文字按钮（→ `openSettings()`；设置弹窗在欢迎屏之上正常打开，App 欢迎分支提供 SettingsDialog 宿主）
- **入口页不扫描**：扫描只在进入流程后发现视图启动（用户未表达意图前不做 mDNS 4s 窗口等成本动作）
- 原「入口二选一」（managed 推荐 / attach）随流程统一废弃（2026-09-06）——模式选择融入发现视图的候选分区与手动配置页的模式段，不再前置逼迫用户理解 attach/managed 术语

## 3. 添加服务器流程（discover → manual，同源复用）

点击「添加服务器」进入与设置弹窗**同一套组件**（自 settings-dialog.tsx 导出，非复制）：

- **discover = `DiscoverView`**（design-guided-add-server §2）：双扫描并行、先到先列、attach/managed 候选混排（来源徽标 + 版本）、重搜/迟到丢弃/严格模式安全均同源；标题行返回钮回入口页
- **manual = `ProfileFormView`**（§3）：模式段置顶 + 一句话说明、managed 二进制路径（扫描候选 + 浏览）、attach URL/凭据 + 测试连接；返回/取消回发现视图（丢弃草稿，同设置弹窗 isNew 语义）
- **欢迎屏注入的差异仅 props**（单一来源原则——行为差异全部参数化，不 fork 实现）：
  - 动作语义：`onPick`/`onSave` = 建档（固定 id `welcome-managed`/`welcome-attach` upsert，重试/往返不堆 profile）+ 激活 + `connect()`（设置弹窗仅建档不激活）。**建档时序按模式保留原分支语义（review 追问后恢复）**：attach 先带凭据 `health()` 验证，通过才建档——失败不残留死 profile（候选虽经扫描无凭据预验证，复验一并关闭"扫描后 server 下线"窄窗）；managed 建档先于 connect（spawn 失败保留固定 id profile，设置内可调整重试）
  - `busy`：连接中（connectionState connecting）或 attach 预验中禁用候选与动作（设置弹窗不传）
  - `emptyContent`：双路皆空时覆盖默认空态，展示安装指引（首装用户兜底，设置弹窗不传）——文案 + 平台命令（linux/macOS `curl -fsSL https://opencode.ai/install | bash`、brew、npm 三行，逐行复制按钮；范围外：不自动安装）
- 连接反馈（卡片底部，视图无关）：connecting「连接中…」提示行；attach 预验失败 / 连接失败展示对应错误可重试；成功 streaming → §1 关闭路径

## 4. ~~连接成功后的 provider 检查（引导视图）~~（已移除，2026-09-06）

- 原设计：streaming 后查 `listProviderCatalog("/")`，connected 空 → provider 引导视图；有 key 无默认模型 → 默认模型引导；均引导进设置对应页签，可跳过
- **删除依据**：连接成功后用户的第一任务是打开项目（无项目时 provider/默认模型页签本就无作用域可用），引导反而插入一跳；provider/模型配置入口在主界面设置内常驻可达。连接成功 → 欢迎屏关闭 → Shell 无项目空态即「打开项目」引导页（design-layout §4 末），一步到位
- 原「检查失败静默跳过」路径随检查一并消失（无异步悬挂面）

## 5. ~~中栏引导页入口~~（已移除，2026-09-05）

- 原设计：跳过后 GuideView「连接服务器」按钮回欢迎屏。随「稍后配置」删除，三栏 Shell 仅在有激活 profile 时渲染，该入口成为死代码——已移除（含 `openWelcome()` 与 `.guide-connect-row` 样式）。降级重连走状态行 + 设置

## 6. 实现落点

| 文件 | 内容 |
|---|---|
| `src/renderer/src/components/welcome-screen.tsx` | WelcomeScreen（entry/discover/manual 三视图状态机；入口页；`pick` = 建档固定 id upsert + 激活 + 连接；InstallHint 安装指引 emptyContent；streaming effect 直接 closeWelcome；卡片底部 connecting/connectionError 反馈行） |
| `src/renderer/src/components/settings-dialog.tsx` | 导出 `DiscoverView`/`ProfileFormView`/`newProfileDraft` 供欢迎屏同源复用；DiscoverView 新增 `busy`/`emptyContent` props、ProfileFormView 新增 `saveLabel`/`busy` props（设置弹窗自身用法不变） |
| `src/renderer/src/store/app-store.ts` | `welcomeOpen` + `closeWelcome`；doInit 无 profile 置位；`saveProfiles` 清空激活置位（回欢迎页）；`openSettings(tab?)` 初始页签提示字段（providers/defaults 直达仅剩主界面设置入口在用） |
| `src/renderer/src/app.tsx` | ready 后分支渲染 WelcomeScreen / Shell |
| i18n / app.css | 删 choose/guidance 废弃键（zh/en）；`.welcome-discover-actions`/`.welcome-error` 新增，`.welcome-entry*`/`.welcome-action`/`.welcome-link` 随旧视图移除 |

## 7. 测试

- 组件（mock store/desktop，注入扫描与连接动作），13 用例：
  - 入口视图：标题/副标题 + 唯一「添加服务器」入口 + 打开设置；**未进入流程不扫描**；点击进发现视图后双扫描并行启动
  - 发现视图：server/binary 候选混排（来源徽标+版本）；返回回入口页
  - 候选连接：server 候选先 health（fetch 桩）后建 attach profile（固定 id + baseUrl）+ connect；**health 失败不建档不连接**；binary 候选建 managed profile（binaryPath + 空名）+ connect；固定 id upsert 重试不堆 profile
  - 空态：双路皆空给安装指引命令 + 复制按钮（emptyContent 覆盖默认空态），手动入口常驻
  - 重新搜索双触发；connecting 态候选/手动入口禁用 + 提示；connectionError 展示且候选可再点
  - 手动配置页：URL 草稿默认值 + 「连接」主按钮先 health 再建档连接（固定 id）；切 managed 段字段分化 + 主按钮文案切换；返回回发现视图
  - streaming → 组件侧 closeWelcome（无 provider/默认模型引导回归断言）
- store：doInit 无 profile 置 welcomeOpen；saveProfiles 清空激活置位（回欢迎页）；激活存在时不置位（不变）

## 8. 已知取舍

- ~~provider 检查用 server cwd instance 的 auth 集~~（检查已移除，2026-09-06；provider 配置入口 = 主界面设置，打开项目后按作用域精确查询）
- 欢迎屏期间 managed 崩溃重启等事件照常（状态行不可见但 connect 串行化兜底；日志在设置内可见）
- **无服务器 = 强制欢迎页**（2026-09-05 修订）：主题/语言等个性化设置在连接前仅经欢迎页「打开设置」可达——接受（连接一次即一劳永逸，且设置弹窗在欢迎页之上功能完整）
- 连接态降级（有 profile，server 失联）不回欢迎页：SSE 重连恢复优先，欢迎页会打断自动重连（参考 openbuilder design-sse-reconnect-recovery 的教训：断线恢复不打断用户所在界面）
- 发现视图不展示 server 凭据输入；受 Basic auth 保护的 server 扫描不出来，走手动配置（与 guided-add-server §6 同源约束）
- attach 建档失败不残留（health 先行）；managed 建档先于连接、spawn 失败保留 profile——两模式不对称是原分支语义的保留，非疏漏：attach 的失败面是"地址/凭据写错"（用户可改后重试，残留无意义），managed 的失败面是"二进制不可用"（保留 profile 才能在设置里调整路径重试，且固定 id upsert 不堆积）
- 手动配置页草稿 id 在保存时重映射为固定 id（welcome-managed/welcome-attach）：放弃"多次手动配置不同参数堆多条 profile"的可能，换取重试不堆 profile（与候选建档同口径）

## 9. E2E 实测记录（2026-09-05，GNOME/Wayland + 本机 opencode 1.18.20，CDP 驱动；旧流程）

- 全链路通过：全新数据目录启动 → 欢迎屏出现 → managed 分支扫描（1 候选）→ 启动并连接 → streaming → 引导视图（本机全局 auth.json 已有 key → **默认模型引导**；全新环境为 provider 引导）→「去设置默认模型」直达设置对应页签 → 跳过 → 主界面 shell 渲染；全程零页面错误。**2026-09-06 修订后该链路变为：入口页「添加服务器」→ 发现视图点候选 → streaming → 直接 Shell（「打开项目」引导页）**
- 有 profile 启动不出现欢迎屏（多轮重启实测）
- **E2E 环境事实（重要，仍然有效）**：
  - opencode 的 auth.json 在 **XDG_DATA_HOME（全局）**而非 XDG_CONFIG_HOME——XDG_CONFIG_HOME 隔离不出"无 key"环境
  - **app.tsx emit 合帧的 rAF 在无人值守/被遮挡窗口会被饿死且不定时恢复**（连 `disable-features=CalculateNativeWinOcclusion` 都不保证）——scheduled 卡死 true 后一切 emit 短路、UI 永久停旧态（对真实用户：不可见窗口本就无需渲染，恢复可见即追平；欢迎屏的 streaming→closeWelcome effect 依赖重渲染，仍受影响）。**修复：flush 加 250ms setTimeout 安全网**（rAF 主路不变、flush 双清；不可见窗口最坏 ~1s 延迟，可见窗口无感）——这是对 3535091 emit 合帧的补丁而非推翻
  - 欢迎模式下设置弹窗需要宿主：App 欢迎分支渲染 `<SettingsDialog/>`（原本只挂在 Workspace 内）
