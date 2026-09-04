# 终端 Tab（xterm.js + server pty）— 设计文档

> 对应 spec-v0.3 #5。内嵌终端：`@xterm/xterm` + opencode server pty API。**恒深色渲染**（不随主题）；新建终端 cwd = 当前作用域目录，Tab 归作用域；**关 Tab = 杀掉 pty**（运行中二次确认）。
>
> 契约来源（AGENTS.md 约定先行检索）：移动端无终端；pty 协议从 opencode 源码 + openapi 核实——REST `POST /pty`（cwd/command/args/env）、`GET /pty/shells`、`PUT /pty/{id}`（size）、`DELETE /pty/{id}`、`POST /pty/{id}/connect-token`（**须带 `x-opencode-ticket: 1` 头**，源码 pty-ticket.ts）；WS `GET /pty/{id}/connect?ticket=&cursor=`（auth 中间件对带 ticket 的 connect 路径跳过 Basic Auth，源码 isPtyConnectPath）；**PtyProtocol**（源码 protocol.ts）：出帧 = 原始终端 UTF-8 文本，**控制帧 = `0x00` 字节 + JSON `{cursor}`**（replay 后携带绝对输出游标）；入帧 = 文本/二进制直写 pty；server 以 cursor 做 replay（attach 重连回放历史输出）。legacy `/pty` 路由只暴露 running 会话（exited 即 404，源码 handlers/pty.ts 注释）。

## 1. 模型

### 1.1 Tab

- `TabKind` 扩 `"terminal"`；key = `terminal:<ptyID>`；directory = 创建时作用域目录（cwd）
- 创建入口：引导页「终端」按钮（解禁）→ `store.openTerminalTab()`：`POST /pty`（cwd = 作用域目录；**command 省略**——server 走 `Shell.preferred($SHELL)`，与 server 进程默认登录 shell 一致，如 fish）→ Tab 入列 + 激活。**不取 `/pty/shells` 首个 acceptable**：那是 `/etc/shells` 顺序首个（实测 /bin/sh），反而覆盖 server 正确的 $SHELL；`/pty/shells` 留待将来做 shell 选择器（源码 `pty.ts: command = input.command || Shell.preferred(...)`，`Shell.preferred` 取 `process.env.SHELL`）
- 标题 = `Pty.title`（server 给，如进程名）；无则 "terminal"
- **关 Tab = DELETE /pty/{id}**；**仅 live 连接态二次确认**（2026-09-02 修订，文案同关流式 chat Tab 风格）——已退出（exited）与断连退避中（disconnected，§1.2a）连接已不可用，确认"将终止进程"无意义直接关（closeTerminalTab 仍尝试 DELETE 防孤儿，404 容忍）；pty exited 后关 Tab 仅清理本地（DELETE 404 静默）
- restoreClosedTab 的 terminal 分支（spec #2）：在原 directory **新建**终端（原 pty 已销毁）
- teardown/关项目/删工作区：pty 由 server 持有，客户端只关 Tab 不删 pty？**否**——孤儿 pty 会常驻 server；关项目/删工作区/断开连接时对运行中 pty 逐个 DELETE（fire-and-forget），与"关 Tab = 杀"语义一致

### 1.2 连接（TerminalView 组件）

