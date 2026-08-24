# 会话 Agent / 模型 / 思考强度切换 + 全局默认模型 — 设计文档

> 参考移动端同类设计：`../openbuilder/docs/design-agent-model-switch.md`（数据源选型、
> variants/variants-dict 契约、跨 provider 重名、乐观切换等坑均出自该文档五轮评审）。
> 本文落地桌面端，交互按桌面习惯调整：popover 替代 bottom sheet、工具条并入 composer
> 操作行不占新行、键盘导航对齐 CommandHints 模式。
>
> 契约实测：本机 `127.0.0.1:15120`（server **1.18.20**），2026-08-24，测试会话已清理。

## 问题

1. chat 视图内需要切换当前会话的 **agent**（build/plan）、**模型**、**思考强度**（= 模型 variant）；
2. 需要**全局默认模型**：跨会话/项目记住首选模型（含 agent 与思考强度），新建会话自动应用；
3. 引导页（无会话）发送首条消息前也应能选择——选的就是全局默认值。

## 移动端踩过的坑（本设计直接规避）

| 坑 | 来源 | 桌面对策 |
|---|---|---|
| 🔴 **模型列表数据源选错**：v2 `GET /api/model` 只返回 opencode 一家模型（其余 provider 全缺），CLI/TUI 走的是 `/config/providers` | LR-1 | 数据源定为 v1 `GET /config/providers?directory=`，单端点同时覆盖模型列表 + variants，无需双端点合并 |
| 🔴 **Provider 对象含明文 API `key`** | LR-2 | rest-client 解析层只读 `id/name/models` 三字段，`key` 解析期丢弃（不进任何对象/日志/持久化） |
| 🟡 **`variants` 是 dict 不是 List**：`{"high":{"reasoningEffort":"high"}}`，按 List 解析会静默丢光思考等级 | LR-3 | 解析纯函数兼容 Map（取 keys 为 variant id）与 List 双形态；本机实测 1.18.20 为 dict 形态 |
| 🔴 **模型 id 跨 provider 重名**（`deepseek-v4-flash` 同时在 deepseek 与 ollama-cloud） | LR-4 / LR-R1 | 一律 `(providerID, id)` 双字段匹配，不做 id-only lookup |
| 🔴 **status 白名单误杀 beta**：`== 'active'` 把 `qwen3.8-max-preview` 等 beta 预览模型过滤掉 | LR-BL1 | 黑名单语义：仅排除 `deprecated` / `disabled`，其余（active/beta/缺省）放行 |
| 🔴 **subagent 误显**：`general`/`explore` 是 `mode:"subagent"`，不可设为会话主 agent | AM-FIX-1 | agent 过滤 `!hidden && mode !== 'subagent'`——与 server 自身语义一致（opencode `agent.ts:337` 自选默认 agent 即此条件）。**有意偏离移动端**：移动端排除 `all` 只留 `primary`，但 config 定义的自定义 agent 默认 `mode:"all"`（`agent.ts:276`），排除 `all` 会把全部用户自定义 agent 藏掉 |
| 🔴 **切换后 UI 不刷新（看似 no-op）** | AM-FIX-2 | 切换成功后**乐观写本地 session 记录**，UI 从 store 重读，不依赖父组件传参快照 |
| 🟡 **refresh 失败静默回退无提示** | AM-OPT-1 | 切换 POST 失败 → 状态栏错误 + 不改本地；成功 → 乐观更新，无二次回拉（见"切换语义"） |
| 🟡 **`switchModel` 无条件发 `variant:null`** | AM-3 | variant 字段条件包含：「默认」= 省略字段（本机实测确认可清掉已设 variant） |
| 🟢 **模型数 60+ 平铺难找** | 三次评审 | picker 按 provider 分组 + 顶部搜索（沿用移动端 `_ModelPickerSheet` 结构，形态改 popover） |

## 契约事实（本机 1.18.20 实测）

### 端点

