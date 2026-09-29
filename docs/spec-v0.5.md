# v0.5 功能范围

主题：**v2 server 契约切换**——通信层（REST/SSE/对账）整体迁移到 opencode v2（GA，基线 2.0.18），v1（1.18.x）契约面删除。v0.5 起**仅支持 v2 server**（2026-09-28 裁定，双兼容不做：连接 v1 server 给出「版本不支持」明确报错，不做协议分派）。功能面承接 v0.1–v0.4 全量能力（除下列 server 侧概念消失的降级项）；迁移决策与契约映射全集见 [design-v2-migration.md](./design-v2-migration.md)，实施记录见 [plan-v2-protocol.md](./plan-v2-protocol.md)。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 通信层 v2 全量换绑 | REST 走 `/api/*` 面（session/project/worktree/fs/vcs/pty/command/permission/form/model/agent），SSE 走 `GET /api/event` 单流（`V2Event` 信封 + `session.*` 命名空间）；Basic auth（用户名固定 `opencode`）；**volatile 契约**下对账升级为重连必全量（会话 + 消息 + worktree + pending）；`rest-client-v2.ts` 更名 `rest-client.ts` 为唯一 client（v1 面删除，M6d） |
| 2 | 归档私约（D1） | 关 Tab = 归档改写 `metadata.archivedAt`（`PATCH /api/session/:id`，metadata REPLACE 语义整包合并）；识别层双源兼容存量 `time.archived`；官方归档 API 回归后迁回（迁移触发核对点见 plan-v2-protocol 复核清单） |
| 3 | worktree 域（D2/D5） | 创建/删除走 `/api/worktree`（delete force 必填，脏 worktree 400 forceRequired 二次确认强删）；**删除 = 级联删该目录全部会话**（非归档）；列表数据源 = `GET /api/project` 的 `Project.sandboxes` 投影（对账走项目列表全量 diff，外部删除等价可发现；D2 原案的 `/api/worktree` 直连与 refresh 未实施，列 v0.6 优化）；`instance/dispose` 退役（不映射 reload，服务层自管理） |
| 4 | 消息域（typed union） | v2 消息 11 型 union 经 `toInternalMessages` 收敛为内部形状（渲染管线不变）；分页 cursor 双向（上滚翻页走 `cursor.next`）；prompt 200 回执驱动乐观清除（`SessionInbox.User` 准入确认 + post-200 首页重取）；**流式事件翻译层**（`session.text/tool/reasoning/step.*` → v1 part 管线）；**inbox 落地链路**（M6c）：user 消息经 `session.inbox.enqueued|delivered` 实时落地（他端/命令），enqueued 非过滤项（compaction 等）不消费命令回显标记 |
| 5 | 待办人机交互（form 体系） | 授权卡换 `POST /api/session/:id/permission/:requestID/reply`（decision）；问题卡整体切 v2 form（`form.created/replied/cancelled` 事件 + `replyForm`/`cancelForm`）：字段六型归一化（select/multiselect/boolean 合成是/否/text/number 输入步），hidden/external 剔除，required 门控（Q-7：当前步未答不得前进）；回填 = `GET /api/permission/request` + `GET /api/form`（冷启动/开项目/SSE 重连） |
| 6 | 文件/diff/终端域 | fs 组（list/read/find，deepObject location）：read 是原始字节流，text/binary 客户端判定（NUL 嗅探为主——server MIME 库对 `.ts` 误判 `video/mp2t`，活体发现）；diff 双模式（vcs mode 映射 git→working；session diff turn 语义 + context=3 根治 v1 全文件 patch 陷阱）；pty 四方法 + WS connect（ticket 头 + 0x00+`{cursor:N}` 锚点帧 + close 1000/4404 分流——**契约逐项活体核对**，V2D-2 关闭，terminal-view 零改动兼容） |
| 7 | agent/model 目录与切换 | 数据源 `GET /api/agent` + `GET /api/model`（LR-1「/api/model 只返回一家」判断已过时，2.0.18 实测 65 模型跨 5 provider）；**wire id/name 错位映射**（id=标识符落 name 切换键、wire name 落 label 显示）；切换 `POST /api/session/:id/{agent,model}`（variant 条件包含） |
| 8 | 斜杠命令 | `GET /api/command` ∪ `GET /api/skill` 合并（skill 斜杠触发保留，source 标记）；`POST /api/session/:id/command`（body `{name,text,files}`，**timeoutMs: 0** 不设超时——同步端点 SC-4 教训）；命令回显经 inbox.enqueued 转记（回滚不回填展开文本草稿） |
| 9 | global 语义退役（D6/M1b） | v2 无 global 项目行（非 git 目录 = 目录哈希伪项目行以普通项目进左栏）；v1 `global\0<dir>` entry 模型删除，持久化旧键连接期迁移（`migrateLegacyGlobalState`）；新目录发现 = 项目列表刷新（连接/选择器/60s diff/project.updated） |