- 挂载：`POST /pty/{id}/connect-token`（头 `x-opencode-ticket: 1`，**必须 POST**——GET 无此路由会落 server web UI 的 SPA fallback 返回 HTML，实测）→ `new WebSocket(wsBase + /pty/{id}/connect?ticket=…&directory=<作用域目录>)`；wsBase = baseUrl http(s) → ws(s) 换 scheme。**connect 必须带 directory**（pty 路由按 directory 实例路由，缺参落到 server cwd 实例 → 404，实测）
- **cursor 语义分两用**（§1.2a，2026-09-02 修订）：首连/重挂载**不带 cursor**——组件卸载即销毁 xterm buffer，重挂载是全新 Terminal，server 语义 cursor=N 只回放 N 之后增量（传记忆 cursor 重挂载恒空白，评审 H1），cursor 省略 = 全量回放（server 保留 2MB buffer）；**同组件内断线重连携带 cursor**——增量续传只补缺失输出
- 出帧处理：文本帧直写 `term.write` 并累计 cursor（server `session.cursor += chunk.length` 同口径）；二进制帧 = 0x00 控制帧（{cursor}）解析为续传锚点不写屏
- **Origin 剥离（打包形态实测）**：server 对 connect 路径校验 Origin allowlist，浏览器 WS 必发 Origin——打包（file://）→ 403；main 进程 `session.webRequest.onBeforeSendHeaders` 对 ws/wss **删 Origin 头**（server 视同无 Origin 放行，实测 101；dev 的 localhost 本就在 allowlist，删除无副作用）。renderer fetch 无此问题（file:// fetch 不发 Origin，实测 200）
- 入帧：`term.onData` → `ws.send`（文本）
- 断开/卸载：close WS；重挂载凭全量回放恢复。WS close 终态判定：**code 1000** = pty 自然退出（server onEnd 主动关）、**code 4404** = session 不在 server（legacy 路由 not-found/exited 同码）→ 都 store 标 exited（关闭 Tab 不再 DELETE，legacy 路由已 404；评审 M2）；**其余 code** = 异常断开 → 进入 §1.2a 自动重连（不标 exited，关闭 Tab 仍 DELETE 防孤儿）。已退出 pty 重挂载不建 WS

### 1.2a 断线自动重连（2026-09-02 新增，修订原 §3"不做 WS 断线自动重试"）

> 原决策"断线显示已断开态、重开即新终端"弃用。依据：① server pty 与 WS 连接解耦，断线不杀进程，attach 契约原生支持 cursor 续传（pty.ts attach：cursor=N 只回放 N 之后，0x00 控制帧回新锚点）——增量续传零重复写屏；② 退避/kick 语义直接复用 SSE 订阅器已验证的方案（来源 openbuilder design-sse-reconnect-recovery），不新发明轮子。

- **触发**：WS close code ∉ {1000, 4404}；或 connect-token 获取瞬态失败（网络错误/未连接——`ptyConnectUrl` 返回 null）
- **退避**：1→2→4→8→16→30s 封顶无限重试（与 SSE 订阅器同序列），重连成功清零。终态不重试：token 404（pty 已被回收/server 重启内存态丢失，`ptyConnectUrl` 返回 {gone:true}）→ 标 exited；不写入错误行——cursor 续传只补 server 侧输出，本地写屏内容会永久留在 scrollback
- **续传**：0x00 控制帧 {cursor} 为锚点，其后 live 帧按字符串长度累计（与 server 同口径，UTF-16 code units）；重连 URL 带 `cursor=` 只补缺失输出到同一 xterm 实例。**无锚点断开**（meta 帧到达前断开）：`term.reset()` 清屏 + 不带 cursor 全量回放——防已写屏内容与重放重复
- **focus kick**：窗口 focus 时若在退避睡眠中，立即重试并重置退避（openbuilder resume 语义——断网恢复/系统挂起后不等满 30s 稳态）；建连尝试在途时不打扰
- 呈现：重连中叠加「连接已断开，重连中…」通栏 banner（中性灰，进行中非终态——区别已退出琥珀/已断开红）；重连成功即消失。「已断开」红色叠加降级为兜底态（仅 runtime 缺失等退化场景可达）
- **断连标记**：进入退避（异常断开/token 瞬态失败）`markPtyDisconnected(id, true)`、重连成功 onopen 置 false——唯一消费方 closeTabInteractive：断连态关 Tab 免二次确认（§1.1）；无 UI 派生不 emit
- 卸载：清重连定时器（teardown 关项目等路径先杀 pty 再关 Tab，无僵尸重连循环）
- SSE（app 级）重连不连带重建 pty WS——两者独立退避，各自恢复
- exited 呈现：WS close（code 1000 = pty 自然退出）→ 终端区叠加「已退出」态（终态提示行，通栏 banner 警示色——已退出琥珀、已断开红），只读；Tab 保持（可读回滚）直至用户关闭
- **已退出 Tab 回滚保留（buffer 缓存）**：组件卸载即销毁 xterm buffer，但已退出 pty 的 server attach 抛 ExitedError 无法回放——卸载前用 `@xterm/addon-serialize` 导出 ANSI 序列缓存到 `ptyRuntimes[id].buffer`；重挂载时若有缓存则 `term.write(buffer)` 还原（不建 WS），兑现「Tab 保持可读回滚」。运行中 pty 不缓存（重挂载靠 server 全量回放）。**bufferReady 守卫**：xterm `write` 是异步队列，重挂载后立即切走时回调未触发、serialize 返回空——故 `cachePtyBuffer` 空串不覆盖（保留首次好缓存），且 cleanup 在 `bufferReady=true`（write 回调触发 / WS close）后才 serialize
- **resize**：ResizeObserver → `fitAddon.proposeDimensions()` → `term.resize` + `PUT /pty/{id}` `{size:{rows,cols}}`（节流 200ms）；连接未建立时只 resize 本地；**已退出 pty 跳过上报**（server 404，防 ResizeObserver 在 exited 后仍触发报错）
- **自动聚焦**：`term.open(host)` 后立即 `term.focus()`——Tab 切换走 key 隔离重挂载，打开/切回 terminal 即获焦，无需点击；`.terminal-view` `onMouseDown` 兜底（点击终端任意区域重新聚焦）
- 复用浏览器 shim：终端纯 renderer + server WS，无 IPC 依赖——shim 下同样可用（jsdom 测试不建真 WS）

