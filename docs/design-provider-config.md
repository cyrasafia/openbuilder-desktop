# Provider/Model 配置设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #4。设置弹窗新增 Provider 页签（列表 + API key 设置/删除）；Model 配置复用现有「默认」页签（agent/model 切换）。

## 1. 契约事实（live server 1.18.20 实测，2026-09-04）

| 端点 | 行为 |
|---|---|
| `GET /config/providers?directory=` | **只返回已配置的 provider**（无 key 的不出现在列表）——适合"有没有任何 key"判定（欢迎屏 #1 用），不适合完整列表 |
| `GET /provider?directory=` | `{all: Provider[], default: Record<pid, modelID>, connected: string[]}`——**全目录**（models.dev 212 项）+ 每项 `key` 字段（已配置时有值）+ 已连接 id 集 |
| `PUT /auth/{providerID}` | body `{type:"api", key}`，**无 directory 参数**（auth 存储全局——auth.json），返回 boolean |
| `DELETE /auth/{providerID}` | 无 directory；返回 boolean |
| `Provider.key` | **响应含明文 API key**——客户端只做布尔判定（已配置/未配置），绝不展示/记录/持久化（同 rest-client 不暴露响应体原则） |

**spec 偏差修正**：spec API 映射写的是 `GET /config/providers?directory=`，实测该端点不含未配置 provider——Provider 页签的列表数据源改用 `GET /provider?directory=`（同族端点，契约以 openapi.json 与实测为准）。

## 2. Provider 页签（设置弹窗）

- 页签序：连接 | **Provider** | 外观 | 默认（靠近连接，同属 server 侧配置）
- 数据：进入页签时 `listProviders(directory)`（当前作用域目录，同 DefaultsSettings 的 `store.scopeQuery.directory`；无连接/无目录时显示引导文案不渲染列表）
- 列表呈现（212 项不可平铺）：
  - **默认视图 = 已连接组**（`connected` 或 `key` 非空者）：名称、source 徽标（api/env/config/custom）、模型数、key 状态、操作（更换/删除 key）
  - **搜索框**：输入时在全目录 `all` 过滤（id/名称子串，不区分大小写，上限 20 条）；空搜索回到已连接组
- **key 设置**：行内「设置 key」→ 弹窗内视图跳转（同 profile 表单模式：标题行返回钮，不叠二级弹窗）→ 输入框（type=password）+ 保存 → `PUT /auth/{id}` `{type:"api", key}`；成功回列表并重拉（key 状态与模型数刷新——配 key 后 provider 可用）
- **key 删除**：行内「删除」+ 二次确认（ConfirmDialog 复用）→ `DELETE /auth/{id}`；成功重拉
- **明文 key 策略**：列表只显示"已配置"状态点，不显示 key 内容；错误信息不回显响应体
- 刷新：页签内手动「刷新」按钮 + 每次操作成功后自动重拉

## 3. Model 配置

- **复用现有「默认」页签**（ModelSwitcherBar agent/model，design-agent-model-switch）——spec 明确"Model 配置 = 默认模型选择"，不新增 UI
- "provider key 配好而无默认模型时引导设置"：欢迎流程（#1）内串接——`model.defaults` 无 model 且存在已连接 provider 时欢迎屏给引导入口；本功能不涉及

## 4. 实现落点

| 文件 | 内容 |
|---|---|
| `src/shared/api-types.ts` | `ProviderInfo`（id/name/source/models 数/key 布尔化后的形状——**key: string \| null 保留在传输层，UI 层不消费**）；`ProviderCatalog { all, default, connected }` |
| `src/shared/rest-client.ts` | `listProviderCatalog(directory)`、`setProviderKey(providerID, key)`、`deleteProviderKey(providerID)` |
| `src/renderer/src/components/settings-dialog.tsx` | ProviderSettings 组件（注入 loader/save/remove 供测试）；页签注册 |
| i18n | providerTitle、搜索占位、已连接/全部、设置 key/删除/刷新、确认文案、错误文案（zh/en） |

- 组件数据操作经注入（默认实现走 `store.getActiveClient()`），jsdom 测试注入桩
- store 不新增持久化（provider 状态是 server 侧事实，每次进入页签拉取）

## 5. 测试

- rest-client：listProviderCatalog 的 query 拼装 / setProviderKey body 形态 / deleteProviderKey（现有 rest-client.test.ts 模式：mock fetch）
- 组件：已连接组渲染（名称/source/模型数/key 态）、搜索过滤全目录、设置 key 视图跳转 + 保存调用、删除二次确认、无连接引导态

## 6. 范围外（spec 明确）

- provider OAuth / wellknown 登录流（`/provider/{id}/oauth/*`）——仅 API key
- opencode config 表单化编辑（`GET/PATCH /config`）与 MCP 管理、自定义模型定义
