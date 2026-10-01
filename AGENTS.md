# AGENTS.md

opencode 桌面端瘦客户端（Electron + React），姊妹项目为同目录下的 Flutter 移动端 `../openbuilder`（绝对路径 `/home/cyrasafia/projects/my-tools/openbuilder`；若本地克隆缺失，从 `https://github.com/cyrasafia/openbuilder.git` 克隆）。**v0.1 已实现**（三栏布局/聊天/项目/工作区/文件树/对账，见 `docs/design-v0.1-implementation.md`）；终端/diff/markdown 渲染等在 v0.2+。

## 开发命令

- `npm run dev` — electron-vite dev；Wayland 下如遇 Vulkan/GPU 崩溃用 `./scripts/dev.sh --disable-gpu`（或 `OB_DISABLE_GPU=1 npm run dev`）。**不要**写 `npm run dev -- --disable-gpu`：electron-vite 5 的 CLI（cac）不透传 Chromium 开关、直接 `CACError: Unknown option '--disableGpu'`；开关经 env 门控在 `main/index.ts` `app.commandLine.appendSwitch("disable-gpu")`（2026-09-08 修，原记载的透传写法从未生效）
- `npm run build` / `npm run typecheck`（node+web 双 tsconfig）/ `npm run test`（vitest，约千余用例——以实跑为准）
- 联调：本机 opencode server `http://127.0.0.1:15120`（v2.0.18，Basic auth——密码见 systemd unit；不要停止/重启）；v1 回归（如需）另起 1.18.x 二进制于其他端口；CDP 驱动 E2E 用 `--remote-debugging-port=9222`
- preload 必须 CJS 输出（`.cjs`）——sandbox:true 不支持 ESM preload（electron.vite.config.ts 有注释）
- 打包：`npm run package:linux`（electron-builder）；发行包用 `scripts/package-arch.sh`（makepkg）/ `scripts/package-fedora.sh`（fedora:41 容器内 rpmbuild）

## 必读文档（写任何代码/文档前）

- `PRINCIPLES.md`（根目录，设计原则）— 基本原则 Keep Lean（保持精简）+ 三条推论（服务用户/不做大而全/理念先行）+ 目标用户与工作流推导（产品定位、功能取向、三栏布局）+ 界面理念 Everything is a tab。**功能取舍与版本规划的判据源**，spec/design 文档与其冲突时先修订本文
- `docs/design-architecture.md` — 技术栈与 4 条关键决策（D1–D4）及依据。**决策不可被隐式推翻**：Electron 而非 Tauri（GNOME/Wayland 性能）；自建而非 fork opencode-desktop（其内嵌 server 不发 npm，fork 即冻结）；React 19 而非 Solid；无中间服务层，renderer 直连 opencode server
- `docs/spec-v0.5.md` — 当前版本（v2 契约）功能范围、API 映射表、SSE+REST 对账策略、验收口径。改功能范围必须同步此文件（v0.1–v0.4 的 spec 见 git 历史）
- `docs/design-layout.md` — 主界面三栏布局、Tab 注册制、project-scoped 语义。布局/交互改动以此为准
- `docs/design-v0.1-implementation.md` — v0.1 实现方案 + **联调实测的 API 契约事实**（prompt_async、file/content 包装、worktree API、浏览器连接池上限等，改通信层前必读）+ 三轮 code review 记录
- `DESIGN.md`（根目录，视觉设计）— 配色/i18n 沿用移动端 openbuilder 的 `../openbuilder/DESIGN.md`；排版密度按桌面习惯重设计。token 唯一权威落点 `src/renderer/src/styles/tokens.css`

## 设计前置约定

- **设计任何功能前，先查 `../openbuilder` 是否做过同类功能**——尤其是 `../openbuilder/docs/design-*.md`（按关键词 grep 文件名与内容）。移动端已踩过的坑（SSE 重连恢复、滚动性能、消息累积、乐观消息等）都记录在里面，桌面端不得重新发明或重蹈覆辙
- 找到同类设计时：先读其"问题/坑"部分再动手；借鉴方案但按桌面交互习惯调整，并在本仓库 design 文档中注明参考来源（如"参考 openbuilder design-sse-reconnect-recovery"）

## 硬约束（agent 最容易踩的）