### 1.3 恒深色

- xterm theme 固定深色板（对齐终端惯例：背景 #1e1e2e 系、前景浅灰）；容器 `.terminal-view` 固定深底——**不接 data-theme**，浅色主题下终端仍深色（spec 明确）

### 1.4 复制/粘贴

- **快捷键**（2026-09-03 修订：按平台区分修饰键）：`Ctrl+Shift+C` 复制选区到剪贴板、`Ctrl+Shift+V` 粘贴剪贴板到 pty（linux/win32/浏览器开发态——裸 `Ctrl+C` 是 SIGINT 不可占用，故需 Shift 区分）；**macOS 依系统习惯用 `⌘C`/`⌘V`**（`window.desktop.platform === "darwin"`，修饰键判定 `metaKey && !ctrlKey`；mac 下不再拦截 Ctrl+Shift+C/V，Control 系组合归终端/PTY）。经 `term.attachCustomKeyEventHandler` 拦截：命中组合键时 `ev.preventDefault()` + `return false`（吞掉 xterm 默认处理），其余键 `return true` 放行。复制键**无选区时不拦截**——保留终端对该组合键的默认处理（用户自定义 shell 键绑定等）。
- **右键菜单**：`.terminal-view` `onContextMenu` 阻止 xterm 默认（其内置无菜单），弹出复制/粘贴菜单。复用 `FileContextMenu` 模式（首帧隐藏测量钳制到视口 + capture 阶段 mousedown/Escape/wheel/blur 四触发关闭 + `pushOverlay` z-order 计数 + 键盘 ↑↓ 导航）。
  - 复制项按选区有无启用/禁用（`term.hasSelection()`，菜单打开瞬间快照）
  - 粘贴读 `navigator.clipboard.readText()` → `term.paste(text)`（xterm paste 走其 bracketed-paste 模式，安全）
- 已退出态终端仍可复制（只读 buffer 仍可选区）；粘贴到已退出 pty 无害（WS 已断，`ws.send` 不执行——onData 仍挂但 readyState 非 OPEN）

## 2. store 侧

```ts
ptyRuntimes = new Map<string, { exited: boolean; disconnected: boolean; title: string; buffer?: string }>()  // 纯内存（cursor 锚点在组件内，见 §1.2a）
```

- `openTerminalTab()`（async）：create（不带 command） → Tab + runtime + emit；失败 connectionError。**入口同步捕获 directory/projectId**（await 期间切作用域：Tab 照开归原目录但不抢激活——防 projectId/directory 错配孤儿与跨作用域激活错位，评审 M1）
- `ptyRuntimeFor(id)` 读；`markPtyExited` 写（emit——驱动"已退出"叠加态）；`markPtyDisconnected` 写断连标记（不 emit，§1.2a——closeTabInteractive 关闭确认判定消费）
- `ptyConnectUrl(id, cursor?)` 三态返回：`{url}`（cursor 携带 = 续传连接）、`{gone:true}`（token 404，调用方标终态）、`null`（瞬态失败，可退避重试）
- `closeTerminalTab(key)`：确认（UI 侧）→ `DELETE /pty/{id}`（404 静默）→ closeTab（terminal 分支：runtime 清理 + WS 由组件卸载自断）+ 入关闭栈
- teardown/closeProject/removeWorkspace：遍历该作用域 running terminal Tab → DELETE（fire-and-forget）。**teardown 全杀必须在 client 置 null 之前**（置 null 后杀是死代码，评审 H2）