| 功能 | 端点 | 说明 |
|---|---|---|
| 列 agents | `GET /agent?directory=<dir>` | v1，裸数组。实测 7 个：build/plan（primary 可见）、compaction/summary/title（primary 但 hidden）、explore/general（subagent） |
| 列模型 | `GET /config/providers?directory=<dir>` | v1，`{providers: Provider[], default: {providerID: modelID}}`。实测 6 家 66 个模型；`Provider.models` 是 `{modelID: {name, status, variants}}` map；`variants` 为 dict（如 glm-5.3 → `{"low":…,"high":…,"max":…}`） |
| 切 agent | `POST /api/session/:id/agent` | body `{agent}`，**204**。v2 路由，无需 location/directory 参数（实测裸调用可用） |
| 切 model | `POST /api/session/:id/model` | body `{model: {id, providerID, variant?}}`，**204**。variant 省略 = 清掉已设思考强度（实测：设 high 后省略 variant 再切，回读 `variant` 字段消失）。⚠️ 注意：既有会话（TUI/CLI 路径）大量带**字面 `variant: "default"`**（实测 69/100）——非"未设"，客户端读边界须归一化（`normalizeModelRef`，variants dict 无 "default" 键，归一化无歧义） |
| 建会话带模型 | `POST /session?directory=` | body 可带 `{agent, model: {id, providerID, variant?}}`（实测创建即生效，回读一致）——全局默认模型的应用通道 |
| 读单会话 | `GET /api/session/:id` | v2，`{data: SessionV2Info}` 包装（`agent`/`model` 在 data 内）——本项目不需要，v1 `/session` 列表已含 |

不采用：v2 `GET /api/model`（LR-1，只有 opencode 一家）；`PATCH /global/config`（见决策 D-AM-4）。

### 切换语义（实测，与移动端 1.18.3 时代不同）

- 切换成功**不推 `session.updated`**，推的是 `session.next.agent.switched` /
  `session.next.model.switched`（"next" = 待生效概念；payload 必填 `sessionID` + `messageID` +
  `timestamp` + 新 `agent`/`model`——`messageID` 即"自哪条消息起生效"的锚点）；
- 但 v1 `GET /session?directory=` 列表与 v2 单会话 meta **立即反映新值**——
  本端切换乐观更新后与快照天然一致；**跨客户端切换**（TUI/CLI 改了本会话）因无
  `session.updated` 可依赖，须消费这两个 next 事件增量补丁本地记录（见事件处理）；
- 对 busy 会话切换：新 agent/model 自**下一条消息**生效（服务端 next 语义），客户端无需处理。

### 联调实测教训（记入防再踩）

目录名含 `&`（如 `PRD&文档`）**必须**走 `URLSearchParams` 编码——手写 curl 未编码时
query 被截断、会话挂到坏目录，v2 端点集体 500，极易误判为端点不可用。本项目
rest-client 的 `dirQuery` 已统一编码，新增端点必须复用，不得手工拼 query。

## 设计

### 关键决策（编号供 grep，修订需在本文档内改写依据，不允许隐式推翻）

| 编号 | 决策 | 依据 |
|---|---|---|
| **D-AM-1** | 模型/agent 列表数据源 = v1 `GET /config/providers?directory=` + `GET /agent?directory=` | LR-1：v2 `/api/model` 只返回 opencode 一家；v1 端点同时覆盖列表 + variants，单端点无合并 |
| **D-AM-2** | 切换走 v2 `POST /api/session/:id/agent\|model`，成功后乐观写本地会话记录；消费 `session.next.*.switched` 事件做跨客户端增量补丁 | 204 无响应体；读路径实测即时一致，乐观与事件补丁收敛同一写路径即幂等 |
| **D-AM-3** | 思考强度 = 模型 variant（`variants` dict 的 keys）；「默认」= 切换请求省略 variant 字段 | variant 是服务端原生概念（`reasoningEffort`）；实测省略字段可清掉已设值 |
| **D-AM-4** | 全局默认模型存**客户端**（per-profile 持久化），经 `POST /session` body 应用；**不写** `PATCH /global/config` | 见「全局默认模型」小节三条理由 |
| **D-AM-5** | UI = composer-actions 行内工具条（不占新行）；agent 恰 2 个用分段开关、3+ 退化 popover；模型/思考 popover（分组 + 搜索） | 桌面密度；自适应规则沿用移动端实测结论 |

