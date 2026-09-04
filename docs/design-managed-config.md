# managed 模式配置流程完善设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #2。四个子项：profile 表单按模式分化、版本检测、崩溃自动重启、日志可观察。依赖功能 #3 的扫描（[design-auto-scan.md](./design-auto-scan.md)，已合并）。

## 1. profile 表单按模式分化

- **managed**：隐藏 baseUrl/username/password（随机端口 + 自动凭据不变）；新增**二进制路径**字段：
  - `ConnectionProfile.binaryPath?: string`（空/缺省 = 自动发现，spawn 落 `"opencode"` 走 PATH）
  - 解析优先级：`OPENCODE_BIN` 环境变量（保留兼容，最高）→ `profile.binaryPath` → PATH
  - 表单内提供「浏览」按钮（系统文件选择器，`dialog:openBinaryFile` 新 IPC）+ 扫描候选列表（进入 managed 表单自动跑一轮 `scanBinaries()`，显示路径+版本，点击填入；「重新扫描」按钮）
- **attach**：表单不变

## 2. 版本检测

- **spawn 前**：`managedStart` 先跑 `opencode --version`（3s 超时）——失败给明确错误（含二进制路径）；成功则版本随 `ManagedStartResult.version` 返回。表单/欢迎屏的展示用扫描候选的 version（不额外 spawn）
- **连接后下限校验**：connect 流程 health() 返回 version 与 `MIN_SERVER_VERSION = 1.0.66`（单全局 SSE `/global/event` 的最低要求，design-sse-global-event）比较——**低于仅提示不阻断**（attach 模式同样校验）：
  - `store.serverVersionWarning: { version: string } | null`（结构化存 store，文案在 UI 层 i18n）
  - 展示：设置弹窗连接页签顶部 form-note + 左栏状态行悬浮提示追加；不弹窗、不打断任何操作
  - 比较函数 `shared/semver.ts`（纯函数：数字三元组比较，无法解析视为通过——不误伤非常规版本串）

## 3. 崩溃自动重启

现状：exit 事件发了但 renderer 没接，managed server 崩了就死透（SSE 永久 degraded）。

### 3.1 主进程（`ManagedServerController`）

- **重构**：`src/main/managed-core.ts` 持有全部状态机（spawn/退避/事件），不 import electron；`managed-server.ts` 退化为单例接线（BrowserWindow 广播 emit）。控制器依赖注入（spawn/版本探测/健康等待/emit）供单测
- **触发**：child `exit` 且 **established**（健康检查通过过）且**非主动停止**（`intentionalStop`）→ 进重启环；从未成活的退出（spawn 失败/健康超时）不进环（调用方拿到 ok:false 错误，用户可见）
- **退避**：1→2→4→8→16→30s 封顶**无限重试**（与 SSE 订阅器/pty 重连同序列，design-terminal-tab §1.2a）；重启成功清零
- **每次重启**：重新解析二进制路径（env 优先级不变）→ `--version` 探测 → 随机新端口 + 新密码 spawn → 健康等待（20s）；失败 emit `restart-error` 后按下一档退避续试
- **事件**（`managed:event` 信封 `{event, data}`）：
  - `exit {code, signal}`（既有）
  - `restart {attempt, delayMs}`——退避排队时（renderer 显示"第 N 次重启，Xs 后"）
  - `restart-error {attempt, error}`
  - `restarted {baseUrl, username, password, version}`——重启成功（新端口/新凭据随行）
- **主动停止不重启**：`stopManagedServer()`（断开/切 profile）与 `killManagedSync()`（退出应用）置 `intentionalStop` + 取消在途退避定时器
- **显式 start 取代退避**：退避排队期间用户显式 `managedStart`（重连/切回 profile）→ 取消定时器立即尝试，attempt 归零；start 序列自身失败不自动进环（用户可见错误，非崩溃语义）
- **并发**：startInFlight 去重（StrictMode 双 init 等，沿用现状语义）；child 存活时 start 直接返回现行信息

### 3.2 renderer 重连

- `doInit` 订阅 `managed:event`（此前无人订阅）：`restarted` 且 `activeProfile?.mode === "managed"` → `void this.connect()`——**走既有全量对账**（teardown + 快照 + Tab/会话恢复，spec 指定路径；新 baseUrl/凭据由 managedStart 返回值接管）
- 重启期间可见性：SSE 死 → 既有 connecting/degraded 体系显示"重连中"；`managedNotice`（结构化：exit/restart/restart-error）随事件更新，展示于设置连接页签 + 状态行悬浮提示；`restarted` 后清空
- renderer 重载窗口的恢复不依赖事件：init → connect → managedStart 返回现行 child 信息（见 design-auto-scan §4 同理）

## 4. 日志可观察

