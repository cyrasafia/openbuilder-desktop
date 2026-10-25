# 结构化错误体消费（`_tag` 判别）与死目录语义化 — 待办

> 状态：待办（实施时另开分支）。触发：2026-10-25 pin 升 2.1.3 审计中的活体实证（ref-pin-bump-2.1.3 §3「错误面规整」条目的深挖）。
> 三条工作项共主题：错误体从"裸状态码"升级为可判别的结构化信号。
> **端归属**：工作项 1 纯桌面端——移动端 client（dio）按状态码分类（`net_error.dart` friendlyErrorRaw），**不解析错误体**，无从失配（其 404 同样无法区分 LocationNotFound/FileNotFound，#2/#3 的判别模式对移动端同构适用，但移动端伪行防御本身仍在对齐中——AGENTS.md「移动端同构（对齐中）」，待其防御落地后另行跟进，不在本 todo 范围）。

## 背景（实证基础，2026-10-25 本机 2.1.3 活体）

- **错误体形状**：server 错误体是**扁平 `_tag` 形**——`SessionBusyError` 409 = `{_tag, sessionID, message}`；`LocationNotFoundError` 404 = `{_tag, location:{directory}, message}`。三形状并存：扁平 `_tag`（多数错误族）、`{_tag, name, data}`（WorktreeError）、旧 `{name, data}`（2.0.18 pin 的 WorktreeError——2.1.3 起也带 `_tag`）。
- **存量失配**：`rest-client.ts` 错误解析按 `{name, data}` 口径（`ApiError.body` 类型 + `detail = body?.data?.message`），旧 pin（2.0.18）的 `SessionBusyErrorEncoded` schema **已是扁平**——失配非 2.1.3 升级引入，是存量 bug（写判别时从 WorktreeError 形状错误外推、409 竞争窗口难触发未活体验证），本次审计暴露。
- **404 行为非新增**：死目录请求 404 在 2.0.24+ 运行时已有（ref-pseudo-project-cleanup §3.4「请求多半 404，但建档副作用已发生」）；2.1.3 新增的是 **spec 声明 + `_tag` 结构化**（`LocationNotFoundErrorEncoded` 为新 schema）。
- **建档燃料未减**（活体复现一发一行）：fs/vcs/model 等 404 端点的死目录请求**照样建档**（解析先落行、后发现目录死、再 404）；session 列表（`?directory=` 非 location deepObject）与 worktree 请求不建档。伪行防御仍靠既有两件套（§3.5 挂起 + evict），2.1.3 未改变此格局。
- 附带发现：busy 窗口内并发 `prompt` 不再 409——`"delivery":"steer"` 排队 200；409 面收窄到 revert/stage 等操作。

## 工作项 1：ApiError 错误体解析升级（判别修复，存量 bug）

**现状受损**：`app-store.ts:5065/5094` 的 `e.body?.name === "SessionBusyError"` 恒 false（扁平体无 `name`）；busy 竞争时用户看到裸 `HTTP 409`——服务器 message 与友好文案「会话仍在进行中」双丢。所有扁平体错误的 message 提取同丢（`LocationNotFoundError` 显示 `HTTP 404` 而非 `Location not found: <dir>`）。

改法（`rest-client.ts` ApiError 与错误解析块）：

1. 类型提取双读：`tag = body._tag ?? body.name`；ApiError 增 `readonly tag?: string`。
2. message 提取双读：`detail = body.message ?? body.data?.message`（`{name,data}` 家族兼容保留）。
3. `app-store.ts` 两处判别改 `e.tag === "SessionBusyError"`。
4. `ApiError.body` 的文档注释更新（三形状口径，删「`{name, data}`」单形状表述）。

验收：vitest 补扁平体/包装体/`_tag+name+data` 三形状解析用例；活体 busy 窗口 revert 触发友好文案（竞争窗口用 python 并发脚本可控复现，2026-10-25 已验证可触发）。

## 工作项 2：死目录 404 静默吸收（删除窗口体验，2.1.3 使能）

**现状**：design-worktree-sync §3.5 接受项——挂起窗口内事件驱动的重载「Tab 短暂呈错误态」。之前无法做：404 无法区分「目录已删」与「文件不存在」（fs 域两类 404 并存）。现在 `_tag === "LocationNotFoundError"` 可精确判别（体带 `location.directory`）。

改法：location 域请求的消费方（文件树刷新 `fs/list`、vcs 面板轮询 `vcs/status`、diff 重载——§3.5 列的 17 个 location 方法的错误路径）对 `tag === "LocationNotFoundError"` 静默吸收：不上错误态、不重试、不 toast——目录已删是删除链路的预期结果而非故障。实现落点可在 rest-client 错误分类层做（配合工作项 1 的 tag），按目录匹配删除窗口/最近删除集判定。

## 工作项 3：他端删除的确定性收敛（§3.5 已知残留的自愈，2.1.3 使能）

**现状**：§3.5 兜底注——他端删除时本端 pty 清理等 location 请求仍可能落死目录，「接受偶发」。

改法：对账链路（`syncWorktrees`）**被动**收到 `LocationNotFoundError`（体带 `location.directory`）= 该目录已被他端删除的确证 → 即时触发该目录 unload（关 Tab/清引用/evict），把偶发伪行变成自愈收敛。

**边界（红线）**：识别 ≠ 探测——**不得**主动拿死目录发 location 请求做 liveness probe（probe 本身即燃料 6，一发一行）；只消费已有请求的错误回执。

## 不做

- 客户端死目录主动探测 / 项目列表指纹过滤——ref-pseudo-project-cleanup §8 已否决（误伤面 + 病根在上游 upsert-only 无回收）。
- 不动 409 busy 的 prompt 排队语义（steer 200 是 server 行为，客户端无需适配）。
- 错误文案 i18n——message 透出原文即可（现状惯例）。