- **不用 `@opencode-ai/sdk`**——npm 发布滞后于 server，是过期契约。通信层自写（REST + SSE 直连），API 契约以 `../openbuilder/opencode_openapi_v2.json` 为准（v2，2.0.18 pin，与移动端同源；源 `anomalyco/opencode` `packages/protocol/openapi.json`）。**v0.5 起仅支持 v2 server**——v1（1.18.x）契约面已删除，连接 v1 server 报「版本不支持」（2026-09-28 裁定，见 docs/design-v2-migration.md）
- 文档命名遵循移动端项目体系：`docs/design-*.md`（功能/技术设计）、`docs/plan-*.md`（计划）、`docs/review-*.md`（复盘）、`docs/spec-*.md`（版本范围）；根目录 `DESIGN.md` 专属视觉设计、`PRINCIPLES.md` 专属设计原则，**不得**用作其他用途
- 中文文档、中文 commit message，前缀惯例 `feat:` / `fix:` / `ui:` / `build:` / `chore:` / `docs:`（见 git log）；**commit 标题只用一句话讲最核心的信息**（范本 9d85f0e / c15cdff，实测 ≤76 字；至多带一处 `——`/`（）` 紧凑定位短语），根因、方案细节、review 修订、测试计数、文档同步一律放正文——按主题分段、约 60 字换行，不得把细节整段挤进标题单行（2026-09-23 增补）
- 合并其他分支到 main 默认用普通合并（`git merge --no-ff`，保留分支提交历史，生成 merge commit；2026-08-31 修订，原 squash merge 单提交方案弃用）
- 架构文档是"决策记录"性质：修订需在文档内改写决策及依据，而不是只改代码留文档过期

## 版本号管理

- 升级版本号时**必须同时修改所有版本落点**：`package.json`（+ `package-lock.json` 随 `npm version` 同步）、`packaging/arch/PKGBUILD`（`pkgver`）、`packaging/fedora/openbuilder-desktop.spec`（`Version:`）
- 打包脚本 `scripts/package-arch.sh` 从 `package.json` 读取 `pkgver` 并自动递增 `pkgrel`（build number），无需手动改 `pkgrel`
- 升级**第一段或第二段**版本号时（如 `0.3.0` → `0.4.0` 或 `1.0.0`），**必须打 GitHub tag**（`git tag vX.Y`）并推送（`git push origin vX.Y`）；第三段补丁号（`0.3.0` → `0.3.1`）不打 tag
- commit message 用 `chore: 升级版本号至 X.Y.Z，对齐 vX.Y 标签`（打 tag 时）或 `chore: 升级版本号至 X.Y.Z`

## 已锁定的语义（实现时不可走样）

