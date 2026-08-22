# openbuilder-desktop 设计文档

opencode 桌面端瘦客户端。本文档记录定位、架构与关键技术决策及其依据。

---

## 1. 定位

- **是什么**：opencode server 的图形化桌面瘦客户端。壳只负责 UI 与本地资源桥接（进程、PTY、文件），业务逻辑全部在 opencode server 侧。
- **目标用户**：开发者本人（单人自用）。不做多用户、鉴权、relay 等"产品化"能力。
- **目标环境**：Linux / GNOME + Wayland 为主力环境，**性能（输入延迟、流式渲染流畅度）是第一优先级**；macOS / Windows 保持可构建可运行即可。
- **兄弟项目**：`openbuilder`（Flutter 移动端）同为 opencode 瘦客户端。两端不共享 UI 代码，各自面向 opencode server API，互不为对方妥协设计。
- **命名**：项目名不含 "opencode"，规避上游对衍生项目命名的声明要求。

## 2. 关键决策记录

### D1: 壳技术 = Electron（而非 Tauri）

- 主力环境 GNOME + Wayland 下，Tauri 依赖的 WebKitGTK 存在输入延迟、IME（fcitx/ibus）兼容、流式高频重排卡顿等已知问题；本项目是输入密集 + 流式渲染密集型应用，正好命中其短板。
- Electron 自带 Chromium（Ozone 后端），Wayland 支持成熟，渲染与输入表现可预期。
- 实证：opencode 官方 desktop 与 openchamber 两个同类项目均选 Electron。
- Wayland 启动参数：

  ```ts
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  app.commandLine.appendSwitch('enable-wayland-ime') // fcitx5 关键
  ```

- 自用场景下 Electron 的体积/内存劣势不构成问题。

### D2: 自建，而非 fork opencode-desktop（含"fork 后独立"变体）

- 官方 desktop 的 server 以 `virtual:opencode-server` 内嵌，指向 monorepo 内 `packages/opencode/dist/node`（`private: true`，**不发布 npm**），且 client 侧是锁版本 vendored tgz——client 与 server 严格 lockstep。
- 因此 fork 一次后独立 = 内嵌 server 永久冻结在 fork 点；opencode server 迭代极快，数月后"大脑"过时，届时被迫回归上游搬运，更新压力并未消失，只是从"定期 merge"恶化为"过时后大手术"，且发生在一个不完全理解的大代码库里。
- 自建的**唯一外部契约是 npm 版本化的 `@opencode-ai/sdk`**（与移动端使用的 openapi.json 同源）。上游内部重构（effect 化、sdk-next 等）不影响本项目；升级节奏完全自控（锁版本 + 按需升级）。
- 代价：放弃官方 desktop 现成 UI。接受，因为需求面（见 §4）可控，且核心难点（流式 markdown）已有明确的抄作业对象与演进路径。

### D3: 前端框架 = React 19（而非 Solid）

- 曾倾向 Solid 的唯一强理由是复用官方 `session-ui`，但验证发现其依赖 `@opencode-ai/ui/core/client` 一整串 workspace 包，不 fork 摘不出来，理由不成立。
- session-ui 的核心资产（worker 渲染管道、morphdom 增量 DOM、remend 流式补全、@shikijs/stream）均不绑定框架，React 下同样可以移植——**选 React 不堵死"抄方案"，选 Solid 却真的放弃"用成熟库"**。
- React 侧现成件：streamdown（LLM 流式 markdown）、react-arborist（文件树）、TanStack Virtual（虚拟化）、react-resizable-panels 等。
- 流式渲染的结构性问题用模式解决：单条消息独立 store + 组件 memo，避免全列表重 diff。

### D4: 无中间服务层（renderer 直连 opencode server）

- openchamber 的 express+ws 中间层目的有二：REST+SSE→WS 封装、承载鉴权/relay 等自有功能。本项目两者皆不需要。
- Renderer 通过 `@opencode-ai/sdk` 直接以 HTTP/SSE 连接 opencode server（本地子进程或远程实例），架构上更薄。
- Electron main 只做 Node 能力桥接（进程/PTY/文件），不代理业务流量。

## 3. 架构

