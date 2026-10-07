# Provider 面板设计（v2 credential 体系，A1 恢复）

> **状态**：已落地（2026-10-06/07 实现 + 两轮评审闭环；版本归属待 v0.6 范围确定，暂不建 spec）。v1 版本（`PUT/DELETE /auth/:provider`，API key 直写）随 M6d 降级移除，本文档整体改写为 v2 契约——credential/integration 体系（server ≥2.0.23，部分端点 2.0.18 起可用）。
>
> 待验收（活体走查，App 内）：① Provider 页签列表/更换 key/删除全流程；② 删除凭据后重连不复活。
>
> v1 历史决策（2026-09-23 修订：仅显示已配置项、无搜索/手动刷新、明文 key 不展示）**整体沿用**，本文只记差异。

## 0. 背景与范围

- spec-v0.5 降级表 #2：Provider 页签因「v2 无 API key 写入端点、无连接状态」移除。v2.0.23 起 credential/integration API 就绪（design-v2-migration 附录 A1），本端恢复面板。
- **范围内**：已配置 integration 列表 + API key 设置/更换/删除 + 连接状态（needs_auth 警示）。
- **范围外**（沿用 v1 §6）：OAuth/浏览器登录流（`connect/oauth` 端点存在但不在本期）、新增 integration 发现入口（全目录 229 项平铺 + 搜索已在 v1 弃用）、config 文件自定义 provider（不在 integration 目录内）。

## 1. 契约事实（live 2.0.23 实测 + 源码核对，2026-10-06）

| 端点 | 版本 | 行为 |
|---|---|---|
| `GET /api/integration?location[directory]=` | 2.0.18（pin 内） | `{location, data}`，data 全目录平铺（活体 229 项，models.dev 级）。项 = `{id, name, methods[], connections[]}`；method 三型：`{type:"key"}` / `{type:"env", names[]}` / `{type:"oauth", id, label, form?}`；connection 两型：`{type:"credential", id, label, method:"key"|"oauth", status?}` / `{type:"env", name, status?}`。**每条存储凭据各成一条 connection**（更换不删旧 → 可能多行）；env 连接由 server 进程环境变量在场生成；`status` 仅需重新认证时出现（`{status:"needs_auth", message, url?}`）。目录不存在 → data 为空数组 |
| `POST /api/integration/:integrationID/connect/key?location[directory]=` | 2.0.18（pin 内） | body `{key, label?, answer?}`，204。内部 = create credential 且默认 activate：旧凭据全量置 inactive 但**保留**（core `credential.ts` 事务，源码核对）。无 key 方法的 integration 500 |
| `DELETE /api/credential/:credentialID` | **2.0.23 起**（2.0.18–22 路由不存在 404） | 204；不存在的 id 也 204（幂等空操作，活体实测） |
| `GET/POST /api/credential`、`PATCH :id`（label）、`POST :id/activate` | 2.0.23 起 | **面板不消费**——connections 已含凭据 id/label；单槽语义由 connect/key + DELETE 组合达成；GET 返回值含明文 secret（协议自述 "including its secret value"），不拉取即不引入明文面 |
| 生成的 `openapi.json` 滞后 | — | v2.0.23/24 tag 的 openapi.json 只含 GET/POST `/api/credential`；`PATCH/activate/DELETE` 与 4 个 `connect/*` 端点在源码与二进制均在但未再生成。**credential 面以本文档实测表为准**（source `packages/protocol/src/groups/{credential,integration}.ts` v2.0.23 = v2.0.24 无 diff） |

其他事实：

- integration `id` 与 `/api/model` 的 `providerID` 同 namespace（models.dev）——模型数列直接按 providerID 分组计数。
- 凭据全局存储（无 directory 作用域）；v1 的 `?directory=` 影响 config 来源 provider 合成在 v2 集成目录无对应。
- `connect/key` 的 location query 影响配置解析，传当前作用域目录（与列表查询一致）。
- 2.0.18–2.0.22 server：列表与设置 key 可用，删除 404（错误经 ApiError 正常呈现，不做版本分支——本机与推荐版本已是 2.0.23+）。

## 2. 面板设计（设置弹窗，页签序：连接 | Provider | 模型 | 外观 | 默认 | 快捷键）

- **列表 = connections 非空的 integration，一行一条 connection**（多凭据 = 多行，每行可独立删除——诚实呈现存储实态）；空列表显示「尚无已配置的 provider」。
- 行呈现：状态点（credential 连接 on）+ integration 名称 + method 徽标（key/oauth/env）+ 凭据 label（env 行显示变量名）+ 模型数（`modelCatalogFor(directory)` 按 providerID 计数，无匹配显示 —）+ needs_auth 警示徽标（`status` 存在时，title = message）。
- 操作按 connection 类型：
  - credential + method key：「设置/更换 key」（弹窗内视图跳转，v1 同款）+「删除」（ConfirmDialog 二次确认）；
  - credential + method oauth：仅「删除」（重新登录 = OAuth 流，范围外；needs_auth 时徽标提示）；
  - env：无操作（环境变量由 server 进程管理，非凭据系统）。
