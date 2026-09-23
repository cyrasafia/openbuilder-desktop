# 模型列表（per-model 开关）设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #4 增补（2026-09-23）。设置弹窗新增「模型」页签：
按 provider 分组列出**已配置供应商**的全部模型，每模型一个开/关——关 = 从模型选择列表
（composer 工具条 / 默认值工具条）消失；开 = 恢复可选。开关状态**本地持久化、跟服务器
（profile）走**，删除服务器时清理。

> 参考移动端同类设计：`../openbuilder/docs/design-agent-model-switch.md` 三/四次评审
> （LR-G2 `ModelHideStore` / LR-M1 模型管理页 / LR-M2 去长按交互）。移动端已实证：
> server 无模型级启用信号，「隐藏」只能是客户端本地能力；管理页用 Switch、picker 只
> 反映结果（无隐藏折叠区）。桌面端按同语义落地，存储通道换本项目 store.json。

## 1. 契约事实（沿 design-agent-model-switch / design-provider-config 实测）

| 事实 | 来源 | 对策 |
|---|---|---|
| server **无模型级启用/禁用信号**——`/config/providers` 的 `Model` schema 无 `enabled` 字段 | 移动端 LR-G2（实测 1.18.20） | 开关纯客户端本地，不写任何 server 端点 |
| `GET /config/providers?directory=` 只返回**已配置**（有 key/env）的 provider | design-provider-config §1 | 正合「展示已添加供应商的所有模型」；数据源 = 既有 `modelCatalogs` 目录缓存（`parseModels` 拍平 + status 黑名单），与 picker 所见严格同源 |
| 模型 id 跨 provider 重名 | LR-4 | 开关键 = `(providerID, id)` 双字段（与 findModel/ModelRef 一致） |
| status 黑名单（deprecated/disabled）已在 `parseModels` 过滤 | design-agent-model-switch | 管理列表继承同一解析——被 server 侧标废弃的模型本就不可选，无需管理 |

无新增 API（复用 `GET /agent` + `GET /config/providers` 目录缓存与 SWR 拉取链路）。

## 2. 关键决策（编号供 grep，修订需在本文档内改写依据，不允许隐式推翻）

| 编号 | 决策 | 依据 |
|---|---|---|
| **D-ML-1** | 开关语义 = **例外集**：只存「关闭」的模型，不在集内 = 开（缺省全开） | 新模型上线自然可选、无迁移；关闭集空 = 无条目零存储；与移动端 ModelHideStore 同语义 |
| **D-ML-2** | 开关**跟服务器（profileKey）走**，不做目录维度：`models.disabled` = `Record<profileKey, Record<providerID, modelID[]>>` | 用户意图「不想用这个模型」是服务器级（移动端同按 connectionStore.activeId 隔离）；目录级隔离会让同一模型在不同项目反复开关。管理列表本身仍按当前作用域目录展示（与 Provider 页签/picker 同数据源），展示范围 ≠ 存储范围 |
| **D-ML-3** | 关闭的模型 **picker 不可选，但既有会话照常工作**（当前模型 pill 照显、thinking 控件照用、server 侧不动） | 移动端 LR-M1 既定语义（「隐藏的模型不会出现在对话页，仍可正常使用」）；server 是事实源，客户端不逆写 |
| **D-ML-4** | 生效默认（`effectiveDefaultModel`）解析在**过滤后的列表**上进行：显式默认被关闭 → 回退首个开启模型（同「失效默认」路径）；全部关闭 → 不带 model（服务器默认） | 「关闭 = 不可选」对新建会话同样成立——用被关模型开新会话违背用户意图；回退路径复用 AM-IMPL3-4 的失效默认机制 |
| **D-ML-5** | UI = 设置弹窗独立「模型」页签（Provider 与外观之间）：按 provider 分组行开关 + 组头「开启数/总数」+ 组头**收起/展开**（chevron，瞬时态不持久化）+ 组级**全部开启/全部关闭**（语境单钮）；**无搜索框/手动刷新/提示行**（2026-09-23 修订，初版三件按用户反馈精简——60+ 行列表内部滚动直给、开关即时生效无需说明文案、列表刷新依赖挂载拉取与 picker 打开时 SWR） | 管理是一等设置面（非一次性表单，不叠视图跳转）；分组/行样式复用 picker 的 `.ms-group`/`.ms-row` 词汇，Switch 用紧凑 track 自建（首例）；失败态提示自身可点击重试（页签内唯一重试入口）；组级操作与单模型开关共用同一批量纯函数写路径（单次落盘/emit） |
| **D-ML-6** | **删除服务器（profile）时清理其切片**：`saveProfiles` 收口（新旧 id 集差 = 被删 profile → 删 `models.disabled` 对应条目并落盘）；**模型级陈旧条目不做修剪**（server 侧模型下线后条目惰性无效——永不匹配任何列表行，无用户可见影响） | 用户需求「跟服务器走……服务器删除时清理」；profile 删除唯一入口是 ConnectionSettings「删除」→ `saveProfiles`（`model.defaults`/`project.state` 等既有键的同类清理仍留待统一 profile 清理，见 design-agent-model-switch 第四轮「未处理」，本键先行是因为它是新键无历史包袱）。目录级修剪需追踪全目录快照，成本不对称于零收益 |