- 项目打开/关闭是**纯客户端状态**（按 profile 持久化），server 无此概念；关闭项目 = 不展示 + 事件忽略，重开走 REST 快照
- chat Tab 与归档对称：关闭 Tab = 归档，打开 Tab = 取消归档，无"仅关闭不归档"路径。存储字段 = **`metadata.archivedAt` 私约**（`PATCH /api/session/:id`，D1——v2 无 REST 归档字段，官方 API 回归后迁回；metadata 是 REPLACE 语义须整包合并，识别层双源兼容存量 `time.archived`）
- 工作区（worktree）从属项目，左栏二级展示；会话/文件树按 directory 作用域（v2 无 workspace 参数，worktree 即完整目录）；创建/删除用 `POST/DELETE /api/worktree`（payload projectID 必填、delete force 必填，**create 响应是裸 `{directory}` 无 `{data}` envelope**——2026-09-29 活体修正，原按 envelope 解析致创建必报错）；**列表数据源 = `GET /api/worktree?projectID=` 库存（WorktreeTable，2026-09-29 裁定）**——`Project.sandboxes` 是 v2 GA 起的冻结 legacy 列（create/remove 不再维护：已删目录残留幽灵、新建缺失；旧 server 存量原样保留），库存 union 进内部 sandboxes 供闸门/作用域/快照复用，渲染以库存为准；对账 = 打开项目 `POST /api/worktree/refresh`（外部 git worktree 增删、死行清理——rm -rf 的库存残留只有此端点能清）+ list diff（连接/打开/60s/重连/SSE worktree.updated 触发）；**删除 worktree = 级联删该目录全部会话**（`DELETE /api/session/:id` 连子会话，非归档——D2 裁定）；**分支挂载（2026-09-29 起，design-worktree-branch-sync）**：v2 create 恒 detached 不建分支（上游 PR #26931，提交不可见且删除即失）——本端 create 成功后经 `POST /api/shell`（runShell 封装：单命令 + exit code 判定，跨登录 shell 可移植）挂 `opencode/{worktree-name}`，撞名 show-ref 判定后 `-<rand>` 后缀重试 ≤2，任何失败降级 detached 不阻塞；删除时 v2 不清分支（活体 E），DELETE 后在项目 canonical 直接 `branch -D`（无论是否已并入，2026-09-30 修订——原「未并入保留 + branchNotice」条件方案废弃，理由见 design-worktree-branch-sync 修订）；移动端 openbuilder 同构（对齐中）
- 工作区与文件树 project-scoped：切换项目/工作区 = 打开作用域会话 Tab（不关不归档已有 Tab，Tab 跨项目混排）+ 文件树重置；关闭项目仅关该项目 Tab（不归档）
- Tab 注册制：kind + 稳定标识（chat=sessionID、file=路径、terminal=ptyID、browser=URL——新开空白 Tab 例外：唯一 `browser:new:N` 键不去重，2026-09-15），"打开指定地址"类入口（文件树 .html/关闭栈按 URL 重开）重复打开复用
- **global 语义已退役**（2026-09-28 M1b 裁定，改写原 2026-08-24「global 按 directory 拆分」决策，依据 v2 GA 实测）：v2 server 取消 global 项目（非 git 目录 = 目录哈希伪项目行，出现在 `GET /api/project`），桌面端 v1 的 `global\0<directory>` entry 模型整体删除——非 git 目录以普通项目行进左栏，打开/关闭/作用域/事件闸门统一走项目路径；持久化旧键由 `migrateLegacyGlobalState`（project-entries.ts）在连接期按 worktree 匹配转项目 ID；新目录发现由项目列表刷新承接（连接/选择器打开时 syncWorktrees/60s diff/M3 起的 project.updated 事件）。原「不用裸 `GET /session` 做 global 发现」约束随机制消亡；SSE 事件闸门 = 已打开项目的 worktree ∪ sandboxes
- **终端主动/被动退出分流**（2026-09-22 起，见 design-terminal-tab §1.2/§1.4）：WS close **1000**（pty 自然退出，如 live 终端内 Ctrl+D/exit）= **自动关 Tab**（同一般终端模拟器；先标 exited 再 closeTerminalTab 跳过 DELETE）；**4404 / token 404** = 被动关闭，呈已退出只读态不自动关。断开/错误态 Ctrl+D = 关 Tab（closeTabInteractive 与 Ctrl+W/Tab 栏 X 单一路径，exited/disconnected 免确认）；live 态 Ctrl+D = EOF 归 pty 不拦截；Ctrl+W 各态行为维持 2026-09-10 决策（live 归 pty）
- **回放幽灵应答闸门**（2026-09-23 起，见 design-terminal-tab §1.2b）：重挂载/重连的回放窗口内（meta 帧前 + 写队列未排空）丢弃 xterm 对回放流中**历史查询**的自动应答（模式：DA/CPR/DSR/DECXCPR/DECRPM/DCS 状态报告/OSC 颜色报告，`isTerminalQueryResponse`）——回放不是用户键入，注入 pty 会被读屏态 pager 逐键回显成乱码并逐次累积；**live 期应答必须放行**（fish prompt 握手依赖即时应答），不可做成全局过滤；**首连豁免（2026-09-30 修复）**：新建 pty 首连的回放是 fish 启动**活查询**（server 在 WS 建立前已 spawn shell，fish 阻塞等应答中）——闸门风险前提（历史查询打到 pager）不存在，拦截致 fish DA1 应答 10s 超时打 PDA 警告；故闸门仅在该 pty 曾 attach 过（`ptyRuntimes[id].attached`，onopen `markPtyAttached` 置位）时武装，重挂载/重连照常拦截
- **输入框失焦保存/恢复**（2026-09-30 起，见 design-input-selection-restore）：IME 切换（fcitx5/Wayland text-input 重建）会让聚焦输入框瞬时 blur→focus；按住 Ctrl 的切换回归可晚于任意固定窗口——时间窗/修饰键门控判定均否决。语义：失焦一律保存 value+选区，回焦 value 未变恢复续编辑，无保存/值已变走默认（textarea 末尾、地址栏与重命名全选）；**地址栏失焦不回显**（Escape/导航同步为回显路径）、**重命名失焦不提交**（Enter/Escape/换目标收敛），均经用户确认接受

## 参考代码（只读，不引入依赖）

- `../opencode` — 官方 monorepo。session-ui 的 markdown 流式渲染管道（worker + morphdom + markdown-cache）是 L2 优化时的移植对象；desktop 的 sidecar/server 管理可参考
- `../openchamber` — 同类 Electron 项目。React 19 + CodeMirror 6 + @pierre/diffs 的实证选型来源；它的 express+ws 中间层是**本项目明确不做**的（D4）

## 环境事实

- 主力环境 GNOME + Wayland：Electron 需 `ozone-platform-hint=auto` + `enable-wayland-ime` 启动参数（fcitx5）
- 工具链：node 26 / bun 1.3 / pnpm 12 均可用；包管理用 npm（有 package-lock.json，勿混用）
