# Provider/Model 配置设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #4。设置弹窗新增 Provider 页签（列表 + API key 设置/删除）；Model 配置复用现有「默认」页签（agent/model 切换）。

## 1. 契约事实（live server 1.18.20 实测，2026-09-04）

| 端点 | 行为 |
|---|---|
| `GET /config/providers?directory=` | **只返回已配置的 provider**（无 key 的不出现在列表）——适合"有没有任何 key"判定（欢迎屏 #1 曾用，检查已随 2026-09-06 修订删除），不适合完整列表 |
| `GET /provider?directory=` | `{all: Provider[], default: Record<pid, modelID>, connected: string[]}`——**全目录**（models.dev 212 项）+ 每项 `key` 字段（已配置时有值）+ 已连接 id 集 |
| `PUT /auth/{providerID}` | body `{type:"api", key}`，**无 directory 参数**（auth 存储全局——auth.json），返回 boolean |
| `DELETE /auth/{providerID}` | 无 directory；返回 boolean |
| `Provider.key` | **响应含明文 API key**——客户端只做布尔判定（已配置/未配置），绝不展示/记录/持久化（同 rest-client 不暴露响应体原则） |

**spec 偏差修正**：spec API 映射写的是 `GET /config/providers?directory=`，实测该端点不含未配置 provider——Provider 页签的列表数据源改用 `GET /provider?directory=`（同族端点，契约以 openapi.json 与实测为准）。

## 2. Provider 页签（设置弹窗）

- 页签序：连接 | **Provider** | 外观 | 默认（靠近连接，同属 server 侧配置）
- 数据：进入页签时 `listProviders(directory)`（当前作用域目录，同 DefaultsSettings 的 `store.scopeQuery.directory`；无连接/无目录时显示引导文案不渲染列表）
- 列表呈现（**2026-09-23 修订：仅显示已配置项，全目录搜索与手动刷新移除**）：
  - 列表 = 已配置 provider：`key` 非空、`connected` 集内（多 env 候选 key 合并为 undefined 但已连接，review P2），或 `source === "custom"` 的自定义 provider（自定义端点可无 key 仍可用）——名称、source 徽标（api/env/config/custom）、模型数、key 状态、操作（设置/更换/删除 key）
  - 未配置且非自定义的 provider 不在 UI 出现（原全目录平铺+搜索的发现入口弃用；新增 key 先经 opencode CLI/配置文件配置，UI 内自定义 provider 行仍可设 key）
  - ~~搜索框：输入时在全目录 `all` 过滤~~（已移除，2026-09-23）
  - ~~页内提示文案「API key 存于 server 侧；仅支持 API key 形态」~~（已移除，2026-09-23）
- **key 设置**：行内「设置 key」→ 弹窗内视图跳转（同 profile 表单模式：标题行返回钮，不叠二级弹窗）→ 输入框（type=password）+ 保存 → `PUT /auth/{id}` `{type:"api", key}`；成功回列表并重拉（key 状态与模型数刷新——配 key 后 provider 可用）
- **key 删除**：行内「删除」+ 二次确认（ConfirmDialog 复用）→ `DELETE /auth/{id}`；成功重拉
- **明文 key 策略**：列表只显示"已配置"状态点，不显示 key 内容；错误信息不回显响应体
- 刷新：进入页签/作用域（连接态、目录）变化/操作成功后自动重拉（~~手动「刷新」按钮~~已移除，2026-09-23）

## 3. Model 配置

- **复用现有「默认」页签**（ModelSwitcherBar agent/model，design-agent-model-switch）——spec 明确"Model 配置 = 默认模型选择"，不新增 UI
- ~~"provider key 配好而无默认模型时引导设置"：欢迎流程（#1）内串接~~（已移除，2026-09-06：欢迎屏 provider 检查删除——无项目作用域时配置页签本就不可用，引导徒增一跳；配置入口 = 主界面设置，见 design-welcome-screen §4）

## 4. 实现落点

| 文件 | 内容 |
|---|---|
| `src/shared/api-types.ts` | `ProviderInfo`（id/name/source/models 数/key 布尔化后的形状——**key: string \| null 保留在传输层，UI 层不消费**）；`ProviderCatalog { all, default, connected }` |
| `src/shared/rest-client.ts` | `listProviderCatalog(directory)`、`setProviderKey(providerID, key)`、`deleteProviderKey(providerID)` |
| `src/renderer/src/components/settings-dialog.tsx` | ProviderSettings 组件（注入 loader/save/remove 供测试）；页签注册 |
| i18n | providerTitle、空态、设置/更换/删除 key、确认文案、错误文案（zh/en；2026-09-23 修订：搜索占位/刷新/提示文案键移除） |

- 组件数据操作经注入（默认实现走 `store.getActiveClient()`），jsdom 测试注入桩
- store 不新增持久化（provider 状态是 server 侧事实，每次进入页签拉取）

## 5. 测试

- rest-client：listProviderCatalog 的 query 拼装 / setProviderKey body 形态 / deleteProviderKey（现有 rest-client.test.ts 模式：mock fetch）
- 组件：已配置列表渲染（名称/source/模型数/key 态、自定义 provider 无 key 仍展示、connected 集并入）、设置 key 视图跳转 + 保存调用、删除二次确认、无连接引导态

## 6. 范围外（spec 明确）

- provider OAuth / wellknown 登录流（`/provider/{id}/oauth/*`）——仅 API key
- opencode config 表单化编辑（`GET/PATCH /config`）与 MCP 管理、自定义模型定义
