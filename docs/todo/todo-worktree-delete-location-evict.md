# worktree 删除时顺手 evict location —— 待办（todo-worktree-delete-location-evict）

> 类型：todo（暂时不做、未来另开分支实施的工作项记录；与 plan 的区别见
> AGENTS.md 文档分类——plan 是即将实施的较大改动的分步执行计划）。
> 来源：2026-10-12 伪项目行定位（ref-pseudo-project-cleanup §3.4/§7c）。伪行「燃料 6」
> = server warm location 周期刷新：删行、归档会话、断客户端都断不了，唯有 server
> 重启或 evict location。已实测 `DELETE /api/debug/location` 可逐个 evict。
> 结论：桌面端 `removeWorkspace` 在 worktree 删除成功后顺手 evict 该目录 location，
> 从源头掐断再生。**不在本分支改**，实施时另开分支。
> 关联裁定：项目列表客户端过滤已否决（ref §8，易误伤且属上游问题）；本项是本端
> 唯一可做的止血点。

## 发现：warm location 是伪行第 6 种燃料（2026-10-12 实证）

机制链：

1. 客户端把目录作为 location 打开 → server 在内存保留该 location（warm）。
2. worktree 目录删除后，location **不随目录消失**。
3. location 每 **5 分钟**刷新 provider/model，刷新重新解析目录；目录已不存在 →
   `Worktree.DirectoryUnavailableError` → server 兜底按目录哈希 upsert 伪项目行
   （upsert-only，无回收）。
4. 所以：只要 location 还热着，伪行删多少次都会原地重建。

为什么不会被自动清掉（v2.0.18 源码事实）：

- `location-services.ts`：`idleTimeToLive: Duration.infinity` —— LayerMap 层**永不**
  闲置淘汰。
- `location-activity.ts` 有自动淘汰（60 分钟无会话活动 + 每 1 分钟 sweep），但任何
  durable 会话事件 touch 该 location 就续命。`kind-otter` 的会话在观测窗之前已全部
  归档，窗口内（2026-10-11 05:47Z 起）仍存活 27 小时、293 次 5 分钟节律
  `provider.updated`——说明窗口内持续有事件 touch，具体来源未实证（不排除刷新
  链路自身的事件形成自持环）。
- dev HEAD 已把 `idleTimeToLive` 改回 `"60 minutes"`（#34119），新版会自动淘汰；
  但内部刷新是否重置 idle 计时未活体复核，且未进 v2.0.x 发行线。

旁证：10-10 21:17 SQL 删行后 15 秒内约 1 行/秒重建 19 行；server 重启
（10-12 14:10）后 warm 集合清空，5 分钟刷新立即停止。

## 端点事实（v2.0.18 源码：`server/src/handlers/debug.ts`、`protocol/src/groups/debug.ts`）

| 端点 | 作用 | 备注 |
|---|---|---|
| `GET /api/debug/location` | 列出全部 warm location（`debug.location.list`） | 盘点用 |
| `DELETE /api/debug/location?location[directory]=<绝对路径>` | evict 单个（`debug.location.evict`），**204** | 已实测生效 |
| `POST /api/location/reload` | invalidate 全部后**立即重建** | 不适合清除（重建会再解析死目录） |

- 未文档化：pin 的 `opencode_openapi_v2.json` **无** `/api/debug/*`；上游升级必须回归。
- `requestRef` 取参顺序：`location[directory]` query → `x-opencode-directory` header →
  **`process.cwd()` 兜底**。裸调不带参数 = evict cwd 的 location，绝不可裸调。
- 单 location 的正式（非 debug）端点不存在；`LocationServiceMap.invalidate` 未包 HTTP。

## 解法（本端，另开分支实施）

落点 `removeWorkspace()`（`src/renderer/src/store/app-store.ts`）：

1. rest-client 新增单点方法 `evictLocation(directory)`：
   `DELETE /api/debug/location?location[directory]=<directory>`；注释标注
   「未文档化端点，server 升级需回归」。
2. 调用时机：`DELETE /api/worktree` **成功之后**（含 force 重试成功）。删除失败
   （`forceRequired` 等）时 location 保留是正确行为，不 evict。
3. best-effort：evict 失败不阻塞删除流程（与 `mountWorktreeBranch` 降级同风格）。
4. 顺序安全性：删除前该目录会话已级联删（D2 语义），evict 不会打断活会话；
   invalidate 语义为 detach 路由、borrowers 保留旧图到边界，无新增风险。
5. 可选兜底：`syncWorktrees`/库存对账发现死行时，对 `GET /api/debug/location`
   结果里目录已不存在的项批量 evict（防其他路径漏 evict）。

## 验收

1. 建 worktree → 打开作用域（boot location）→ 删 worktree →
   `GET /api/debug/location` 不含该目录。
2. 等 ≥2 个刷新周期（≥10 分钟）+ 主动 `GET /api/project` → 项目表无该目录伪行。
3. 单测：`app-store.test.ts` 现有 worktree mock 处补 `evictLocation`
   （742/810/834/863/945 一带）；断言删除成功路径必调、失败路径不调、
   evict 抛错不阻塞删除。
4. 回归：server 升级时核对 `/api/debug/*` 端点仍在、参数形状未变。

## 风险与边界

- debug 端点未文档化，上游可能改名/移除——单点封装在 rest-client，别散落调用。
- 治本在上游：location 发现失败不应 upsert project 行 + 补回收机制
  （ref §8 待办 issue）；本端 evict 是止血。
- 关联文档：ref-pseudo-project-cleanup §3.4（燃料 6）、§5.2、§7c、§8；
  design-v2-migration B6。