### UI：composer 工具条

两个挂点，同一组件 `ModelSwitcherBar`：

1. **chat 视图**（`workspace.tsx` ChatView）：绑定**当前会话**的 `session.agent` / `session.model`，切换写会话；
2. **引导页**（`workspace.tsx` GuidePage）：无会话，绑定**全局默认值**，切换即写默认值（发首条消息时经 `POST /session` body 应用）。
   例外：`pendingSession` 已存在（首条消息发送失败待重试，会话已实际创建）时，工具条**切换为会话绑定**（显示并切换该会话的实际 agent/model，与 chat 视图同路径）——否则工具条显示的是新默认值、重试复用的却是旧模型会话，展示与实际不一致。

位置：`composer-actions` 行内左侧（textarea 下方、发送/停止按钮的左侧），不新增行（桌面密度）：

```
┌──────────────────────────────────────────────────────┐
│  消息列表…                                            │
├──────────────────────────────────────────────────────┤
│  ┌─────────────────┐                                  │
│  │ 输入框           │                                  │
│  └─────────────────┘                                  │
│  [build│plan] [zai/glm-5.3 ▾] [思考: high ▾]  [发送]   │
└──────────────────────────────────────────────────────┘
```

三个控件：

| 控件 | 形态 | 行为 |
|---|---|---|
| **Agent** | 可见 agent **恰好 2**（build/plan）→ 分段开关（segmented toggle），点击即切、无下拉；**≥3** → 退化为 pill + ▾ + popover；**≤1** → 静态 pill | 自适应规则沿用移动端（2 agent 胶囊开关），形态桌面化：扁平分段、当前项 `primary-container` 填充、150ms 高亮迁移（不做平移动画——桌面控件小，无需测量定位那套机制） |
| **Model** | pill + ▾，点击弹 **popover**：顶部搜索框（autofocus）+ 按 provider 分组（组头 = provider id + 数量，保序）+ 当前项打勾 + 底部「设为默认」动作 | 搜索匹配 name/id/providerID（大小写不敏感）；高度上限 `min(60vh, 480px)` 内部滚动；provider 整组无匹配时隐藏 |
| **思考强度** | pill + ▾，**仅当前模型 `variants` 非空时显示**；选项 = 「默认」+ variants keys（low/high/max…） | 「默认」= 切 model 时省略 variant 字段；选中项打勾 |

**切模型时 variant 的携带规则**：从 picker 选中**另一个模型**时，仅当新模型有**同名 variant**才沿用当前思考强度，否则省略 variant（重置为「默认」）——保留用户意图（如 high 普遍存在）且不发送新模型不认识的值；thinking pill 随之立即反映新模型的 variants（可能隐藏）。

popover 通用行为（首个 popover 组件，后续终端/diff 复用）：受控 open、锚元素
`getBoundingClientRect()` 定位（fixed，向下展开、溢出翻转）、点击外部 / Esc / 选中后关闭、
列表 ↑↓ + Enter 键盘导航（对齐 CommandHints 交互词汇）；**打开期间**监听 window
resize/scroll（capture）重定位，锚点滚出视口则直接关闭——不做跟踪会让复用方各自踩坑。

引导页与 chat 视图的差异仅数据绑定：chat 切换走 v2 POST（乐观更新会话记录）；引导页切换只写 store 默认值（本地持久化，无网络请求）。

### 全局默认模型（D-AM-4：客户端 per-profile 持久化，不写服务器配置）

**存储**（自写 JSON store（electron-store 风格，`window.desktop.storeSet`），与 theme/locale 同通道）。
键形状对齐 `tabs.memory` / `project.state` 先例：**静态键 + `Record<profileKey, …>` 值**——
`StoreShape`（ipc.ts）是静态字面量键接口，`storeSet<K extends keyof StoreShape>` 不接受插值键：

```
key: "model.defaults"   // StoreShape 新增静态键
value: Record<profileKey, { agent?: string; model?: { id: string; providerID: string; variant?: string } }>
```

