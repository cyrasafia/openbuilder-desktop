# 终端 Tab（xterm.js + server pty）— 设计文档

> 对应 spec-v0.3 #5。内嵌终端：`@xterm/xterm` + opencode server pty API。**恒深色渲染**（不随主题）；新建终端 cwd = 当前作用域目录，Tab 归作用域；**关 Tab = 杀掉 pty**（运行中二次确认）。
>
> 契约来源（AGENTS.md 约定先行检索）：移动端无终端；pty 协议从 opencode 源码 + openapi 核实——REST `POST /pty`（cwd/command/args/env）、`GET /pty/shells`、`PUT /pty/{id}`（size）、`DELETE /pty/{id}`、`POST /pty/{id}/connect-token`（**须带 `x-opencode-ticket: 1` 头**，源码 pty-ticket.ts）；WS `GET /pty/{id}/connect?ticket=&cursor=`（auth 中间件对带 ticket 的 connect 路径跳过 Basic Auth，源码 isPtyConnectPath）；**PtyProtocol**（源码 protocol.ts）：出帧 = 原始终端 UTF-8 文本，**控制帧 = `0x00` 字节 + JSON `{cursor}`**（replay 后携带绝对输出游标）；入帧 = 文本/二进制直写 pty；server 以 cursor 做 replay（attach 重连回放历史输出）。legacy `/pty` 路由只暴露 running 会话（exited 即 404，源码 handlers/pty.ts 注释）。

## 1. 模型

### 1.1 Tab

- `TabKind` 扩 `"terminal"`；key = `terminal:<ptyID>`；directory = 创建时作用域目录（cwd）
- 创建入口：引导页「终端」按钮（解禁）→ `store.openTerminalTab()`：`POST /pty`（cwd = 作用域目录；shell 取 `GET /pty/shells` 首个 `acceptable`，失败省略 command 让 server 用默认）→ Tab 入列 + 激活
- 标题 = `Pty.title`（server 给，如进程名）；无则 "terminal"
- **关 Tab = DELETE /pty/{id}**（运行中 status==="running" 时二次确认，文案同关流式 chat Tab 风格）；pty exited 后关 Tab 仅清理本地（DELETE 404 静默）
- restoreClosedTab 的 terminal 分支（spec #2）：在原 directory **新建**终端（原 pty 已销毁）
- teardown/关项目/删工作区：pty 由 server 持有，客户端只关 Tab 不删 pty？**否**——孤儿 pty 会常驻 server；关项目/删工作区/断开连接时对运行中 pty 逐个 DELETE（fire-and-forget），与"关 Tab = 杀"语义一致

### 1.2 连接（TerminalView 组件）

- 挂载：`POST /pty/{id}/connect-token`（头 `x-opencode-ticket: 1`，**必须 POST**——GET 无此路由会落 server web UI 的 SPA fallback 返回 HTML，实测）→ `new WebSocket(wsBase + /pty/{id}/connect?ticket=…&directory=<作用域目录>)`；wsBase = baseUrl http(s) → ws(s) 换 scheme。**connect 必须带 directory**（pty 路由按 directory 实例路由，缺参落到 server cwd 实例 → 404，实测）
- **不带 cursor**：组件卸载即销毁 xterm buffer，重挂载是全新 Terminal——server 语义 cursor=N 只回放 N 之后增量（传记忆 cursor 重挂载恒空白，评审 H1）；cursor 省略 = 全量回放（server 保留 2MB buffer），cursor 记忆已移除
- 出帧处理：文本帧直写 `term.write`；二进制帧 = 0x00 控制帧（{cursor}）跳过不写屏
- **Origin 剥离（打包形态实测）**：server 对 connect 路径校验 Origin allowlist，浏览器 WS 必发 Origin——打包（file://）→ 403；main 进程 `session.webRequest.onBeforeSendHeaders` 对 ws/wss **删 Origin 头**（server 视同无 Origin 放行，实测 101；dev 的 localhost 本就在 allowlist，删除无副作用）。renderer fetch 无此问题（file:// fetch 不发 Origin，实测 200）
- 入帧：`term.onData` → `ws.send`（文本）
- 断开/卸载：close WS；重挂载凭全量回放恢复。WS close **code 1000** = 自然退出 → store 标 exited（关闭 Tab 不再 DELETE，legacy 路由已 404）；**其余 code** = 异常断开 → 仅"已断开"叠加态、不标 exited（关闭 Tab 仍 DELETE 防孤儿，评审 M2）。已退出 pty 重挂载不建 WS
- exited 呈现：WS close（code 1000 = pty 自然退出）→ 终端区叠加「已退出」态（终态提示行），只读；Tab 保持（可读回滚）直至用户关闭
- **resize**：ResizeObserver → `fitAddon.proposeDimensions()` → `term.resize` + `PUT /pty/{id}` `{size:{rows,cols}}`（节流 200ms）；连接未建立时只 resize 本地
- 复用浏览器 shim：终端纯 renderer + server WS，无 IPC 依赖——shim 下同样可用（jsdom 测试不建真 WS）