- renderer 侧 ring buffer：`store.managedLogLines: string[]`（容量 300，stdout/stderr chunk 原样 push，超出丢头）——`managed:event` 的 `log` 事件驱动；app.tsx 订阅侧 rAF 合帧已消化高频 emit
- 展示：设置弹窗连接页签（activeProfile 为 managed 时）「服务器日志」区——mono 只读尾部 + 复制按钮（navigator.clipboard）；异常退出提示 = managedNotice（含 exit 事件的 code/signal）
- main 侧不缓存日志（renderer 重载丢日志接受——server 进程生命周期通常覆盖整个会话，重载罕见）

## 5. UI 落点汇总

| 位置 | 内容 |
|---|---|
| ProfileFormView（managed） | binaryPath 字段 + 浏览 + 扫描候选列表（自动扫描 + 重新扫描）+ 「随机端口+自动凭据」说明；隐藏 URL/凭据 |
| ConnectionSettings | 顶部：版本下限提示（serverVersionWarning）；managed 激活时：managedNotice + 服务器日志区（尾部 + 复制） |
| 左栏状态行悬浮 | 追加版本提示与 managedNotice 文案 |

## 6. 测试

- `managed-core.test.ts`：崩溃 → 退避序列（1/2/4…封顶 30）→ restarted 事件（新端口凭据）；主动 stop 不重启；start 序列失败（健康超时）不进环；显式 start 取代排队退避并清零 attempt；established 语义（健康前退出不进环）；startInFlight 去重
- `shared/semver.test.ts`：正常比较、补零（1.0 vs 1.0.66）、预发布后缀、无法解析
- `settings-dialog` 组件测试：managed 表单隐藏 URL/凭据、显示二进制路径与候选；attach 表单字段齐全

## 7. 已知取舍

- 同一时刻至多一个 managed 进程（单 child 状态，v0.1 起约束不变）；编辑激活 managed profile 的 binaryPath 不热切换——下次连接生效（连接中的进程仍用旧二进制）
- 重启环无上限重试（spec 语义：崩溃拉起是 managed 模式的承诺；二进制被删除等永久失败会停在 30s 档循环，错误经设置可见）
- 日志不落盘（重启应用后无历史）

## 8. 联调实测记录（2026-09-04，GNOME/Wayland + opencode 1.18.20）

- **v0.1 遗留 bug（本版修复）**：spawn 注入 `OPENCODE_SERVER_PASSWORD` 后，`/global/health` 在 server 的 RootHttpApi 上受 Authorization 中间件保护——裸 fetch 健康检查恒 401 → managed 模式自 v0.1 起"启动超时"假象（此前从未带 auth E2E）。修复：健康等待带 Basic 凭据（managed-core `basicAuthHeader`）
- **env 泄漏（实测）**：electron-vite dev 把 `--remote-debugging-port` 写进 main 进程 env，spawn 出的 opencode serve 读取 `REMOTE_DEBUGGING_PORT` 自起 CDP 抢占同端口（后续应用实例 bind 失败）。修复：`sanitizedServerEnv` 剥 `REMOTE_DEBUGGING_PORT` + `NODE_/ELECTRON_/VITE_` 前缀
- **E2E（CDP 驱动 dev app，store 状态判据）**：设置→添加 managed（表单分化+扫描候选）→启用→streaming → `kill -9` server → 退避 1s 自动重启（新端口）→ renderer 收 restarted → 全量重连 streaming 恢复，日志 ring 累积 ✓
- **真二进制集成测试**（`managed-core.integration.test.ts`，`OB_MANAGED_INTEGRATION=1` 启用）：真实 spawn+auth 健康+kill -9+退避重启+restarted 新端口/新密码+stop 无残留
- **CDP E2E 观察点（非本功能缺陷）**：无人值守/被遮挡窗口中 Chromium 节流 rAF 至停——app.tsx 的 emit 合帧（rAF）驱动渲染停摆、DOM 停在旧态（store 状态正常）。对真实用户：不可见窗口本就无需渲染，取消遮挡后补帧恢复；E2E 用 `window.__store` 状态判据 + `OB_E2E=1` env（main/index.ts 注入禁节流开关）规避
- **Fast Refresh 违例（已修）**：组件文件混出非组件导出（`managedNoticeText` 原在 settings-dialog.tsx）会破坏 React Fast Refresh——vite 全链 hmr invalidate + 页面 reload，与交互竞态时表现为"树死亡"假象。已独立为 `managed-notice.ts`；新增组件文件不得混出非组件导出
- **connect 并发重入竞态（已修）**：activate 的 connect 在途时 "restarted" 事件再入 connect → 双 teardown/双恢复对已清空容器解引用。串行化（`connectInFlight`/`connectQueued`）；连接成功清 managedNotice（显式 start 取代排队重启不发 restarted，notice 残留）
