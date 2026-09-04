# 欢迎屏（首次启动引导）设计

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #1。从安装应用到第一次对话的完整闭环入口。依赖已合并的功能 #3（扫描）、#2（managed spawn/版本）、#4（Provider 检查）。

## 1. 触发与生命周期

- **触发 = 启动时 `activeProfileId` 为空**（首次安装或删光 profile 后均触发；"连过一次即不再出现"由 profile 落盘天然满足）。跳过不持久化"已看过"标志——重启后无 profile 仍会出现（spec 语义）
- `store.welcomeOpen: boolean`，doInit 尾部置 `!activeProfileId`；`closeWelcome()`（稍后配置/检查完成）/`openWelcome()`（引导页入口）显式控制；**连接成功不自动关**——provider/默认模型检查须在 WelcomeScreen 挂载时进行（§5），检查完成（含失败静默路径）后由其自行 `closeWelcome()`
- 渲染：`ready && welcomeOpen` 时 `WelcomeScreen` 替代 `Shell`（App.tsx 分支）；**TitleBar 照常渲染**（Linux frameless 下拖拽区/窗口控制不可缺）——欢迎屏 = 标题栏 + 居中卡片容器，非三栏
- 连接失败走现有 `connectionError` 展示（欢迎屏卡片内错误行 + 重试），不弹独立错误弹窗

## 2. 入口选择（choose 视图）

一屏完成（spec：不做轮播多步介绍）：应用标识 + 两个大入口卡：

- **managed（推荐标注）**：本机启动 opencode server → managed 分支
- **attach**：连接已有 server → attach 分支
- 底部「稍后配置」文字按钮 → `closeWelcome()` 进主界面（未连接态）

## 3. managed 分支

- 进入自动跑 `scanBinaries()`（+手动「重新扫描」）；**找到**：显示推荐候选（路径 + 版本 mono）+「启动并连接」主按钮；多候选可展开选择（默认首项）
- **未找到**：安装指引（文案 + 平台命令：linux/macOS `curl -fsSL https://opencode.ai/install | bash`、brew、npm 三行，逐行复制按钮——范围外：不自动安装）+「重新扫描」+「改用 attach」
- 「启动并连接」：建 managed profile（`binaryPath` = 选中候选路径，name "本机 opencode"）→ `saveProfiles(next, id)` → `connect()`（内部：spawn + 版本探测 + 健康带凭据 + 快照，见 design-managed-config）；期间按钮 loading（connectionState connecting）；失败显示 connectionError
- managed profile 每次重连同 id upsert（重试不堆 profile）

## 4. attach 分支

- 进入自动跑 `scanServers()`（loopback + mDNS，见 design-auto-scan）；候选行（URL + 版本 + 来源徽标）点击即填入 URL 表单
- 表单：URL + username/password（可选）；「连接」：`RestClient.health()` 探测 → 通过则建 attach profile → save → connect；失败错误显示在卡片内
- 返回入口选择

## 5. 连接成功后的 provider 检查（引导视图）

- 触发：`connectionState === "streaming" && welcomeOpen` 时执行一次（effect 守卫防重入）
- 检查内容（数据源 `GET /provider`（listProviderCatalog）的 `connected` 集——与 spec 写的 `/config/providers` 等价信息且形状更净：两者都只反映已配置 auth 的 provider；connected 空 ⇔ 无任何已配置 key。directory 用 server cwd instance（无参）——尚未开项目无作用域可查，全局 auth 判空足够）：
  1. `connected.length === 0` → **provider 引导视图**：说明文案 + 「配置 Provider」（`openSettings("providers")`）+「跳过」
  2. 有 key 但 `model.defaults[profileKey].model` 未设 → **默认模型引导**：文案 + 「设置默认模型」（`openSettings("defaults")`）+「跳过」
  3. 均正常 → 直接关闭欢迎屏进主界面
- 引导视图非阻塞：用户可 Esc/「跳过」/点遮罩外跳过（closeWelcome）——设置弹窗在欢迎屏之上正常打开
- provider/默认模型配置完不自动判定（用户手动跳过或设置后关闭弹窗回欢迎屏再跳过/连接）——保持一屏简单，不做向导状态机
- **spec 语义对齐**：「稍后配置」跳过向导 + 引导页保留入口；provider 引导「可跳过」

