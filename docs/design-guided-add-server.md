# 添加服务器引导式（发现优先）设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #2/③ 的补充交互修订（2026-09-05）：设置弹窗「添加服务器」从直开表单改为**先搜索、后手填**的引导式。依赖功能 #3 的扫描基础设施（[design-auto-scan.md](./design-auto-scan.md)，`scanServers`/`scanBinaries` IPC 面不变）；手动配置页为原 ProfileFormView 的改版（[design-managed-config.md](./design-managed-config.md) §1 分化规则不变）。

## 0. 动机与原则

- 原流程：点「添加」直接落表单，扫描埋在 managed 模式的候选区里——attach 用户感知不到 mDNS 发现，managed 用户要先找到藏在底部的模式下拉。两个高价值入口（自动发现）都被表单字段挡住
- 新流程把发现提到最前：多数场景用户点一下候选即完成配置（零表单、零输入）；手填降级为兜底入口
- 交互形态源自欢迎屏的扫描→候选→连接链路；**2026-09-06 反向统一：欢迎页只呈现「添加服务器」入口，点击后同源复用本设计的 DiscoverView + ProfileFormView**（design-welcome-screen §3，非复制），行为差异全部参数化（欢迎屏注入 busy/emptyContent/saveLabel/onPick 连接语义）

## 1. 视图状态机

SettingsDialog 的 editing 状态从 `{ profile, isNew }` 扩为二态：

```
type EditingState =
  | { view: "discover" }                                    // 发现视图（新增入口）
  | { view: "manual"; profile: ConnectionProfile; isNew }    // 手动/编辑表单
```

- **新增**：列表「添加」→ discover；「手动配置…」→ manual（isNew: true，草稿 = 原 attach 默认值）
- **编辑**：列表行「编辑」→ manual（isNew: false），**不经发现视图**（编辑是精确修改，无发现需求）
- 返回层级（Esc/返回钮同路径）：
  - manual(isNew) → discover（丢弃草稿）→ 列表 → 关弹窗
  - manual(编辑) / provider key 表单 → 列表 → 关弹窗（review P2 的 Esc 分层语义不变）
- 标题行视图标题：discover = 「添加服务器」；manual = 「手动配置服务器」(isNew) / 「编辑服务器」；标题行结构（返回钮 + 关闭钮）与 provider key 表单共用骨架

## 2. 发现视图（discover）

### 2.1 并行搜索、先到先列

- 进入即**同时**发起 `scanServers()` + `scanBinaries()`（不互相等待——mDNS 4s 窗口不拖二进制扫描的展示，反之亦然）；两路各自落地、各自渲染
- 「搜到即列」：servers 候选区与 binaries 候选区按两节排布（发现的服务器 / 本机 opencode），attach 与 managed 候选**混排**在同一列表体里，各自带来源信息（attach 候选带「本机/局域网」来源徽标 + 版本；binary 候选带路径 + 版本）
- 搜索中 = 显式 scanning 态或任一路未回（guided review 修订）：底部 form-note「正在搜索…」，「重新搜索」钮禁用；**重搜同样置 scanning**（两路已非 null 的 rescan 无 null 判据可依，须显式态给反馈），双路全落地才清；两路都完成且零候选才给空态文案
- **迟到响应丢弃**：视图内 seq 代际（rescan 递增）——上一轮的迟到结果不覆盖新一轮
- 严格模式双触发安全：main 侧 `scan:binaries`/`scan:servers` 已有 in-flight Promise 去重（design-auto-scan §4）
- **焦点管理（guided review 修订）**：列表/发现视图聚焦弹窗容器（无 autoFocus 元素的视图进入时焦点随上一视图卸载回落 body，Esc keydown 落不到弹窗容器静默失效）；manual/provider 表单由各自 autoFocus 输入框落焦点，不在聚焦范围

### 2.2 候选一键建档（点击 = 保存）

- attach 候选：`{ id: prof_*, name: url, baseUrl: url, mode: "attach" }`——health 已在扫描侧验证（design-auto-scan §3.3），无需再测
- managed 候选：`{ id: prof_*, name: "", baseUrl: "", mode: "managed", binaryPath: 候选路径 }`
- 点击即调 `saveProfiles(next, store.activeProfileId)`（追加，不自动激活）→ 退回列表视图；用户在列表「启用」才连接
- name 取 url/空串与欢迎屏候选建档口径一致（2026-09-06 起两侧同源复用 DiscoverView/ProfileFormView——空名 managed → 列表回落展示 binaryPath）

