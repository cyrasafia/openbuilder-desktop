# v0.1 功能范围

对应里程碑 M1。本文档确认范围与验收口径；技术底座见 [design-architecture.md](design-architecture.md)。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 服务器配置 | 连接配置（profile）管理：attach 模式（URL + 凭据）为主；managed 模式（发现并 spawn 本机 opencode serve） |
| 2 | 基础聊天 | 会话内发消息、流式接收回复（文本部分，assistant 文本与 reasoning 以 markdown 渲染，选型 streamdown 见 design-architecture §5；无语法高亮）；工具调用折叠为占位符，不展开渲染；会话进行中在消息流末尾显示输入中提示（固定预留槽位，显隐不引起消息位移，见 [design-typing-indicator.md](design-typing-indicator.md)） |
| 2b | 待处理卡片（授权/问题） | agent 请求人工介入时在会话底部弹卡片应答（一次一张、队列计数），左栏/Tab/会话列表指示器同步 waiting 态（见 [design-pending-cards.md](design-pending-cards.md)） |
| 3 | 项目管理 | 项目全集 = opencode 数据库所有项目（`GET /project`）；**打开/关闭为客户端本地状态**（按 profile 持久化），打开 ∪ 关闭 = 全集。打开 = 左栏展示 + 实时更新（事件应用）；关闭 = 不展示 + 事件忽略不更新，重开走 REST 快照 |
| 3b | 工作区（worktree） | 工作区从属于项目，左栏项目下二级展示；会话列表、文件树均按 工作区 维度过滤（`?workspace=` 参数）。列表数据源 `Project.sandboxes`（`GET /project` 附带）；**创建 `POST /experimental/worktree`（名称可空=server 随机 slug；成功后默认切换到新 worktree）/ 删除 `DELETE /experimental/worktree` 均为 server 原生操作，v0.1 完整实现**（experimental API，契约不稳定需容忍；**不用** `/experimental/workspace` 的 create，其契约不稳定） |
| 4 | 新建/归档会话 | 新建会话（中栏引导页输入首条消息即创建并发送）；归档 = `PATCH /session/{id}` 写 `time.archived`（关闭 chat Tab 即归档）；已归档会话在中栏引导页列出，点击恢复（取消归档并开 Tab）；重命名/删除 UI 本版无入口 |
| 5 | 文件树 | 懒加载目录树（`GET /file`）；点击打开文件 |
| 6 | 文件浏览（纯文本） | `GET /file/content`，纯文本展示（无 markdown 渲染、无语法高亮） |
| 7 | SSE + REST 对账 | 事件流订阅 + 断线重连后的全量/增量对账（见下） |

## 范围外（明确不做）

- 终端（xterm）、diff 视图、markdown 文件渲染、语法高亮、文件拖放
- 工具调用过程渲染（授权/问题卡片已实现，见 2b；工具输入输出的结构化渲染仍不做）
- 自动更新、主题系统、快捷键体系
- managed 模式的自动安装/升级 opencode 二进制

## UI 结构约定

- **主界面承载全部主要功能**：左侧栏（项目 + 工作区）｜ 中部 Tab 工作区（默认视图 = 新 Tab 引导页）｜ 右侧文件树/文件浏览面板（可折叠）
- **设置以弹窗形式**：连接配置（profile 列表、新建/编辑/删除、激活切换）、外观与行为开关

## 通信层设计（自写，不用 SDK）

- 依据契约：`openbuilder/opencode_openapi.json`（与移动端同源）；类型从 OpenAPI 生成或手写最小子集，锁定在 client 层单点
- 基础设施：fetch 封装（baseUrl、basic auth、`x-opencode-directory` 头）+ SSE 订阅器（`GET /event`）

### API 映射

| 功能 | API |
|------|-----|
| 健康检查/连通性 | `GET /global/health` |
| 项目列表 | `GET /project` |
| 会话列表 | `GET /session`（归档过滤在客户端按 `time.archived`） |
| 新建会话 | `POST /session` |
| 归档/取消归档 | `PATCH /session/{id}`（`time.archived` = 时间戳 / 0） |
| 会话消息 | `GET /session/{id}/message` |
| 发消息 | `POST /session/{id}/prompt_async`（异步流式） |
| 斜杠命令查询 | `GET /command?directory=`（v1 instance 路由，含 builtin/config/MCP/skill 全量注册表） |
| 斜杠命令发送 | `POST /session/{id}/command`（服务端展开模板，回显见 [design-slash-command.md](design-slash-command.md)） |
| 事件 | `GET /event`（SSE：`session.*`、`message.*`、`permission.*`、`question.*`） |
| 待处理授权 | `GET /permission`；应答 `POST /session/{id}/permissions/{pid}`（body `{response}`，均带 `?directory=`） |
| 待处理问题 | `GET /question`；回答 `POST /question/{qid}/reply`（body `{answers}`）；拒绝 `POST /question/{qid}/reject`（全局端点 + `?directory=` 路由，见 design-pending-cards） |
| 文件树 | `GET /file?path=…` |
| 文件内容 | `GET /file/content?path=…` |

### 对账策略（参考移动端已验证方案：design-on-demand-sse / design-sse-reconnect-recovery）

1. **冷启动**：REST 全量快照（项目、会话、激活会话消息）→ 订阅 SSE → 增量应用事件
2. **断线**：SSE 订阅器指数退避重连；UI 进入 degraded 态（可发不可收的边界要明确提示）
3. **重连成功**：触发对账——重拉受影响资源（会话列表 + 激活会话消息全量 + 各目录 pending 授权/问题），以 REST 结果为准覆盖本地状态，再恢复事件流应用
4. **乐观发送**：发消息本地立即上屏（pending 态），收到对应 `message.updated`/`message.part.updated` 后按服务端状态收敛
5. 状态机：`snapshot → streaming ⇄ degraded → (reconnect) → snapshot'`，转换全部显式、可观察（日志）

## 验收口径

- [ ] 配置一个远程/本地 opencode server 并完成冷启动全量对账
- [ ] 在两个项目间切换，各自会话列表正确
- [ ] 引导页输入消息 → 新会话创建并流式收到回复 → 关闭 Tab（归档）后会话出现在引导页"已归档"区，点击恢复为 Tab
- [ ] 会话进行中消息流末尾出现输入中提示，结束时消失；全程已显示消息位置无跳动（预留槽位）
- [ ] 文件树浏览任意仓库，打开文本文件内容正确
- [ ] 手动断网/SSE 中断 ≥30s 后恢复，消息状态与服务器一致（无重复/丢失）
- [ ] agent 触发授权/问题时卡片出现、应答后消失且 server pending 清空；离线期间产生的卡片经对账回填可见；三处指示器（左栏/Tab/会话列表）waiting 态同步
- [ ] GNOME + Wayland 下中文输入、滚动流畅无卡顿
