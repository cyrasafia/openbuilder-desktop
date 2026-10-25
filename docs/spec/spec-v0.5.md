# v0.5 功能范围

主题：**v2 server 契约切换**——通信层（REST/SSE/对账）整体迁移到 opencode v2（GA，基线 2.0.18），v1（1.18.x）契约面删除。v0.5 起**仅支持 v2 server**（2026-09-28 裁定，双兼容不做：连接 v1 server 给出「版本不支持」明确报错，不做协议分派）。功能面承接 v0.1–v0.4 全量能力（除下列 server 侧概念消失的降级项）；迁移决策与契约映射全集见 [design-v2-migration.md](../design/v2/design-v2-migration.md)，实施记录见 [plan-v2-protocol.md](../plan/plan-v2-protocol.md)。

版本定位（2026-10-09 口径补记）：

- **v0.5 目标 = 全量切 v2 接口，不做新功能**。例外二项：用户后台任务卡（功能 #10）——它是功能补丁而非新功能：v2 的 `/review` 等命令从子会话改为在主会话执行，后台任务卡弥补由此产生的异步子会话不可见缺口；未读标识（功能 #11）——v2 契约新能力（`time.viewed` 水位 + `/view` 端点）使能，v1 面无法实现，属迁移顺带落地的功能。
- **v0.5.1 目标 = 全部功能稳定，可 daily drive**（补丁版收口，不扩范围；0.6 功能范围另行确定，恢复项归属见降级表注记）。
- **v0.5.2 主题 = 新增未读标记功能**（功能 #11：服务端 `time.viewed` 水位判定 + `POST /api/session/:id/view` 标记已读，左栏/chat Tab 蓝点、点开即清；配套聚合 chip 重设计同版落地——状态圆点领头 + 中性数字，未读纳入 chip）。
- **v0.5.3 主题 = 修复删除 worktree 后残留伪项目问题**（2026-10-13 定位真触发器后的成套防御：删除窗口在途 location 请求挂起等清零 + 删除成功后 evict warm location，design-worktree-sync §3.4/§3.5、ref-pseudo-project-cleanup §3.4/§7e；期间另有 pty 预杀置退出态、`time.active` 选择器排序等稳定性修复随版）。
- **v0.5.4 主题 = 新增专注模式**（design-focus-mode：会话页/引导页专注输入态——tab 内嵌面板、切走再回保持专注态、输入框变形撑满页面、guide 整屏延展，三连迭代收敛形态；随版含 v2 subagent 面板未就绪修复、tool 状态合并单调化等稳定性改进）。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 通信层 v2 全量换绑 | REST 走 `/api/*` 面（session/project/worktree/fs/vcs/pty/command/permission/form/model/agent），SSE 走 `GET /api/event` 单流（`V2Event` 信封 + `session.*` 命名空间）；Basic auth（用户名固定 `opencode`）；**volatile 契约**下对账升级为重连必全量（会话 + 消息 + worktree + pending）；`rest-client-v2.ts` 更名 `rest-client.ts` 为唯一 client（v1 面删除，M6d） |
| 2 | 归档（D1；**2026-10-25 迁回官方 API**，design-archive-official-api） | 关 Tab = 归档 / 开 Tab = 取消归档；≥2.1.3 走官方 `PATCH /api/session/:id` body `archived`（置/清 `time.archived`；取消归档组合清存量 marker——openbuilder 决策 9 跨端约束），<2.1.3 回退 D1 私约 `metadata.archivedAt`（REPLACE 整包合并）；识别层双源（`time.archived` + `metadata.archivedAt`）过渡保留；存量 marker-only 经快照 backfill 转正 + 清标记一步到位（版本闸门 + in-flight 防重入）；SSE 增 `session.archived/unarchived`（durable 旁路，未知 + 取消归档方向回源 GET）；读路径维持全量拉取（归档展示段依赖，不消费 `?archived=` 过滤） |
| 3 | worktree 域（D2/D5，2026-09-29 修订；**删除确认 2026-10-12 再修订**） | 创建/删除走 `/api/worktree`（delete force 必填；**删除恒 `force=true`**，脏态提示由确认弹窗的 `GET /api/vcs/status` 非阻塞预检承担（官方 GUI 模式）——server 的 400 forceRequired 判别依赖英文 git stderr，中文 locale 恒 false 不依赖；**create 响应是裸 `{directory}`，无 `{data}` envelope**）；**删除 = 级联删该目录全部会话**（非归档）；**列表数据源 = `GET /api/worktree?projectID=` 库存（WorktreeTable，v2 权威源）**——`Project.sandboxes` 是冻结 legacy 列（v2 GA 起 create/remove 不再维护：已删目录残留、新建缺失，2026-09-29 活体核实），对账 = 打开项目 `POST /api/worktree/refresh` + list diff（外部 git worktree 增删/死行清理）；`instance/dispose` 退役（不映射 reload，服务层自管理）；**分支挂载（2026-09-29，design-worktree-branch-sync）**：create 后经 `POST /api/shell` 挂 `opencode/{name}`（v2 恒 detached 兜底，失败降级不阻塞），删除后 canonical 下直接 `branch -D` 清分支（无论是否已并入）；**删除后 location evict（2026-10-12，design-worktree-sync §3.4）**：DELETE 成功后 best-effort `DELETE /api/debug/location?location[directory]=`（debug 组端点，pin 含；单点封装 `evictLocation`，升级随 pin 核对）逐出该目录 warm location——断 server 5 分钟周期刷新重解析死目录再生的伪项目行（燃料 6） |
| 4 | 消息域（typed union） | v2 消息 11 型 union 经 `toInternalMessages` 收敛为内部形状（渲染管线不变）；分页 cursor 双向（上滚翻页走 `cursor.next`）；prompt 200 回执驱动乐观清除（`SessionInbox.User` 准入确认 + post-200 首页重取）；**乐观 ID 锚（2026-10-11，design-optimistic-id-anchor）**：乐观 localId = client-minted `msg_` id 随 prompt 请求体 `id` 传递（server 准入幂等），事件/快照按 id 精确消解——enqueued/delivered/cancelled 旁路精确清（不依赖 conv 加载）、快照漏斗结算（锚入页即清，封死一次性事件窗口全错过后的永久悬挂）；**命令乐观受理信号消解（2026-10-12，§4b）**：subagent 命令（`/review` 类）user 消息整体落子会话、父会话零写入（v2.0.18 源码 + 活体双证），`opt_` 无锚乐观经 `session.created` 子会话出生 / POST 204 清（只清 opt_ 形状，msg_ 锚条目不动）；**流式事件翻译层**（`session.text/tool/reasoning/step.*` → v1 part 管线）；**inbox 落地链路**（M6c）：user 消息经 `session.inbox.enqueued\|delivered` 实时落地（他端/命令），enqueued 非过滤项（compaction 等）不消费命令回显标记；**准入即物化（2026-10-10，design-inbox-admission）**：enqueued（user）以 inboxID 铸真实消息（乐观清空，busy 排队窗口不悬挂「发送中」；refs/attachments 桥接 chip——锚优先匹配）+ 未投影豁免快照窗口删除 + `inbox.cancelled` 移除未投影项与锚命中乐观 |
| 5 | 待办人机交互（form 体系） | 授权卡换 `POST /api/session/:id/permission/:requestID/reply`（decision）；问题卡整体切 v2 form（`form.created/replied/cancelled` 事件 + `replyForm`/`cancelForm`）：字段六型归一化（select/multiselect/boolean 合成是/否/text/number 输入步），hidden/external 剔除，required 门控（Q-7：当前步未答不得前进）；回填 = `GET /api/permission/request` + `GET /api/form`（冷启动/开项目/SSE 重连） |
| 6 | 文件/diff/终端域 | fs 组（list/read/find，deepObject location）：read 是原始字节流，text/binary 客户端判定（NUL 嗅探为主——server MIME 库对 `.ts` 误判 `video/mp2t`，活体发现）；diff 双模式（vcs mode 映射 git→working；session diff turn 语义 + context=3 根治 v1 全文件 patch 陷阱）；pty 四方法 + WS connect（ticket 头 + 0x00+`{cursor:N}` 锚点帧 + close 1000/4404 分流——**契约逐项活体核对**，V2D-2 关闭，terminal-view 零改动兼容） |
| 7 | agent/model 目录与切换 | 数据源 `GET /api/agent` + `GET /api/model`（LR-1「/api/model 只返回一家」判断已过时，2.0.18 实测 65 模型跨 5 provider）；**wire id/name 错位映射**（id=标识符落 name 切换键、wire name 落 label 显示）；切换 `POST /api/session/:id/{agent,model}`（variant 条件包含） |
| 8 | 斜杠命令 | `GET /api/command` ∪ `GET /api/skill` 合并（skill 斜杠触发保留，source 标记）；`POST /api/session/:id/command`（body `{name,text,files}`，**timeoutMs: 0** 不设超时——同步端点 SC-4 教训；subagent 命令 `subtask:true` 快速返回——建子会话投 prompt 后 fork 后台）；命令回显经 inbox.enqueued 转记（回滚不回填展开文本草稿；**subagent 命令父会话无 inbox 事件**——2026-10-12 活体订正，转记自然不发生，乐观消解走受理信号见第 4 节） |
| 9 | global 语义退役（D6/M1b） | v2 无 global 项目行（非 git 目录 = 目录哈希伪项目行以普通项目进左栏）；v1 `global\0<dir>` entry 模型删除，持久化旧键连接期迁移（`migrateLegacyGlobalState`）；新目录发现 = 项目列表刷新（连接/选择器/60s diff/project.updated） |
| 10 | 用户后台任务卡（design-subagent-background，2026-10-08 升格按异步统一；2026-10-20 增后台 shell——design-shell-background） | 异步子会话三路径统一：命令型 `subagent: true`、工具型 `subagent` tool `background:true`、工具型前台转后台（`POST /api/session/{id}/background`）——常驻任务卡（分隔线上方 `.bg-task-slot` 槽位通栏折叠卡，与授权/问题卡同域，默认收起，运行中后台任务非空时显示；前台 part 运行中不进；展开列任务，任务行整行点击查看（键盘可达），详情窗与任务卡同槽位互斥替代、展开态跨详情保留，单条 `interrupt` 停止）；启动提示客户端本地合成（前台认领不插，SSE 缺口误插由对账撤回）并随 REST 对账在覆盖窗口内重建（created 用会话行权威时间，幂等；续跑认领含 input.sessionID），前台转后台合成「已转后台」提示（part completed ∧ 子会话运行中，运行中可恢复），完成提示取 `session.inbox.enqueued`/REST 的 `synthetic`（`metadata.source=subagent`）并按 id 去重；`sessionActivity` 家族聚合点亮父会话 Tab/左栏指示器；工具型**前台** `task`/`subagent` tool part 保持 `SubagentPanel` 不变。**后台 shell 同卡混排**（agent `shell` tool `background:true`/前台转后台）：判据单点 = part completed ∧ `metadata.shellID` ∧ `metadata.status==="running"`（live 与 REST 同判据、无误插撤回路径）；入列/完成系统提示（`source:shell` synthetic 解析，超时终态独立呈现）+ 任务卡（list 对账 `GET /api/shell` 按 `metadata.sessionID` 归属，四挂点轮询）+ 输出详情窗（等宽纯文本、两段式尾部 1MB、运行期缓冲截断、404 空态按因二分）+ 停止（`DELETE /api/shell/:id`，按钮文案预告删档）；指示器经 `dotStateFor` 投影点亮（不动 `sessionActivity`） |
| 11 | 未读标识（design-unread-marker；v2 契约新能力使能） | 会话「已产出未验收」以**服务端水位**判定：`unread ⟺ Session.Info.time.idle != null && (time.viewed == null \|\| time.idle > time.viewed)`（两字段随会话列表/单会话返回）；标记已读 `POST /api/session/:id/view`（body `{idle}`——回传**观察到的** idle，服务端 `viewed = max(idle, viewed)` 单调，且不 touch `time_updated`）；他端 ack 经 `session.viewed` 事件（`viewed = max`）合并。**ack = 该会话成为当前激活 chat Tab**（不判滚动位置/窗口聚焦；点开即清、停留即保持），`view` 失败指数退避重试（250ms→5s），成功乐观置 `viewed`；run 终态补 `GET /api/session/:id` 取权威 idle（`Execution.*` 事件不带 idle 时间戳，且 `time_idle` 有 +1 严格前进守卫，不可本地合成）。呈现 = 左栏状态点（≤4 会话行）+ chat Tab 点，新增 `--status-unread`（蓝）；**>4 会话行经聚合 chip 重设计呈现未读**（2026-10-11 落地，design-indicator-aggregate-chip：chip = 状态圆点领头 + 中性数字，六态计数为 0 省略，序 running → error → failed → waiting → unread → idle，chip 数字之和 = 会话总数——原「同色字压同色淡染底」变体族整体删除）；**不做**本地通知清单/系统通知/声音/托盘角标/手动清除入口 |
| 12 | 会话消息文件路径自动链接（design-message-autolink，2026-10-11） | 消息正文（assistant/user/subtask/子会话）中项目内文件路径（含 `:行号` 后缀、行内代码单一路径）自动转链为 `ob-file:` 内部链接，点击开文件 Tab（Tab 注册制去重、带行号强制源码模式跳行）；识别规则移植 openbuilder design-message-autolink（六轮评审收敛形态），管线为 remark 插件（mdast 层，streamdown 块级 memo 内运行）；归属校验在解析期（插件闭包会话 directory，项目外/逃逸保持纯文本）；裸 URI 链接维持 remark-gfm autolink 既有行为，本功能不触及 |