**应用点**：`AppStore.createSession()` → `POST /session` body 追加 `{agent, model}`（契约实测可用）。未设置的字段不传 → 服务器自身默认（global config / provider default）生效，两级默认自然叠加。

**入口**（同一 store 字段）：

1. 设置对话框新增「默认值」区：复用工具条编辑默认 agent/模型/思考强度；有默认值时显示
   「清除默认值」（恢复服务器默认——`setDefaults` 传 `undefined` 删字段）；
2. chat 视图 model popover 底部「设为默认」：把当前会话的 model（含 variant）一键写入默认值；
3. 引导页工具条直接编辑（见上）。

**为何不用 `PATCH /global/config {model: "provider/model"}`（服务器端全局默认）**：

1. **爆炸半径**：attach 模式连的是用户共享 server，改的是整个 opencode 生态（TUI/CLI）的默认，从 GUI 聊天客户端静默改全局配置属意外副作用；
2. **表达力**：`Config.model` 是 `"provider/model"` 字符串，**无法表达 variant**——思考强度会丢；
3. **正交性**：客户端默认（本 app 新建会话）与服务器默认（其他客户端/兜底）是两层，客户端层叠加在服务器层之上，不必合并。

> 服务器 `GET /config/providers` 的 `default` map（每家 provider 的默认模型 id）v0.2
> 不做展示（见"不做的事"）。

### 数据流

```
挂载 ModelSwitcherBar（chat 或引导页）
  → store.modelCatalogFor(directory)：缓存命中 → 立即渲染（SWR）
  → 未命中/后台刷新 → GET /agent + GET /config/providers（并行）
  → 纯函数解析（shared/model-catalog.ts）：
      agents: 过滤 !hidden && mode !== 'subagent'
      models: 拍平 providers[].models → 过滤黑名单(deprecated/disabled) → variants dict/List 双形态取 keys
      （Provider.key 解析期丢弃）

chat 视图切换 agent/model/variant
  → POST /api/session/:id/agent|model（204）
  → 乐观写 sessionsByProject 中该 session 的 agent/model 字段（AM-FIX-2：UI 从 store 重读）
  → 失败：不改本地 + connectionError（状态栏可见）；进行中重入守卫（switching 状态禁用控件）

引导页切换 / 设置对话框 / 「设为默认」
  → 只写 store 默认值 + storeSet 持久化（无网络）
  → createSession 时随 POST /session body 应用
```

### 状态模型

```ts
// shared/model-catalog.ts（纯函数 + 类型，vitest 覆盖）
interface AgentInfo { name: string; description?: string; mode: string; hidden: boolean }
interface ModelInfo {
  id: string; providerID: string; name: string
  status?: string; variants: string[]   // dict/List 双形态解析后的 keys
}
interface ModelCatalog { agents: AgentInfo[]; models: ModelInfo[] }

// app-store 新增
modelCatalogs: Map<directory, ModelCatalog>          // 内存缓存，teardown 清空
modelCatalogLoading = new Map<directory, Promise<void>>()  // in-flight 去重（对齐 commandsInFlight）
defaults: Record<profileKey, { agent?: string; model?: ModelRef }>  // 持久化 model.defaults
```

- **拉取时机**：chat 视图/引导页首次渲染工具条时拉取；**popover 打开时 SWR**（缓存立即渲染 + 后台重拉覆盖，失败保留缓存）。模型/agent 列表低频变化，不订阅 `catalog.updated`（那是命令/MCP 域）；
- **缓存生命周期**：`teardownConnection` 清空（切 profile 重建），目录级隔离（与 commandCache 同模式）；在途结果按 client 身份守卫丢弃；
- **事件处理**：store 新增消费 `session.next.agent.switched` / `session.next.model.switched`——按 sessionID 补丁 `sessionsByProject` 中该会话的 `agent` / `model` 字段。单全局流（design-sse-global-event）下 `handleEvent` 顶部已有 `isOpenedDirectory` 统一闸门，两个 case 无需各自设闸。本端乐观更新与事件补丁收敛到同一写路径，幂等；未打开目录的事件被闸门拦截，由下次快照兜底；
- **会话当前值**：`Session.agent` / `Session.model` 已在 api-types 声明，`sessionsByProject` 既有数据流自动携带（v1 列表 + SSE `session.updated`）。