## 3. 设计

### 管理页（「模型」页签）

- 守卫态与 Provider 页签同构：未连接 → `connectFirst`；已连接无项目（无作用域目录）→
  `modelsNoProject`（模型列表按目录查询，同 Provider 页签语义）；
- 数据：挂载 `ensureModelCatalog(directory)`（缓存命中即渲染，命中不重拉）；
  **无手动刷新钮**（2026-09-23 修订）——列表新鲜度依赖挂载拉取与 picker 打开时的
  SWR 重拉；失败态（`modelCatalogFailedFor`）提示自身可点击重试
  （`refreshModelCatalog`，页签内唯一重试入口）；加载中无缓存显示 `loading`；
- 列表：`parseModels` 结果按 provider 分组（首现序），行 = 名称 + id（mono）+ 开关；
  组头 = providerID（mono 大写）+ `开启数/总数` + 组级全部开/关钮；空目录（已加载）
  显示 `modelsEmpty`。**列表为唯一滚动层**（`.settings-models` 填满定高 dialog-lg 的
  dialog-body 余高，body 自身不滚——原 54vh 内层上限在高窗口下反而轮到 body 滚、
  吸顶失效），**组头吸顶**（`position: sticky` 贴列表顶，bg 不透明遮挡滚过的行，
  下一组头到达时无缝顶替——组间距/head 上边距清零防漏裸条带；picker 弹层内
  的 `.ms-group-head` 不受影响，选择器限定 `.model-list`）；
- 组头收起/展开：chevron 钮（ChevronDown/Right 12px，`.chevron` 档位与文件树同族，
  `aria-expanded`）；**纯视图瞬时态不持久化**——切页签/关弹窗即复位（同 find-in-page
  瞬态口径），收起时组头与计数常驻、行隐藏；
- 组级全部开/关：语境单钮——组内全开 →「全部关闭」，否则（含部分关闭）→「全部开启」；
  走 `setProviderModelsDisabled(providerID, 全组 id, disabled)` 批量写路径（`setDisabledModels`
  纯函数 ids 数组化，单模型开关传 `[id]` 同一通道，单次落盘/emit）；**开启只移除传入 id**，
  其他目录/陈旧条目保留（D-ML-2 展示按目录、存储按服务器的必然推论）；
- 开关写路径：行内即时 `store.setModelDisabled(providerID, id, !off)`（本地写 + 落盘 +
  emit 重渲染，无网络请求、无 loading 态）。

### 过滤生效点（关闭 = 不可选）

| 位置 | 行为 |
|---|---|
| ModelSwitcherBar 的 ModelControl（chat/引导页/设置默认值三挂点共用） | 列表 = `enabledModels(catalog.models, disabled)`：关闭项不列、分组计数收缩、搜索命不中它 |
| 引导页/设置「默认」工具条当前值（defaults 模式） | `effectiveDefaultModel` 在过滤后列表上解析：显式默认被关 → 显示首个开启模型（与失效默认同路径，AM-IMPL 第六轮「空目录保留显式值」的守卫仍以**全目录**空为判据——全开但全关时显示空值） |
| `createSession`（新会话应用默认） | 同上过滤后解析：被关默认回退首个开启模型；全部关闭 → 不带 model（服务器默认） |
| 当前会话已用被关模型（session 模式） | **不受影响**：pill 照显 `provider/id`、thinking 控件用**全目录** variants 照常切换（D-ML-3；picker 内无勾选行属预期） |

### 状态模型