```
┌─ Electron Main (Node, TS) ──────────────────────┐
│  ServerManager                                   │
│   ├─ managed 模式（默认）:                        │
│   │   发现 PATH 里的 opencode →                   │
│   │   spawn `opencode serve`（随机空闲端口+auth）  │
│   │   健康检查 / 崩溃拉起 / 退出时清理子进程       │
│   └─ attach 模式: 连接现有 server URL             │
│       （远程 / devcontainer，同移动端思路）        │
│  PtyManager: @lydell/node-pty 会话生命周期        │
│  FsBridge: 文件树 / 读取 / watch (@parcel/watcher)│
│  WindowManager / tray / 原生菜单                  │
└──────────────┬───────────────────────────────────┘
               │ IPC（进程管理事件、PTY 数据流、fs）
┌──────────────┴───────────────────────────────────┐
│  Renderer (React 19 + TS)                        │
│   @opencode-ai/sdk ──HTTP/SSE──► opencode server │
│   ├─ 会话/聊天（streamdown + shiki）              │
│   ├─ 终端（xterm.js）                             │
│   ├─ Diff（@pierre/diffs）                       │
│   └─ 文件树（react-arborist + 原生拖放）          │
└──────────────────────────────────────────────────┘
```

要点：

- **server 的两种来源**：
  - managed：优先复用用户 PATH 里的 `opencode` 二进制（不捆绑 sidecar，避开升级与体积问题）；检测不到时提示安装或引导下载。监听随机空闲端口，避免与用户自有实例冲突；basic auth 凭据由 main 生成并注入 renderer 连接参数。
  - attach：输入 URL + 凭据即可挂接远程实例，连接配置（connection profile）持久化，字段设计与移动端对齐以便未来互导。
- **UI 层完全不感知进程存在**：renderer 只面向 server API，两种模式零成本切换。
- 构建链：electron-vite + TypeScript；打包 electron-builder。

## 4. 功能模块与选型

| 模块 | 方案 | 备注 |
|---|---|---|
| 聊天/流式 markdown | streamdown（起步） | 内置不完整语法处理与块级 memo；演进路径见 §5 |
| 语法高亮 | shiki + @shikijs/stream | VS Code 同引擎；流式高亮官方支持 |
| 终端嵌入 | xterm.js + @lydell/node-pty | 官方 desktop 同款 pty fork，经生产验证 |
| Diff 视图 | @pierre/diffs | opencode desktop 与 openchamber 共同选择 |
| 文件树 + 拖放 | react-arborist + Electron 原生拖放 | 原生拖放可拿到完整文件路径 |
| 文件监听 | @parcel/watcher | 官方 desktop 同款，原生性能 |
| 长列表 | TanStack Virtual | 会话列表/消息列表虚拟化 |

### 未来扩展（本期不做，但架构预留）

- **内嵌浏览器 tab**：Electron `WebContentsView`，每 tab 独立渲染进程，核心能力只有 Electron 优雅提供——这是当初壳选型的加分项之一。
- **代码编辑**：**CodeMirror 6**（非 Monaco）。依据：openchamber 全线 CM6 的实证（更轻、按需语言包、跨端潜力）；届时 diff 视图可评估迁移到 CM6 merge view 统一技术面。

## 5. 流式 markdown 渲染演进策略

LLM 逐 token 追加是本项目最大的渲染性能风险。分三级演进，每级可验证、可回退：

1. **L0：streamdown 直接用**。大概率够用（自用、单会话为主）。
2. **L1：块级 memo + 虚拟化**。markdown 按块切分独立渲染，历史消息进 TanStack Virtual；正在流式的块单独更新。
3. **L2：移植 session-ui 方案**。渲染挪入 Web Worker（解析/高亮不在主线程），morphdom 做增量 DOM 提交，配合 markdown-cache 缓存已完成块。该方案的管道（protocol/queue/transport）为纯 TS，不依赖 Solid，可整体移植。

判据：主线程长任务导致输入/滚动掉帧（GNOME+Wayland 下主观可感）即升级一级。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `@opencode-ai/sdk` breaking change | 锁定版本；升级作为独立任务，跑通冒烟后再进 |
| `opencode serve` CLI 启动参数变化（managed 模式） | 启动参数集中在 ServerManager 单点；启动失败给出可读诊断（含版本、命令行） |
| streamdown 性能不达标 | §5 演进路径，终态方案已被官方验证 |
| Electron 主进程退出留下孤儿 opencode/pty 进程 | `detached: false` + `will-quit` 统一清理；参考 openchamber 的优雅停机脚本（killer script）思路 |
| SDK 版本落后导致新会话特性不可用 | 接受；attach 模式下用户可随时用新版 server，UI 兼容旧 API 契约 |

## 7. 里程碑

- **M1 骨架与连接**：electron-vite 工程搭建；ServerManager（managed + attach）；SDK 连通；基础聊天 UI（streamdown）；Wayland/IME 验证。
- **M2 工作台**：终端（xterm.js + pty）；文件树 + 拖放到聊天输入；diff 视图接入会话事件。
- **M3 打磨**：流式渲染性能调优（按 §5 判据逐级）；主题；快捷键；Linux 打包（AppImage/deb）。

---

*决策依据的调研细节（opencode-desktop / openchamber 源码结论）见本文档 git 历史与讨论记录；本文档随架构演进更新。*