## 6. 中栏引导页入口（跳过后）

- GuideView 顶部（`!store.getActiveClient()` 时）：「连接服务器」按钮 → `openWelcome()`（回欢迎屏）；旁边「打开设置」次级入口（既有 sidebar 齿轮仍在）

## 7. 实现落点

| 文件 | 内容 |
|---|---|
| `src/renderer/src/components/welcome-screen.tsx` | WelcomeScreen（choose/managed/attach/guidance 四视图内部状态机；扫描/表单/连接动作） |
| `src/renderer/src/store/app-store.ts` | `welcomeOpen` + `openWelcome/closeWelcome`；doInit 初始化；doConnect 成功尾段自动关；`openSettings(tab?)` 初始页签提示字段 |
| `src/renderer/src/app.tsx` | ready 后分支渲染 WelcomeScreen / Shell |
| `src/renderer/src/components/workspace.tsx` | GuideView 未连接时的「连接服务器」入口 |
| `src/renderer/src/components/settings-dialog.tsx` | `openSettings(tab)` 消费（useState 初始值） |
| i18n / app.css | 文案与卡片样式（token 复用，无新色） |

## 8. 测试

- 组件（mock store/desktop，注入扫描与连接动作）：
  - 无 profile：choose 视图；managed/attach 分支切换
  - managed：候选渲染（路径+版本）、启动并连接调用链（saveProfiles+connect with binaryPath）、无候选安装指引与复制
  - attach：候选一键填入、health 测试通过建档/失败展示
  - provider 引导：connected 空 → 引导视图；跳过 → closeWelcome；有 key 无默认模型 → 默认模型引导
  - 稍后配置 → closeWelcome
- store：doInit 无 profile 置 welcomeOpen、connect 成功关闭（现有 app-store.test 模式追加）

## 9. 已知取舍

- provider 检查用 server cwd instance 的 auth 集（未开项目无作用域）；config 文件级 provider（随项目 directory 变化）的精确作用域检查留待实际需要
- 引导视图不自动感知配置完成（避免向导状态机）；用户跳过即进主界面，设置内可再来
- 欢迎屏期间 managed 崩溃重启等事件照常（状态行不可见但 connect 串行化兜底；日志在设置内可见）

## 10. E2E 实测记录（2026-09-05，GNOME/Wayland + 本机 opencode 1.18.20，CDP 驱动）

- 全链路通过：全新数据目录启动 → 欢迎屏出现 → managed 分支扫描（1 候选）→ 启动并连接 → streaming → 引导视图（本机全局 auth.json 已有 key → **默认模型引导**；全新环境为 provider 引导）→「去设置默认模型」直达设置对应页签 → 跳过 → 主界面 shell 渲染；全程零页面错误
- 有 profile 启动不出现欢迎屏（多轮重启实测）
- **E2E 环境事实（重要）**：
  - opencode 的 auth.json 在 **XDG_DATA_HOME（全局）**而非 XDG_CONFIG_HOME——XDG_CONFIG_HOME 隔离不出"无 key"环境，provider 引导分支在本机只能经默认模型引导路径验证（组件测试覆盖 providers 分支）
  - **app.tsx emit 合帧的 rAF 在无人值守/被遮挡窗口会被饿死且不定时恢复**（连 `disable-features=CalculateNativeWinOcclusion` 都不保证）——scheduled 卡死 true 后一切 emit 短路、UI 永久停旧态（对真实用户：不可见窗口本就无需渲染，恢复可见即追平；但欢迎屏的 provider 检查依赖 effect 重渲染，故仍受影响）。**修复：flush 加 250ms setTimeout 安全网**（rAF 主路不变、flush 双清；不可见窗口最坏 ~1s 延迟，可见窗口无感）——这是对 3535091 emit 合帧的补丁而非推翻
  - 欢迎模式下设置弹窗需要宿主：App 欢迎分支渲染 `<SettingsDialog/>`（原本只挂在 Workspace 内）