### 1.3 恒深色

- xterm theme 固定深色板（对齐终端惯例：背景 #1e1e2e 系、前景浅灰）；容器 `.terminal-view` 固定深底——**不接 data-theme**，浅色主题下终端仍深色（spec 明确）

## 2. store 侧

```ts
ptyRuntimes = new Map<string, { exited: boolean; title: string }>()  // 纯内存（cursor 记忆已移除，见 §1.2）
```

- `openTerminalTab()`（async）：shells → create → Tab + runtime + emit；失败 connectionError。**入口同步捕获 directory/projectId**（await 期间切作用域：Tab 照开归原目录但不抢激活——防 projectId/directory 错配孤儿与跨作用域激活错位，评审 M1）
- `ptyRuntimeFor(id)` 读；`markPtyExited` 写（emit——驱动"已退出"叠加态）
- `closeTerminalTab(key)`：确认（UI 侧）→ `DELETE /pty/{id}`（404 静默）→ closeTab（terminal 分支：runtime 清理 + WS 由组件卸载自断）+ 入关闭栈
- teardown/closeProject/removeWorkspace：遍历该作用域 running terminal Tab → DELETE（fire-and-forget）。**teardown 全杀必须在 client 置 null 之前**（置 null 后杀是死代码，评审 H2）

## 3. 不做的事

- 终端分屏/多路复用、字体设置、主题定制（恒深色）
- pty 持久会话恢复（重启后 server 侧 pty 仍在但不自动重连——terminal Tab 不参与 Tab 记忆，与 file Tab 同取舍）
- WS 断线自动重试（server 重启等场景显示已断开态，重开即新终端）
- scrollback 配置（xterm 默认 1000 行）

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/api-types.ts` | `Pty` / `PtyShell` / `PtyTicket` 类型 |
| `src/shared/rest-client.ts` | `listShells/createPty/updatePtySize/deletePty/ptyConnectToken`（后两者错误静默约定；connect-token 带 `x-opencode-ticket: 1` 头） |
| `src/renderer/src/store/app-store.ts` | TabKind 扩 terminal；openTerminalTab/ptyRuntimes/closeTerminalTab/restoreClosedTab terminal 分支/cycleTab 无需改（directory 过滤通用）/卸载路径 DELETE |
| `src/renderer/src/components/terminal-view.tsx` | 新：xterm 终端组件（WS 生命周期/fit/深色） |
| `src/renderer/src/components/workspace.tsx` | Tab 内容分发 terminal 分支；引导页终端入口解禁；关闭走 closeTabInteractive（terminal 确认文案） |
| `src/renderer/src/components/tab-actions.ts` | terminal 关闭确认 + closeTerminalTab |
| `src/renderer/src/styles/app.css` | `.terminal-view`（深色固定 + 已退出叠加态） |
| `src/renderer/src/i18n/index.ts` | confirmCloseTerminal / terminalExited 等 |
| 测试 | store（创建/关闭/恢复/卸载 DELETE/teardown 杀序）；rest-client pty 端点 URL/头/方法断言；TerminalView 用注入 WS 假类测生命周期（open/write/控制帧跳过/close code 区分/exited） |

## 5. 验收（对齐 spec #5）

- 新建终端落在当前作用域目录；输入/输出/中文正常；resize 同步 pty
- 切走再切回：经全量回放恢复内容；重启应用 terminal Tab 不恢复（不做记忆）
- 关 Tab 后 `GET /pty` 无该会话；运行中关闭有确认
- 浅色主题下终端恒深色；`npm run test` / `typecheck` / `build` 全绿
- **打包形态（file://）实测记录（2026-08-27，server 1.18.20）**：CDP 驱动 out/ 构建真窗口——创建 pty / connect-token(POST) / WS（Origin 剥离后 101）/ xterm 渲染 / 无断开叠加，全链路通过