## 范围外（明确不做）

- **v1/v2 双协议**（裁定不做）：探测仅用于错误指引（连接/测试连接遇 v1 server 报「需要 opencode v2」）
- **v2 新能力**（persistent-pty、inbox 管理、skill 体系深度集成、websearch、session stats/log/import-export、配对 UI `POST /api/pair`）——与迁移解耦，按需另行 design
- provider credential/integration 体系（OAuth attempt 流、credential 管理）——见功能降级 #2

## 功能降级记录（v2 server 侧概念消失/缺口，验收口径同步）

| # | 降级项 | 原因 | 兜底 |
|---|--------|------|------|
| 1 | **任务卡（todo）**全链移除 | v2 无端点无事件（概念在 server API 层面消失） | 无（消息流内的计划文本不受影响；恢复等 server 侧概念回归另行设计） |
| 2 | **Provider 页签**（API key 设置/删除/已配置列表）降级隐藏 | v2 credential/integration 是全新体系：无 API key 写入端点、Provider.Info 无 key/connected 状态 | 无（v0.6+ 评估 credential 体系设计；连接凭据配置不受影响——那是 server 密码/token 层）。（2026-10-06 注：已恢复，见 design-v2/design-provider-config——版本归属待 v0.6 范围确定） |
| 3 | **文件监听自动刷新**失效（design-file-watcher） | 2.0.18 事件全集无 `file.watcher.updated`、无 watch 端点（M3 起静默失效，M6c 盘点确认） | 重开文件 Tab / 切作用域 / 重连对账触发重拉；链路代码保留待上游恢复 |
| 4 | 文件树 ignored 弱化样式 | v2 `FileSystem.Entry` 无 gitignore 标记 | 无害降级（同移动端）；dot 文件仍展示 |
| 5 | 命令集来源变化 | v2 注册制（无外部 skill 扫描） | `/api/skill` 合并对齐 v1 体验（命令集随 server 侧注册表自然变化） |

