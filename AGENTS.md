# AGENTS.md

opencode 桌面端瘦客户端（Electron + React），姊妹项目为同目录下的 Flutter 移动端 `../openbuilder`（绝对路径 `/home/cyrasafia/projects/my-tools/openbuilder`；若本地克隆缺失，从 `https://github.com/cyrasafia/openbuilder.git` 克隆）。**v0.1 已实现**（三栏布局/聊天/项目/工作区/文件树/对账，见 `docs/design-v0.1-implementation.md`）；终端/diff/markdown 渲染等在 v0.2+。

## 开发命令

- `npm run dev` — electron-vite dev（Wayland 下建议加 `-- --disable-gpu` 规避 Vulkan 崩溃）
- `npm run build` / `npm run typecheck`（node+web 双 tsconfig）/ `npm run test`（vitest，20 用例）
- 联调：本机 opencode server `http://127.0.0.1:15120`（不要停止/重启）；CDP 驱动 E2E 用 `--remote-debugging-port=9222`
- preload 必须 CJS 输出（`.cjs`）——sandbox:true 不支持 ESM preload（electron.vite.config.ts 有注释）
- 打包：`npm run package:linux`（electron-builder）；发行包用 `scripts/package-arch.sh`（makepkg）/ `scripts/package-fedora.sh`（fedora:41 容器内 rpmbuild）

## 必读文档（写任何代码/文档前）

- `docs/design-architecture.md` — 技术栈与 4 条关键决策（D1–D4）及依据。**决策不可被隐式推翻**：Electron 而非 Tauri（GNOME/Wayland 性能）；自建而非 fork opencode-desktop（其内嵌 server 不发 npm，fork 即冻结）；React 19 而非 Solid；无中间服务层，renderer 直连 opencode server
- `docs/spec-v0.1.md` — 当前版本功能范围、API 映射表、SSE+REST 对账策略、验收口径。改功能范围必须同步此文件
- `docs/design-layout.md` — 主界面三栏布局、Tab 注册制、project-scoped 语义。布局/交互改动以此为准
- `docs/design-v0.1-implementation.md` — v0.1 实现方案 + **联调实测的 API 契约事实**（prompt_async、file/content 包装、worktree API、浏览器连接池上限等，改通信层前必读）+ 三轮 code review 记录
- `DESIGN.md`（根目录，视觉设计）— 配色/i18n 沿用移动端 openbuilder 的 `../openbuilder/DESIGN.md`；排版密度按桌面习惯重设计。token 唯一权威落点 `src/renderer/src/styles/tokens.css`

## 设计前置约定

- **设计任何功能前，先查 `../openbuilder` 是否做过同类功能**——尤其是 `../openbuilder/docs/design-*.md`（按关键词 grep 文件名与内容）。移动端已踩过的坑（SSE 重连恢复、滚动性能、消息累积、乐观消息等）都记录在里面，桌面端不得重新发明或重蹈覆辙
- 找到同类设计时：先读其"问题/坑"部分再动手；借鉴方案但按桌面交互习惯调整，并在本仓库 design 文档中注明参考来源（如"参考 openbuilder design-sse-reconnect-recovery"）

## 硬约束（agent 最容易踩的）

- **不用 `@opencode-ai/sdk`**——npm 发布滞后于 server，是过期契约。通信层自写（REST + SSE 直连），API 契约以 `../openbuilder/opencode_openapi.json` 为准（与移动端同源）
- 文档命名遵循移动端项目体系：`docs/design-*.md`（功能/技术设计）、`docs/plan-*.md`（计划）、`docs/review-*.md`（复盘）、`docs/spec-*.md`（版本范围）；根目录 `DESIGN.md` 专属视觉设计，**不得**用作其他用途
- 中文文档、中文 commit message，前缀惯例 `feat:` / `fix:` / `ui:` / `build:` / `chore:` / `docs:`（见 git log）
- 合并其他分支到 main 默认用 squash merge（单提交、保留原提交信息作为正文）
- 架构文档是"决策记录"性质：修订需在文档内改写决策及依据，而不是只改代码留文档过期

## 已锁定的语义（实现时不可走样）

- 项目打开/关闭是**纯客户端状态**（按 profile 持久化），server 无此概念；关闭项目 = 不展示 + 事件忽略，重开走 REST 快照
- chat Tab 与归档对称：关闭 Tab = 归档（`PATCH time.archived`），打开 Tab = 取消归档，无"仅关闭不归档"路径
- 工作区（worktree）从属项目，左栏二级展示；会话/文件树按 `?workspace=` 过滤；创建/删除用 `POST/DELETE /experimental/worktree`（**不用** `/experimental/workspace`，其 create 契约不稳定）；name 省略时 server 生成随机 slug；列表数据源是 `Project.sandboxes`（见 rest-client.ts / app-store.ts 注释）
- 工作区与文件树 project-scoped：切换项目/工作区 = 打开作用域会话 Tab（不关不归档已有 Tab，Tab 跨项目混排）+ 文件树重置；关闭项目仅关该项目 Tab（不归档）
- Tab 注册制：kind + 稳定标识（chat=sessionID、file=路径、terminal=ptyID、browser=URL），重复打开复用
- **global 项目按 directory 拆分**（2026-08-24 起，见 design-v0.1-implementation §7.13）：`id==="global"` 项目不在左栏整体展示，而是每个会话目录一行顶级 entry（键 `global\0<directory>`，打开/关闭/作用域独立）；发现 = `GET /session?scope=project&directory=/` 全量快照（连接时 + 选择器打开时刷新）；**不用裸 `GET /session` 做 global 发现**（那是 server cwd 所在 instance 的会话，随启动目录漂移）；SSE 为单全局流（/global/event），未打开 entry 的目录事件被事件闸门丢弃（openedDirectories 的 global 分支 = 已打开目录）

## 参考代码（只读，不引入依赖）

- `../opencode` — 官方 monorepo。session-ui 的 markdown 流式渲染管道（worker + morphdom + markdown-cache）是 L2 优化时的移植对象；desktop 的 sidecar/server 管理可参考
- `../openchamber` — 同类 Electron 项目。React 19 + CodeMirror 6 + @pierre/diffs 的实证选型来源；它的 express+ws 中间层是**本项目明确不做**的（D4）

## 环境事实

- 主力环境 GNOME + Wayland：Electron 需 `ozone-platform-hint=auto` + `enable-wayland-ime` 启动参数（fcitx5）
- 工具链：node 26 / bun 1.3 / pnpm 12 均可用；包管理用 npm（有 package-lock.json，勿混用）