## 范围外（明确不做）

- **v1/v2 双协议**（裁定不做）：探测仅用于错误指引（连接/测试连接遇 v1 server 报「需要 opencode v2」）
- **v2 新能力**（persistent-pty、inbox 管理、skill 体系深度集成、websearch、session stats/log/import-export、配对 UI `POST /api/pair`）——与迁移解耦，按需另行 design
- provider credential/integration 体系（OAuth attempt 流、credential 管理）——见功能降级 #2

## 功能降级记录（v2 server 侧概念消失/缺口，验收口径同步）

| # | 降级项 | 原因 | 兜底 |
|---|--------|------|------|
| 1 | **任务卡（todo）**全链移除 | v2 无端点无事件（概念在 server API 层面消失） | 无（消息流内的计划文本不受影响；恢复等 server 侧概念回归另行设计） |
| 2 | **Provider 页签**（API key 设置/删除/已配置列表）降级隐藏 | v2 credential/integration 是全新体系：无 API key 写入端点、Provider.Info 无 key/connected 状态 | 无（v0.6+ 评估 credential 体系设计；连接凭据配置不受影响——那是 server 密码/token 层） |
| 3 | **文件监听自动刷新**失效（design-file-watcher） | 2.0.18 事件全集无 `file.watcher.updated`、无 watch 端点（M3 起静默失效，M6c 盘点确认） | 重开文件 Tab / 切作用域 / 重连对账触发重拉；链路代码保留待上游恢复 |
| 4 | 文件树 ignored 弱化样式 | v2 `FileSystem.Entry` 无 gitignore 标记 | 无害降级（同移动端）；dot 文件仍展示 |
| 5 | 命令集来源变化 | v2 注册制（无外部 skill 扫描） | `/api/skill` 合并对齐 v1 体验（命令集随 server 侧注册表自然变化） |

## API 映射（v2 要点；全集见 design-v2-migration §端点迁移映射）

| 功能 | API（v2） |
|------|-----------|
| 探活/版本/扫描验证 | `GET /api/info`（managed 健康等待与发现扫描同源换绑；v2 版本前缀校验淘汰 v1 server） |
| 会话列表/创建/改/删 | `GET/POST /api/session`（cursor envelope）、`PATCH/DELETE /api/session/:id`（级联删） |
| 消息/prompt/中断 | `GET /api/session/:id/message`（typed union + cursor）、`POST .../prompt`（200 回执）、`POST .../interrupt` |
| 回滚 | 三段式：`POST .../revert/stage`、`DELETE .../revert`、`POST .../revert/commit` |
| worktree | `GET/POST/DELETE /api/worktree`（refresh 端点存在但未消费，见范围表 #3 实况注） |
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
- [ ] 关 chat Tab → 重连后会话不在列表（metadata.archivedAt 过滤）；开 Tab → 字段清除；存量 time.archived 会话同样被识别为归档
- [ ] 删除 worktree：级联删该目录全部会话（Tab 随关）；脏 worktree 弹二次确认强删；外部删除经重连对账消失
- [ ] 发送消息：乐观上屏 → 200 回执 → 首页重取精确清除；流式渲染（text/tool/reasoning）；他端发消息实时到达（inbox 链路）；断流重连后全量恢复（kill server 场景）
- [ ] 授权卡/表单卡：SSE 实时到达与回填恢复；boolean/选择/输入字段作答与 required 门控；404 他端已答静默移除
- [ ] 文件 Tab：文本/图片/PDF/二进制判定正确（含 `.ts` 文本——server MIME 误判不影响）；diff Tab 双模式 + 会话轮 diff
- [ ] 终端 Tab：创建/回放/live 输入/resize/主动退出（live 内 exit 自动关 Tab）/被动退出（连接已退出 pty 呈只读态）分流不变
- [ ] 斜杠命令：`/` 菜单列出 server 命令 + skill；长命令（>15s）不误判失败；命令回显消息回滚不回填草稿
- [ ] agent/model 切换：列表含全部 provider 模型；切换生效（会话回读正确）；label 显示友好名、切换键用 id
- [ ] 降级项行为：无任务卡（无 todo 数据源）；设置无 Provider 页签；文件外部修改不自动刷新（重开 Tab 重拉）；文件树无 ignored 弱化
- [ ] 打包冒烟：`npm run package:linux` 成功产出