### 错误处理（AM-OPT-1：不静默）

| 场景 | 行为 |
|---|---|
| 目录加载失败 | 工具条仍显示当前值（来自 session 记录/默认值），控件禁用 + tooltip「加载失败，点击重试」；点击重试 |
| 切换 POST 失败（4xx/5xx/网络） | 本地不变（乐观写在 204 之后，失败路径从未写过）+ `connectionError`（状态栏可见），控件恢复可用；无需回滚 |
| 切换中（in-flight） | 三控件全部禁用（防连点双发）；分段开关/勾选保持**旧值**——POST 极快，不做预迁移高亮（移动端 AM-CAP-3 原始结论：预迁移的闪烁回弹需回滚动画 machinery 收拾，桌面不值得） |
| 乐观值与后续快照不一致 | 以快照/SSE 为准（乐观只是填补 204 与下次快照间的窗口；读路径实测立即一致，窗口极小） |

## 涉及文件

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/shared/api-types.ts` | `AgentInfo` / `ModelInfo` / `ModelRef` / `ConfigProviders` 响应类型；`OpencodeEvent` 增补两个 `session.next.*.switched` 事件 | ✅ |
| `src/shared/ipc.ts` | `StoreShape` 新增静态键 `"model.defaults"`（`Record<profileKey, {agent?, model?}>`） | ✅ |
| `src/shared/rest-client.ts` | `listAgents(directory)` / `listConfigProviders(directory)`（key 丢弃）/ `switchAgent` / `switchModel`（variant 条件包含）/ `createSession` 增 agent+model 参数 | ✅ |
| `src/shared/model-catalog.ts` | 纯函数：目录解析（agent 过滤/黑名单/variants 双形态/(providerID,id) 匹配/默认值读写）+ 测试 | ✅ |
| `src/renderer/src/store/app-store.ts` | `modelCatalogs` 缓存 + SWR 拉取 + `switchSessionAgent/Model`（乐观）+ `defaults` 持久化 + `createSession` 应用默认值 | ✅ |
| `src/renderer/src/components/model-switcher.tsx` | 新组件：`ModelSwitcherBar`（agent 分段开关 + model picker + thinking picker）+ `Popover`（首个弹层原语） | ✅ |
| `src/renderer/src/components/workspace.tsx` | ChatView / GuidePage composer-actions 挂工具条 | ✅ |
| `src/renderer/src/components/settings-dialog.tsx` | 「默认值」区（agent + 默认模型选择器，复用 picker） | ✅ |
| `src/renderer/src/i18n/index.ts` | zh/en 词条（agent/模型/思考强度/设为默认/加载失败等） | ✅ |
| `src/renderer/src/styles/app.css` | 工具条/分段开关/popover/分组列表样式（token 复用 `--control-h`/`--radius-chip`/`--text-sm`） | ✅ |

实现落地时同步 `docs/spec-v0.1.md` 之后的版本范围（v0.2 spec 建档时纳入本功能）。

## 不做的事

- **模型隐藏/管理页**（移动端 LR-G2/LR-M1 的 `ModelHideStore` + `/models` 页）：60+ 模型全量展示在 v0.2 可接受（有搜索 + 分组），管理页留 v0.3；
- **写服务器全局配置**（`PATCH /global/config`）：理由见 D-AM-4；
- **provider 级 `default` map 的展示**（组头标注"默认"徽标）：纯锦上添花；
- **busy 会话的切换限制**：服务端 next 语义（下一条消息生效）已是正确行为，客户端不加禁制。

## 场景验证

| 场景 | 预期行为 |
|---|---|
| 打开 chat 视图 | 工具条显示 session.agent + session.model（id/variant）；目录数据惰性拉取 |
| build ⇄ plan | 分段开关点击即切（2 agent 形态），POST 204 → 高亮迁移 |
| 用户自定义 agent（config 定义，`mode:"all"`） | 可见可选（过滤只排除 subagent；含自定义 agent 时 ≥3 → 退化 popover 形态） |
| 切模型 | popover 分组 + 搜索可选 6 家 66 模型；选中打勾迁移、pill 更新 |
| 当前模型无 variants | 思考强度控件隐藏（不占位） |
| 切思考强度 | 「默认」⇄ low/high/max；「默认」清掉 variant（省略字段） |
| 切到另一模型（思考强度已设） | 新模型有同名 variant → 沿用；否则重置「默认」（省略字段），thinking pill 随新模型 variants 显隐 |
| 引导页切模型/agent | 只写本地默认值；发送首条消息 → POST /session 带默认值 → 会话以所选 agent/model 创建 |
| 引导页发送失败后改默认值再重试 | 工具条已切换为 pendingSession 会话绑定，显示/切换的是该会话实际值，重试所见即所发 |
| 「设为默认」 | 当前会话 model（含 variant）写入默认值；设置对话框同步显示 |
| 重启应用 | 默认值保留（per-profile 持久化）；新会话继续应用 |
| 切目录/项目 | 工具条数据按目录重新解析（缓存命中即渲染） |
| 跨 provider 重名模型 | `(providerID, id)` 匹配，勾选与切换不误选 provider |
| beta 状态模型 | 可见可选（黑名单只挡 deprecated/disabled） |
| 断网时打开 picker | 显示缓存（如有）+ 后台重拉失败保留；无缓存则控件禁用 + 重试 |
| 切换 POST 失败 | 本地不变、connectionError 可见、控件恢复可用 |
| TUI/CLI 侧切模型 | `session.next.*` 事件到达 → 本地记录增量补丁 → 工具条即时跟随 |

---

## 实现评审（commit `e66de4e` 之后）

> 评审基线：实现代码全文 + 本文档规格对照。`typecheck` clean、`npm test` 84/84、`npm run build` 通过。

### AM-IMPL-1 🟡 引导页 `pendingSession` 工具条渲染陈旧值 · 已修复

`GuidePage` 把 `pendingSession.current`（ref 持有的创建时 Session 对象）直接传给工具条。乐观补丁
（`patchSessionAgent/Model`）在 `sessionsByProject` 里写的是**新对象**、不 mutate ref 对象——
首条发送失败 → 工具条切会话绑定 → 用户切模型 → POST 成功、store 已更新，但工具条继续渲染
旧对象、勾错行。这正是设计"移动端踩过的坑"表 AM-FIX-2 的陷阱。
修复：改传 `store.findSession(pendingSession.current.id) ?? pendingSession.current`（与 ChatView 同路径）。

### AM-IMPL-2 🟡 SWR 失败覆盖好缓存为空目录 · 已修复

`refreshModelCatalog` 两个请求各自 `.catch(() => null)` 后**无条件**写 `parseCatalog(null, null)`（空）。
场景：目录已加载 66 模型 → 网络抖动 → 打开 popover 触发重拉 → 失败 → 好缓存被空覆盖 → 列表"无匹配模型"。
违反错误表"失败保留缓存"。修复：**按数据源分别保留**——单源失败保留该源旧值；两源全失败且无缓存 →
记入 `modelCatalogFailed`（工具条渲染「加载失败」重试入口）；有缓存则保留、不进失败态。

### AM-IMPL-3 🟡 ChatView busy 时整体禁用工具条 · 已修复

`disabled={busy}` 使整个生成期间工具条 `pointer-events:none`——违反"不做的事"第 4 条
（"busy 会话的切换限制……客户端不加禁制"，服务端 next 语义即正确行为）。
错误表"切换中"行指的是切换 POST in-flight（内部 `switching` 态），不是会话运行中。修复：删除该禁用。

### AM-IMPL-4 🟡 "目录加载失败"重试入口未实现 · 已修复

初版首次加载失败会缓存空目录 → `ensureModelCatalog` 见 `has()` 为真不再重试，且无失败态展示
（`modelLoadFailed` 词条无人引用）。修复：`modelCatalogFailed` 集合 + `modelCatalogFailedFor()`；
`ensureModelCatalog` 失败态目录重试；工具条失败态渲染可点击重试的静态值条（显示当前 agent + model 值）。
同批补：agent popover（≥3 形态）打开时也 SWR 重拉（此前仅 model popover 触发）。

### AM-IMPL-5 🟡 键盘导航不全 + 焦点行不滚入视野 · 已修复

设计约定三个 popover 均 ↑↓+Enter（对齐 CommandHints），初版仅 model popover 有（经搜索框），
且 60+ 模型连按 ↓ 焦点行滚出视野（`listRef` 挂了但没用）。修复：
- agent（≥3）/ thinking popover：`tabIndex=-1` 聚焦容器 + `onKeyDown` 导航 + 打开时 `requestAnimationFrame` 聚焦；
- 三个列表统一在 `sel` 变化时 `.ms-row.focused` `scrollIntoView({block:"nearest"})`（CommandHints 同模式）。

### 🟢 次要项（同批修复）

- `Popover` `posRef` 写了不读（死代码）→ 删除；
- `Popover` `onClose` 内联箭头每次渲染新身份进入 `useLayoutEffect` deps——流式期间每个 SSE part
  事件全树重渲染会重注册监听器 + 重算定位 → 改 `onCloseRef` 稳定引用；
- defaults 模式切模型丢失已设 variant（session 模式走携带规则）→ 两模式统一执行携带规则；
- `AgentControl` 两个相同的 `agents.length <= 1` 分支合并；`loading` 参数无用后移除。

### 评审核对结论

D-AM-1（v1 端点）/ D-AM-2（204 后乐观写 + next 事件幂等补丁、共享写路径）/ D-AM-3（variant 条件包含）/
D-AM-4（per-profile 默认值经 POST /session body）/ D-AM-5（2 agent 分段 / 3+ popover / variants 空隐藏）/
`(providerID, id)` 匹配 / status 黑名单 / key 不进解析结果 / popover 点击外部·Esc·跟踪·出视口关闭——
均按规格落地，携带规则、key 丢弃、默认值读写有单测覆盖。

### 第二轮评审（`40afac1` 之后）

| 编号 | 问题 | 修复 |
|---|---|---|
| AM-IMPL2-1 🟡 | popover 上翻估算高度取死值 400，与实际 `max-height: min(60vh, 480px)` 不符——主用路径（composer 贴窗口底、恒上翻）弹窗底部侵入锚点区 76px 遮挡工具条 | 估算改 `Math.min(innerHeight*0.6, 480)` 与渲染约束一致，翻转判定与 `top` 同基准，上翻后底边恒 ≤ 锚点上沿 |
| AM-IMPL2-2 🟡 | session 模式 `session==null` 时落入 `else` 分支**写全局默认值**（`mode==="session" && session` 的 else 混淆了两种模式）——未来任何"Tab 在、会话记录缺失"的路径都会静默污染 profile 默认 | 三个 onPick 改为模式分支后判空：`mode==="session" && !session` → no-op（对齐 ThinkingControl 既有的 `!currentModel` 守卫模式） |
| AM-IMPL2-3 🟢 | 设置「默认值」区：已连接但无打开项目时 `directory=""`，`refreshModelCatalog` 空目录早返回 → 永久"加载中" | 无目录时渲染 `noProject` 提示，不挂工具条 |
| AM-IMPL2-4 🟢 | 默认值一旦设置无清除入口（`setDefaults` 支持删字段但无调用方） | 设置「默认值」区「清除默认值」按钮（`hasDefaults` 为真才显示，`{agent: undefined, model: undefined}` 全删）；顺带消化了无引用的 `hasDefaults` |
| 🟢 次要 | 未使用词条 `agent`/`defaultAgent`/`defaultModel`/`defaultThinking` | 删除 |

### 第三轮评审（分支对 main 整体复核）

| 编号 | 问题 | 修复 |
|---|---|---|
| AM-IMPL3-1 🟡 | GuidePage 挂工具条未防空目录（与 AM-IMPL2-3 同洞）：已连接但无打开项目时 `directory=""`，`refreshModelCatalog` 早返回 → `catalogLoading` 永真、模型 pill 永久"加载中" | `ModelSwitcherBar` 顶部统一 `!directory → return null`（所有调用方受益） |
| AM-IMPL3-2 🟢 | 服务端既有会话带字面 `variant:"default"`（实测 69/100）：思考强度 pill 渲染原始字符串、弹窗无任何行打勾 | 读边界归一化 `normalizeModelRef`（"default" → 未设，纯函数 + 测试）；工具条/`createSession`/「设为默认」统一走归一化值 |
| AM-IMPL3-3 🟢 | GuidePage 会话模式仍用作用域目录加载目录数据——引导页 fiber 跨作用域切换存活，发送失败 + 切作用域后列表与会话 provider 集不符 | 会话模式用 `pendingSession.directory`（对齐 ChatView） |
| AM-IMPL3-4 🟡 | 失效默认值（provider 下线/模型改名）被 `POST /session` 盲目接受（实测无效模型 200 落库），首条 prompt 才以不明错误爆发且循环 | `createSession` 应用前按已加载目录校验（无效跳过、回退服务器默认）；目录未加载不阻塞；`createSession` 读默认值同时归一化 |
| AM-IMPL3-5 🟢 | AgentControl 形态 3+→2 时遗留 `open` 态，2→3+ 后 popover 自发重开 | 分段形态时重置 `open` |
| 说明 | `package.json` `allowScripts` | 有意保留：本机 npm 的 `install-scripts` 机制（esbuild postinstall 白名单），构建必需 |

### 第四轮评审（分支对 main 整体复核）

| 编号 | 问题 | 修复 |
|---|---|---|
| AM-IMPL4-1 🟡（条件） | `createSession` 校验默认模型存在但**不校验 variant**（AM-IMPL3-4 同类）：模型 variant 集后来收窄（如只剩 low/max）时，失效的默认 variant 被盲收 | 目录已加载时按目标模型的 `variants` 校验；无效 → 只丢 variant 保模型 |
| 🟢 一致性 | thinking popover 打开时未 SWR（agent/model 均已补） | ThinkingControl 补 `directory` + 打开时 `refreshModelCatalog` |

#### 未处理（评估后接受）

- **部分目录失败会静默丢默认值**：单源失败（无旧缓存）而另一源成功时，失败源的列表为空
  （`catalog.agents = []` 或 `catalog.models = []`），有效默认值过不了校验被跳过
  （回退服务器默认）。agents/providers 两源对称同此机制。要求对应端点恰好失败且无缓存、
  又恰在重试前建会话——概率低、后果可恢复（会话只是用了服务器默认 agent/模型，
  工具条空态也会提示目录异常），不做源级失败标记（复杂度不值）。
- **删除 profile 不清理其 `model.defaults` 条目**：与 `project.state` / `tabs.memory`
  既有行为一致（同属按 profileKey 隔离、不随 profile 删除回收），非本次回归，统一留待
  将来做 profile 清理时一并处理。

### 第五轮评审（rebase main 之后）

> 基线：rebase 至 `6e81b43`（main 领先 14 提交，含 SSE 单全局流重构）后的分支整体。
> 复核结论：无确定性 bug；契约对 live 1.18.20 逐项核对一致（含 `session.next.*` payload、
> 204 body、`POST /session` 带 agent/model、`/config/providers` 明文 key 存在性）。

| 项 | 处理 |
|---|---|
| 🟢 `timestamp` 类型分歧 | pin 的 spec（1.17.18）标 `number`，live 1.18.20 实测推 ISO 字符串——按仓库惯例 live 优先，`api-types` 保留 `string` 并注释分歧（字段未被消费） |
| 🟢 「设为默认」无反馈 | 点击后关闭 popover（与行选中行为一致） |
| 🟢 次要 | `ModelControl` groups `useRef` 改局部 `const`（每次渲染全量重建，ref 无跨渲染语义）；测试文件补尾换行 |
| 🟡 文档补全 | 「未处理（评估后接受）」部分目录失败条目补 providers 源对称情形（此前只写了 agents 源） |
| 已记录非问题 | GuidePage pendingSession 跨作用域存活 = 既有发送重试语义；popover 打开期逐滚动重渲染、`flatRows.findIndex`（66 模型 ~4k ops）在此规模可忽略 |