## API 映射（v2 要点；全集见 design-v2-migration §端点迁移映射）

| 功能 | API（v2） |
|------|-----------|
| 探活/版本/扫描验证 | `GET /api/info`（managed 健康等待与发现扫描同源换绑；v2 版本前缀校验淘汰 v1 server） |
| 会话列表/创建/改/删 | `GET/POST /api/session`（cursor envelope）、`PATCH/DELETE /api/session/:id`（级联删） |
| 未读标识 | 读 `Session.Info.time.idle`/`time.viewed`；标记已读 `POST /api/session/:id/view`（body `{idle}`）；事件 `session.viewed`（`{sessionID,idle}`） |
| 消息/prompt/中断 | `GET /api/session/:id/message`（typed union + cursor）、`POST .../prompt`（200 回执）、`POST .../interrupt` |
| 回滚 | 三段式：`POST .../revert/stage`、`DELETE .../revert`、`POST .../revert/commit`；提交由下一条 prompt 自动触发，事件收敛走 `session.revert.staged/cleared/committed` + 发送回执兜底 + 快照 `revert` 字段映射（design-sse-event-surface 三层策略） |
| worktree | `GET/POST/DELETE /api/worktree` + `POST /api/worktree/refresh`（库存直连 + 对账，2026-09-29 起消费，见范围表 #3）；删除成功后 `DELETE /api/debug/location?location[directory]=`（debug 组端点，pin 含——warm location evict，见范围表 #3） |
| shell | `POST /api/shell` + `GET /api/shell/:id`(/output) + `DELETE`（runShell 封装：一次性命令至终态，单命令 + exit code 判定跨登录 shell 可移植；分支挂载/清理通道，见范围表 #3） |
| 文件 | `GET /api/fs/list|read/*|find`（deepObject location） |
| diff | `GET /api/vcs/diff`（mode=working/branch）、`GET /api/session/:id/diff?from&context`（turn） |
| pty | `POST/PUT/DELETE /api/pty*` + `connect-token`（x-opencode-ticket 头）+ WS `/api/pty/:id/connect` |
| 待办交互 | `POST .../permission/:requestID/reply`、`POST .../form/:formID/reply`、`DELETE .../form/:formID`；回填 `GET /api/permission/request`、`GET /api/form` |
| 目录/切换 | `GET /api/agent`、`GET /api/model`、`POST /api/session/:id/{agent,model}` |
| 命令 | `GET /api/command` + `GET /api/skill`、`POST /api/session/:id/command` |
| SSE | `GET /api/event`（单流 volatile；重连必全量对账） |