- **更换 key 两段式**：`connect/key`（新凭据自动激活）成功后 `DELETE /api/credential/:旧id`（清 inactive 残留）；删除失败仅提示——旧行残留可再删，不阻塞。
- **新增 key 仅对已配置 integration**：v1 2026-09-23 裁定沿用（无全目录发现入口）。
- **明文策略**：列表数据源（connections）不含 secret；`GET /api/credential`（含明文）不调用——明文面为零，优于 v1（v1 列表响应含 key、靠 UI 不展示）。
- 刷新：进入页签 / 作用域（连接态、目录）变化 / 操作成功后自动重拉（请求序号守卫，v1 同款）；瞬态错误不清已渲染列表。

## 3. 实现落点

| 文件 | 内容 |
|---|---|
| `src/shared/api-v2-types.ts` | `V2IntegrationInfo` / `V2IntegrationMethod` / `V2Connection`（credential\|env union，含 `V2ConnectionStatus`） |
| `src/shared/rest-client.ts` | `listIntegrations(directory)`（envelope 解包）、`connectIntegrationKey(integrationID, key, directory)`（204 走 fetchResponse）、`removeCredential(credentialID)`（204） |
| `src/renderer/src/components/settings-dialog.tsx` | `ProviderSettings`（列表 + 注入 `ProviderOps`）与 `ProviderKeyForm`（视图跳转表单）恢复 v2 适配；页签注册（providers，紧邻 connection） |
| `src/renderer/src/styles/app.css` | provider 行/状态点/徽标样式恢复 + needs_auth 警示 |
| i18n | 恢复 v1 provider 键 + 新增 method 徽标 / needs_auth / oauth 删除确认文案（zh/en） |

- 组件数据操作经 `ProviderOps` 注入（默认实现走 `store.getActiveClient()`），jsdom 测试注入桩——v1 模式照搬。
- store 不新增持久化（server 侧事实，每次进入页签拉取）；模型数复用 `modelCatalogs` 缓存（`ensureModelCatalog` 由页签 effect 一并触发）。

## 4. 测试

- rest-client：`listIntegrations` URL/envelope 解包、`connectIntegrationKey` body/204、`removeCredential` 204 与 404 分类（mock fetch，现有模式）。
- 组件（注入 ops 桩）：列表渲染（名称/method 徽标/模型数/needs_auth）、key 行操作按钮、oauth 行仅删除、env 行只读、多凭据多行、设置 key 视图跳转 + 保存调用 + 更换后旧凭据 DELETE、删除二次确认、无连接/无项目/未连接守卫态。

## 5. v1 历史决策沿用清单（2026-09-23/09-06）

- 仅显示已配置项（全目录平铺 + 搜索弃用）；新增 key 先经 CLI/配置文件。
- 页签靠近「连接」（同属 server 侧配置）。
- 明文 key 不展示/不记录/不持久化；错误不回显响应体。
- 无手动刷新按钮；进入/变化/操作成功自动重拉。
- Model 配置不在此页签（模型页签 design-model-list 承接）。

## 6. 评审记录（2026-10-07，subagent，6 项全部当日闭环）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| P1 | 🟡 | key 表单 saving 中不冻结导航（Esc/返回/取消/关闭全可用）——两段式第二段失败的提示落在已卸载组件上静默丢失；列表无手动刷新入口，用户无感知 | saving 态经 `onSavingChange` 上提弹窗层：Esc 门控 + 返回/关闭 `disabled` + 表单取消钮 `disabled`（对齐 ProfileFormView busy 约定） |
| P2 | 🟡 | SettingsDialog 层接线（页签可达/视图切换/Esc 分层）零测试 | 补两条：页签可达 + 「更换 key → 表单 → Esc 两跳退列表/关弹窗」 |
| P3 | 🟢 | env 行变量名只在 tooltip，设计写的「label 列显示变量名」未实现 | 实现：env 行 label 列显示 `connection.name` |
| P4 | 🟢 | oauth 行删除钮缺 `danger` 类（与 key 行不一致） | 统一 `danger` |
| P5 | 🟢 | 删除失败/重载的错误文案对非 Error 抛出物会误映射为 connectFirst（吞真实错误）；"not connected" 映射不统一 | 模块级 `providerErrorText` 归一，三处调用统一 |
| P6 | 🟢 | rest-client 头注仍声明契约仅以 2.0.18 pin 为准，credential/integration 面不在 pin 内 | 头注补「credential/integration 面以本文档 §1 实测表为准」 |

**复审（2026-10-07，subagent 对 commit 3915d2b，3 项当日闭环）**：

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| R1 | 🟡 | saving 冻结漏遮罩点击路径——P1 修复的旁路（第四条离开路径） | 遮罩 onClick 同门控 `!pendingNew && !(providerEdit && providerSaving)` + 回归测试（悬挂 setKey 制造保存窗口） |
| R2 | 🟢 | ConfirmDialog 关闭后焦点回落 body，弹窗容器 onKeyDown 收不到 Esc（本文件自述要防的形态） | `closeConfirm` 在确认/取消两条关闭路径上显式 `document.querySelector(".dialog")?.focus()` |
| R3 | 🟢 | `removeCredential(target.oldCredentialID ?? "")` 空 id 死回退（confirming 恒有 id，`?? ""` 永不触发但真触发即请求空段路径） | confirming 类型收窄为 `{name, credentialID}`（credentialID 必填），删除复用 |
