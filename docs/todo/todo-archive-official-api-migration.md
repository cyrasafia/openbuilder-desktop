# 官方归档 API 迁回（D1 私约退役）

> 状态：待办。触发：pin 升 2.1.3（2026-10-25），官方归档写路径回归——AGENTS.md D1「官方 API 回归后迁回」条件成立。契约面与活体验证见 ref-pin-bump-2.1.3 §2。

## 背景

v2 迁移时（2.0.18）无 REST 归档写入路径，桌面端定 D1 私约：关 Tab = 归档，写 `metadata.archivedAt`（`PATCH /api/session/:id`，metadata REPLACE 语义整包合并），识别层双源兼容存量 `time.archived`。移动端同构对齐（openbuilder `design-archive-metadata.md`）。

2.1.3 官方面齐了三件套：

- `PATCH /api/session/:id` body `archived: boolean | null`（204；`true` 置 `time.archived`、`false` 清除，活体已证）
- `GET /api/session?archived=true|false` 服务端过滤
- `session.archived` / `session.unarchived` 事件（durable，payload `{sessionID}`，信封带 location）

## 工作项（桌面端）

1. **写路径切换**：关/开 Tab 的 `PATCH` 从 metadata 整包合并改为 `archived` 布尔字段（rest-client + v2-adapter + app-store 归档/取消归档调用点）。
2. **识别层收敛**：`time.archived` 单源判定替换双源 getter；`metadata.archivedAt` 读取保留一个过渡期（见「存量迁移」）。
3. **事件面**：`handleEvent` 增 `session.archived`/`session.unarchived` 两 case——闸门走信封 `location.directory`（活体已证携带，无需 execution 式旁路）；归档态实时同步（他端归档即时反映，替代 60s 对账兜底）。
4. **过滤上移**：会话列表拉取改用 `?archived=false`（或按 UI 语义选参），客户端侧归档过滤逻辑退役。
5. **存量迁移**：既有 `metadata.archivedAt` 会话（约十余条量级，见 openbuilder design-archive-metadata 实测）需转正为官方字段。倾向：连接后对账阶段扫描双源差异、对仅私约归档的会话补发 `PATCH {archived:true}`，幂等可重试；补发完成后私约字段自然废弃。**决策点**：是否保留双读一版过渡（防迁移中断留半迁移态）。

## 工作项（移动端 openbuilder）

- 同构切换（写路径/识别/事件/过滤）；`SessionModel` 双源 getter 收敛；存量补发同桌面端策略（两端各自跑或任一端跑即可——幂等）。

## 不做

- 不迁 `Project.Time.archived`/`GET /api/project?archived=`（项目级归档面）——桌面端无项目归档 UI，Keep Lean。
- 不动 compaction/question 等被删事件的死 case（与归档无关，升 pin 审计已确认桌面未消费）。