## 验收口径

- [ ] 连接 v2 server（attach 15120 / managed spawn）：项目列表/会话/消息/文件树/终端/diff 全链路可用；`npm run test`/`typecheck` 全绿
- [ ] 连接 v1 server（1.18.x，如需另起端口）：连接失败并明确提示「服务器版本不支持，需要 opencode v2」（探活 unsupported 分类；欢迎屏测试连接同文案）
- [ ] 关 chat Tab → 重连后会话不在列表（官方 `time.archived`，≥2.1.3；存量 marker-only 首次快照后 backfill 转正清标记）；开 Tab → 字段清除；存量 time.archived 会话同样被识别为归档且取消归档持久（官方路径）
- [ ] 删除 worktree：级联删该目录全部会话（Tab 随关）；确认弹窗带 vcsStatus 非阻塞预检状态行（clean/dirty 危险色/error，不阻塞确认），确认即恒 force=true 删除（2026-10-12 修订，无二次强删弹窗）；外部删除经重连对账消失；**删除后该目录不在 `GET /api/debug/location` warm 集合（evict 生效——等 ≥2 个刷新周期（≥10 分钟）该目录伪项目行不再随 `GET /api/project` 再生，design-worktree-sync §3.4）**
- [ ] worktree 库存同步（2026-09-29）：他端（v2 API/移动端）创建的 worktree 左栏可见；已删除目录的 sandboxes 幽灵行不渲染且不再出现；本端创建默认切换到新 worktree（裸 `{directory}` 响应解析）
- [ ] worktree 分支挂载/清理（2026-09-29，design-worktree-branch-sync）：创建成功后 worktree 位于 `opencode/{name}` 分支（`git worktree list` 可见）；挂载失败降级 detached 且创建流程不受阻；删除 worktree 后分支被 `branch -D` 强制清除（无论是否已并入）；-D 失败时左栏提示
- [ ] 发送消息：乐观上屏 → 200 回执 → 首页重取精确清除；流式渲染（text/tool/reasoning）；他端发消息实时到达（inbox 链路）；断流重连后全量恢复（kill server 场景）；busy 中补充发送——enqueued 准入即物化（无「发送中」悬挂，chip/缩略图保留），投递后按 id 合并无跳变（design-inbox-admission）；**新会话（快照在途）发送后乐观按 inboxID 精确消解——重进会话无残留双气泡（design-optimistic-id-anchor）**；他端取消排队项 → 乐观即时撤回；**subagent 命令（`/review` 类）乐观经受理信号消解——子会话出生/POST 204 即清、bg-start 通知与任务卡接管呈现，无悬挂（§4b，2026-10-12）**
- [ ] 授权卡/表单卡：SSE 实时到达与回填恢复；boolean/选择/输入字段作答与 required 门控；404 他端已答静默移除
- [ ] 文件 Tab：文本/图片/PDF/二进制判定正确（含 `.ts` 文本——server MIME 误判不影响）；diff Tab 双模式 + 会话轮 diff
- [ ] 终端 Tab：创建/回放/live 输入/resize/主动退出（live 内 exit 自动关 Tab）/被动退出（连接已退出 pty 呈只读态）分流不变
- [ ] 斜杠命令：`/` 菜单列出 server 命令 + skill；长命令（>15s）不误判失败；命令回显消息回滚不回填草稿
- [ ] agent/model 切换：列表含全部 provider 模型；切换生效（会话回读正确）；label 显示友好名、切换键用 id
- [ ] 用户后台任务（design-subagent-background，2026-10-08 升格）：命令型与 `background:true`/前台转后台运行中任务卡常驻（分隔线上方槽位、通栏折叠、默认收起）、父会话指示器点亮；任务行整行点击查看（详情窗互斥替代任务卡，关闭返回列表保持展开）/停止；启动（或转后台）与完成系统提示落流（前台工具型不走任务卡）
- [ ] 后台 shell（design-shell-background）：agent `background:true` 派发即插「已启动后台命令」+ 任务卡入列（与子会话任务混排、指示器点亮）；完成/失败/取消/超时系统提示落流；输出详情窗（两段式尾部 1MB + 运行期截断 + 404 空态按因二分）；停止走 `DELETE /api/shell/:id`（按钮文案预告删档）；SSE 缺口与重启经 REST 对账全量重建
- [ ] 未读标识（design-unread-marker）：后台会话跑完后左栏（≤4 会话行）出现蓝点；点开（激活 chat Tab）即清（`POST /view`）且失败退避重试；激活 Tab 期间到达的完成不标未读（含窗口失焦）；他端 ack 经 `session.viewed` 收敛；断线重连后状态由会话快照收敛；未读不影响排序 / 活动时间（>4 会话行的聚合 chip 不做，另开分支）
- [ ] 消息文件路径自动链接（design-message-autolink，2026-10-11）：项目内路径（含行号、行内代码单一路径）转链可点 → 开文件 Tab（重复点击复用；带行号跳行且强制源码模式）；项目外/`../` 逃逸/裸域名/围栏代码块内不转链；外链仍走系统浏览器（回归）
- [ ] 降级项行为：无任务卡（无 todo 数据源）；设置无 Provider 页签；文件外部修改不自动刷新（重开 Tab 重拉）；文件树无 ignored 弱化
- [ ] 打包冒烟：`npm run package:linux` 成功产出