### 2.3 手动入口常驻

- actions 区：左「重新搜索」（灰底常规钮）、右「手动配置…」（btn-primary）——**任意时刻可见**（含搜索中/空态），不等搜索完成
- 手动入口是主按钮：搜索失败/无候选时它是唯一出路；搜索成功时它是高级配置入口（自定义端口、凭据、非常见路径）

## 3. 手动配置页（manual）改版

- **模式选择置顶**：select 下拉 → segment control（复用 `.ms-segmented`/`.ms-seg`，单一来源不另起一套）；两段短标签「连接现有服务」/「本机启动」（原长标签 `attach（连接现有服务）` 废弃——segment 放不下长句，attach/managed 术语已在列表行 profile-mode 徽标里保留）
- **一句话说明**：segment 下方 form-note，随选中模式切换（attach：「连接一个已在运行的 opencode server…」/ managed：「用本机的 opencode 自动启动一个 server…」）——模式语义是新增流程最大的理解门槛，说明必须与切换同屏
- 表单字段分化、扫描候选、测试连接、保存/取消 actions 与 design-managed-config §1 完全一致，不再重复

## 4. 交互细节

- 建档后不弹 toast、不自动激活：列表视图回显新行即反馈（profile-list 直读 store）
- discover 视图无「取消」钮——返回钮/Esc 即取消（无草稿可丢）
- manual（新增）的「取消」丢弃草稿回 discover（不是列表）——用户可能只是想换一种模式再来，回发现视图少一跳

## 5. 实现落点

| 文件 | 内容 |
|---|---|
| `settings-dialog.tsx` | `EditingState` 状态机；`DiscoverView`（双扫描并行 + 代际守卫 + 候选建档；**导出供欢迎屏复用**，`busy`/`emptyContent` props，2026-09-06）；ProfileFormView 模式段置顶（**导出**，`saveLabel`/`busy` props）；Esc 分层扩展 |
| i18n | `discover*` 8 键 + `addProfileManualTitle` + `modeAttachDesc`/`modeManagedDesc` + `modeAttach`/`modeManaged` 改短标签（zh/en） |
| app.css | `.discover-candidate`（同 `.scan-candidate` 骨架 + main/徽标行内布局）、`.discover-actions`（space-between）、`.profile-mode-seg`/`.profile-mode-desc` |
| 测试 | `settings-dialog.test.tsx`：发现视图组（并行启动、先到先列、悬挂一路保持搜索中、空态、server/binary 候选建档与退回、重新搜索、Esc 分层）+ manual 组（模式段切换、字段分化、编辑直落）；store mock 不变 |

## 6. 已知取舍

- 发现视图不展示 server 的凭据输入——扫描验证不带 auth（design-auto-scan §3.3 同源）；受 Basic auth 保护的 server 扫描不出来，须走手动配置（与 mDNS 发布面一致的既有约束）
- managed 候选建档不预选 name（空名回列表展示 binaryPath）——避免在发现视图引入第二个输入面
- 一键建档不合并「已存在的同 URL profile」——重复点同一候选会堆 profile（id 按时间戳生成）；列表删行成本低，接受
- 搜索结果不缓存跨视图（返回再进重扫）——main 侧 in-flight 去重兜底并发，串行重扫成本 = 一次扫描时长（mDNS 4s 上界），接受

## 7. 测试

- 组件（settings-dialog.test.tsx，22 用例）：
  - 发现视图：双扫描并行启动；先回先列（servers 悬挂时 binaries 已列 + 搜索中提示不消失）；空态文案与手动入口常驻；server/binary 候选点击建档（mode/baseUrl/binaryPath 断言）+ 退回列表；重新搜索双触发 + 重搜期间按钮禁用与搜索中提示回归；焦点落弹窗容器（真 focus 语义，含 manual 返回路径）；新增路径 Esc 三跳分层
  - manual：模式段切换（URL/凭据 ↔ 二进制路径分化 + 说明随动）；attach 字段齐全不触发扫描；浏览填入；编辑既有 profile 直落 manual（跳过 discover）+ 保存 upsert
  - mock 注意：`mockReturnValue` 跨 `mockClear` 存留——悬挂 Promise 用例覆写后须在 `beforeEach` 复位实现（文件头注释）