## 3. 不做的事

- 终端分屏/多路复用、字体设置、主题定制（恒深色）
- pty 持久会话恢复（**server 重启后** pty 内存态全丢，token 404 → 已退出终态，重开即新终端——重连只覆盖 server 侧会话仍存的场景）；terminal Tab 不参与 Tab 记忆，与 file Tab 同取舍
- ~~WS 断线自动重试（server 重启等场景显示已断开态，重开即新终端）~~ → **2026-09-02 修订为 §1.2a 自动重连**（cursor 续传 + SSE 同款退避）；弃用依据见 §1.2a 引注
- scrollback 配置（xterm 默认 1000 行）

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/api-types.ts` | `Pty` / `PtyShell` / `PtyTicket` 类型 |
| `src/shared/rest-client.ts` | `listShells/createPty/updatePtySize/deletePty/ptyConnectToken`（后两者错误静默约定；connect-token 带 `x-opencode-ticket: 1` 头） |
| `src/renderer/src/store/app-store.ts` | TabKind 扩 terminal；openTerminalTab/ptyRuntimes/closeTerminalTab/restoreClosedTab terminal 分支/ptyConnectUrl（cursor 参数 + 三态返回）/cycleTab 无需改（directory 过滤通用）/卸载路径 DELETE |
| `src/renderer/src/components/terminal-view.tsx` | xterm 终端组件（WS 生命周期/fit/深色/自动聚焦/已退出 buffer 缓存 serialize 还原/复制粘贴快捷键+右键菜单/§1.2a 断线自动重连：cursor 锚点追踪 + 退避 + focus kick） |
| `src/renderer/src/components/workspace.tsx` | Tab 内容分发 terminal 分支；引导页终端入口解禁；关闭走 closeTabInteractive（terminal 确认文案） |
| `src/renderer/src/components/tab-actions.ts` | terminal 关闭确认 + closeTerminalTab |
| `src/renderer/src/styles/app.css` | `.terminal-view`（深色固定 + 已退出/已断开/重连中叠加态） |
| `src/renderer/src/i18n/index.ts` | confirmCloseTerminal / terminalExited / terminalDisconnected / terminalReconnecting / terminalCopy / terminalPaste 等 |
| 测试 | store（创建/关闭/恢复/卸载 DELETE/teardown 杀序/ptyConnectUrl 三态）；rest-client pty 端点 URL/头/方法断言；TerminalView 用注入 WS 假类测生命周期（open/write/控制帧锚点/close code 三分：1000·4404 终态、其余重连/退避重连带 cursor/无锚点 reset/gone 终态/focus kick/卸载清定时器） |

## 5. 验收（对齐 spec #5）

- 新建终端落在当前作用域目录；输入/输出/中文正常；resize 同步 pty
- 切走再切回：经全量回放恢复内容；重启应用 terminal Tab 不恢复（不做记忆）
- **断线自动重连（§1.2a）**：断开 server 网络（pty 进程仍活）→ 重连中 banner，网络恢复后（或窗口 focus kick）自动续传恢复输出，无重复内容；杀掉 server（token 404）→ 已退出终态不再重试；pty 内 `exit` → 已退出终态
- 关 Tab 后 `GET /pty` 无该会话；运行中关闭有确认
- 浅色主题下终端恒深色；`npm run test` / `typecheck` / `build` 全绿
- **打包形态（file://）实测记录（2026-08-27，server 1.18.20）**：CDP 驱动 out/ 构建真窗口——创建 pty / connect-token(POST) / WS（Origin 剥离后 101）/ xterm 渲染 / 无断开叠加，全链路通过