```ts
// shared/model-catalog.ts（纯函数，vitest 覆盖）
type DisabledModels = Record<providerID, modelID[]>          // 例外集
isModelDisabled(record, providerID, id): boolean
setDisabledModels(record, profileKey, providerID, ids, disabled): Record<profileKey, DisabledModels>
  // 批量纯函数（单模型 = 单元素 ids）：无变化返回原引用；开启移除后列表空删
  // provider 键；切片空删 profile 条目
enabledModels(models, disabled): ModelInfo[]                  // 空集返回原引用
sanitizeDisabledModels(raw): Record<profileKey, DisabledModels> // 读入校验（同 sanitizeBrowserRecents 口径）

// app-store
disabledModels: Record<profileKey, DisabledModels>            // doInit 载入 models.disabled
disabledModelsFor(): DisabledModels                           // 当前 profile 切片
setModelDisabled(providerID, id, disabled)                    // 写 + storeSet + emit（单模型）
setProviderModelsDisabled(providerID, ids, disabled)          // 组级批量，同一写路径单次落盘
saveProfiles(...)                                              // 删除 profile → 清理切片（D-ML-6）
```

- 生命周期：不随 teardown 清空（内存镜像与持久层同源、profile 级跨连接存续；切 profile
  读另一切片，与 `defaults` 同模式）；
- 持久化：`window.desktop.storeSet("models.disabled", …)`（静态键，`StoreShape` 增补）。

## 4. 实现落点

| 文件 | 内容 |
|---|---|
| `src/shared/ipc.ts` | `StoreShape` 新增 `"models.disabled"`（静态键） |
| `src/shared/model-catalog.ts` | `DisabledModels` 类型 + `isModelDisabled` / `setDisabledModels`（ids 批量）/ `enabledModels` / `sanitizeDisabledModels` |
| `src/renderer/src/store/app-store.ts` | `disabledModels` 状态 + doInit 载入 + `disabledModelsFor` / `setModelDisabled` / `setProviderModelsDisabled` + `saveProfiles` 删除清理 + `createSession` 过滤后解析 |
| `src/renderer/src/components/model-switcher.tsx` | ModelControl 列表换 `enabledModels`（thinking 的当前模型查找保留全目录） |
| `src/renderer/src/components/settings-dialog.tsx` | 「模型」页签注册 + `ModelsSettings` 组件（导出供测试） |
| `src/renderer/src/i18n/index.ts` | modelsTitle / modelsNoProject / modelsEmpty / modelsEnableAll / modelsDisableAll（zh/en） |
| `src/renderer/src/styles/app.css` | `.settings-models`（填满 body）/ `.model-list`（唯一滚动层）/ 组头吸顶（`.model-list .ms-group-head` sticky）/ `.model-row` / `.model-toggle`（track 开关，首例）/ `.models-retry`（失败态可点击提示）/ `.ms-group-fold` · `.ms-group-side` · `.ms-group-action`（组头折叠与组级钮） |

## 5. 测试

- model-catalog：例外集读写（单/批量追加/移除/删键/删条目/原引用返回/ids 空与全在
  目标态 no-op、批量开启只清传入 id 保留陈旧项）、跨 provider 重名互不影响、
  enabledModels 过滤与原引用、sanitize 坏形状丢弃；
- app-store：`setModelDisabled` / `setProviderModelsDisabled` 落盘调用与切片回收、
  `saveProfiles` 删 profile 清切片（保留他 profile）、`createSession` 被关默认回退首个
  开启模型 / 首项被关取下一项；
- model-switcher：picker 不列关闭模型（分组计数收缩）、被关模型为当前会话模型时 pill/thinking
  照常、defaults 模式生效默认跳过被关模型；
- settings-dialog：分组渲染 + 开关调用 `setModelDisabled`、关态渲染与再开、组头计数、
  组头收起/展开（行隐藏他组不动、aria-expanded）、组级语境单钮（全开 → 全部关闭
  传全组 id；部分关 → 全部开启）、失败态提示点击重试、未连接/无目录守卫、挂载触发
  `ensureModelCatalog`、页签切换可达。

## 6. 范围外

- server 端模型启用/禁用（无此 API；不写 `PATCH /config`）
- provider 整体开关（server 侧已有 disabled provider 语义，且模型开关已覆盖实际诉求）
- 开关的导入/导出/跨设备同步（偏好同步范畴）
- 陈旧条目修剪（D-ML-6：惰性无效，零可见影响）
- `model.defaults` / `project.state` / `tabs.memory` 等既有 per-profile 键的删除清理
  （非本功能回归，留待统一 profile 清理）
