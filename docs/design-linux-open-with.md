# Linux「打开方式」自建选择器 — 设计文档

> 对应 spec-v0.3 #8。修订 design-file-panel-context-menu §2.4 原「Linux 不显示该项」决策（GNOME 无系统级打开方式对话框 → 应用内自建选择器替代）。win32/darwin 原路径不变。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder` 无桌面右键/打开方式场景；`openchamber` 的 linux-app-discovery.mjs 为 .desktop 枚举实证参考（Exec 展开策略）。

## 1. 方案

### 1.1 应用枚举（main，`shell:listOpenWithApps(path)`）

1. MIME：`xdg-mime query filetype <path>`（2s 超时；失败/空 → `application/octet-stream` 兜底；**路径级缓存**——同路径重复查询免子进程）。**性能（2026-08-31 修订）**：三路独立前置（MIME 查询/subclasses/主题链）并行；枚举结果按 locale 键控缓存、30s 滚动 TTL（命中同步返回 0ms——同会话反复打开弹窗免全量重算；安装/卸载应用最多 30s 自愈）；真机首枚举 ~200ms → 缓存命中 8ms
2. 枚举 .desktop：`$XDG_DATA_DIRS`（缺省 `/usr/local/share:/usr/share`）∪ `$XDG_DATA_HOME`（`~/.local/share`）下 `applications/**/*.desktop`（含子目录如 `kde4/`；v0.3 不读 `settings.dat`/`mimeinfo.cache` 合并去重语义——直读全量）
3. INI 解析（`[Desktop Entry]`）：取 `Name`（`Name[zh_CN]`/`Name[zh]` 本地化优先；Electron getLocale 的 BCP47 连字符在 handler 归一为下划线）、`Exec`（非空近似 Type=Application 判定）、`NoDisplay`/`Hidden`（true 跳过）、`MimeType` 分号列表。**遮蔽语义**：首个 data dir 的同名 id 即遮蔽后续（含 NoDisplay 条目）。**MIME 命中（2026-08-31 修订：祖先后闭包）**：目标 MIME 的祖先闭包（读 `<data>/mime/subclasses`，跨全部数据目录**合并**——mime-db 文件按 shared-mime-info 规范联合而非遮蔽，WPS 等只写用户目录会遮掉系统基线链）与条目 `MimeType` 求交非空即命中，结果记入 `matches` 标记（`application/octet-stream` 兜底时全量 matches=true）。依据：.desktop 常只声明祖先类型（文本编辑器仅 `text/plain`），而 `application/json` 经子类链 `json→json5→ecmascript→text/javascript→typescript→text/plain` 传递子类于 `text/plain`；字面精确匹配会漏掉这些应用（真机实证：application/json 只出 firefox，遗漏 gedit/TextEditor/micro/vim/sublime——对照 `gio mime application/json` 的注册列表）。语义对齐 gio/libegg 的子类匹配（`xdg_mime_mime_type_subclass` 祖先后闭包）；subclasses 数据全缺时退化为字面匹配；闭包计算环安全。**全量列表（2026-08-31 修订，废止原「仅 MimeType 命中才列出」）**：枚举返回**全部可用应用**（真机 110 个），按「匹配组在前、其余组在后，组内本地化名字母序」排序（排序不变量真机验证）
4. 结果：`{ id（相对 data dir 的 .desktop 相对路径，如 `org.gnome.TextEditor.desktop`）, name, icon（data URL 或 null） }[]`，按 name `localeCompare` 排序。**应用图标（2026-08-31 追加，2026-08-31 全量修订对齐 XDG icon spec）**：`Icon=` 值 → 主题链查找（gsettings 当前主题 → `index.theme` `Inherits=` 解引用（环安全）→ hicolor 恒兜底；context 目录 apps 优先、legacy/actions/devices 等遍历）→ scalable（svg 优先、位图也接）→ 位图档位**升档优先再降档**（48→64→128→256→512→96→…→8，按目标 48 距离排序；用户要求升档优先——大图缩小无损）× context 目录 → 遗留 `/usr/share/pixmaps`（大小写不敏感 + svg）→ 读文件转 base64 data URL。**svg 可渲染性实证**：Electron 43 真机 `<img>` 对 data:/file: 的 svg 均成功光栅化；实测本机 PNG-only 覆盖率仅 ~31%（GNOME 应用图标几乎全在 scalable/*.svg），全量 spec 查找达 ~93%（失败均为 NoDisplay 条目悬空引用/非应用图标）。未找到 = null（首字母瓷片兜底）。真机渲染效果（图标观感/浅深色对比）待下轮 UI 检查

### 1.2 启动（main，`shell:openWithApp(path, appId)`）

- `gio launch <appId 对应 desktop 文件绝对路径> <文件路径>`（detached spawn + 1.5s 观察窗：spawn error/立即非零退出回报 stderr 首行，正常 detach 按成功；`gio launch` 负责 Exec 的 %u/%f 替代与 URL/路径转义——不自解析 Exec）
- appId 白名单校验：必须来自上次枚举结果（main 缓存最近一次枚举的 id→desktop 路径映射；未命中返回错误信息）——防任意 desktop 路径注入
- 失败返回 stderr 首行（渲染层经 connectionError 同类通道？否——右键菜单动作静默约定：返回错误字符串，UI 不弹 toast，与既有 shellOpenPath 一致）
- **子进程环境净化（2026-08-28 修订）**：所有「启动用户会话应用」的 spawn 一律经 `sanitizedChildEnv(process.env)` 剥离 `NODE_` / `ELECTRON_` / `VITE_` 前缀变量（大小写不敏感——Windows env 名不区分大小写）。实证事故：dev 模式（electron-vite 注入 `NODE_ENV=development`）下 spawn 链 gio→MarkText 继承该变量，MarkText 视为自身 dev 模式——**丢弃文件参数**、改用 `marktext-dev` 数据目录起独立实例，且 dev URL 构造失败 + GPU 崩溃循环 → 无响应幽灵窗口（用户报障「右键打开 md 在 MarkText 中开出无法关闭的空窗口」）。真机复现确认后修复。剥离面有意宽于 dev 注入集（开发者 shell 的 NODE_OPTIONS/NODE_EXTRA_CA_CERTS 等也剥离）——外部应用所得环境与文件管理器启动一致，是其正常态
- **「打开」（shell:openPath）Linux/darwin 分支同修**：Electron `shell.openPath` 无法定制子进程 env，Linux 改为自管 `xdgOpen(path)`（观察窗 5s——xdg-open 是脚本，冷缓存枚举 handler 可能慢于 gio launch 的 1.5s 窗）；darwin 改为自管 `open <path>`（与「打开方式」open -b 同机制）；契约不变（""=成功）。win32 保留 `shell.openPath`（ShellExecuteEx；其 env 继承的同类泄漏为**已知残余风险**——`cmd /c start` 的引号/元字符注入面更不可取，且主开发环境 Linux 无法实测），win32/darwin 的「打开方式」自有 spawn（rundll32 / open -b）同样净化

### 1.3 UI（渲染层）

- 右键菜单「打开方式…」：Linux 恢复显示（win32/darwin 走原系统对话框 IPC 不变）。**2026-08-31 修订**：目录行/空白处根目录同样显示（原「目录仍不显示」废止）——`xdg-mime query filetype` 对目录返回 `inode/directory`（真机验证），枚举按 MimeType 命中文件管理器类应用，枚举/启动链路零改动
- 点击 → `shell:listOpenWithApps` → **应用内选择器弹窗**（骨架/尺寸/内边距/关闭按钮对齐 **DESIGN.md §标准弹窗** 列表档（700×560 固定、`dialog-title-row` 关闭钮、`dialog-search` 搜索框下边距 14）；顶部**搜索框**（名称大小写不敏感子串过滤；打开即聚焦；Esc 有内容先清空再关闭）+ 分段列表（匹配组标题「推荐应用」在前、其余「其他应用」在后，组次序由 main 排定、过滤后保持）+ 列表行 = 应用图标（`icon` data URL，`<img class="open-with-icon">` 铺瓷片；null 时回退文本首字母瓷片，同 ProjectAvatar 模式）+ 名称（仅本地化名；**2026-08-31 修订：不再展示 id 包名**（`xx.desktop` 技术细节对用户无意义，id 仍作 key/启动白名单凭据）；键盘 ↑↓/Enter 在过滤后列表内循环、点击行启动并关闭；目录与文件同一弹窗）
- 加载中/空态/搜索无结果文案（枚举空 = openWithEmpty；搜索无结果 = openWithNoResult）

## 2. 不做的事

- ~~图标真渲染~~（**2026-08-31 修订：已实现**，见 §1.1 步骤 4——Icon 解析 + hicolor 查找 + data URL；首字母瓷片保留为未找到时的兜底）
- ~~仅显示推荐应用（mimeinfo.cache 排序）~~（**2026-08-31 修订：已实现等价能力**——matches 分组排序对齐 gio 的推荐/注册语义，但不读 mimeinfo.cache 排序数据，以 MimeType∩祖先闭包为准）
- "设为默认"入口
- Flatpak/Snap 沙箱应用特殊处理（其 .desktop 由桌面环境安装进 data dirs，天然覆盖）
- macOS/Windows 自建选择器（沿用系统机制，spec 明确）
- 记住上次选择（每次全列表）

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/ipc.ts` | `OpenWithApp` 类型；`shellListOpenWithApps(path)` / `shellOpenWithApp(path, appId)` |
| `src/preload/index.ts` / `src/renderer/src/browser-shim.ts` | 暴露/不可用桩 |
| `src/main/ipc.ts` | 两个 handler（xdg-mime 子进程、desktop 枚举与解析、gio launch + 白名单）；`shell:openPath` Linux/darwin 分支改走自管 spawn（§1.2 修订） |
| `src/main/linux-open-with.ts` | 枚举/解析（含 subclasses 祖先闭包，§1.1 2026-08-31 修订）+ `sanitizedChildEnv` 净化 + `spawnSessionApp` 共用启动封装（gio launch / xdg-open） |
| `src/renderer/src/components/open-with-dialog.tsx` | 新：选择器弹窗 |
| `src/renderer/src/components/file-panel.tsx` | 菜单项 Linux 可见 + 打开弹窗 |
| `src/renderer/src/i18n/index.ts` | openWithEmpty/openWithLoading（标题复用 fileOpenWith） |
| 测试 | main：desktop 解析纯函数（fixture 字符串：MimeType 命中/NoDisplay/本地化名）+ subclasses 闭包（链式解引用/环/空表退化/diamond）+ sanitizedChildEnv（前缀剥离/会话变量保留）；组件：弹窗渲染与选择回调 |

## 4. 验收（对齐 spec #8）

- Linux 右键 .json 文件 →「打开方式…」**全量应用**分段列出（匹配组：支持 application/json 及其祖先类型的应用如文本编辑器/VS Code 在前；其他应用在后；均可选），选择后对应应用打开该文件（2026-08-31 修订：真机 110 应用、matches 组 7 个与 `gio mime` 注册列表一致）
- 目录行/空白处（作用域根目录）→ 同弹窗全量列表（`inode/directory` 命中文件管理器，匹配组在前）（2026-08-31 修订）；纯浏览器 shim 不显示；win32/darwin 行为不变（含目录）
- 搜索框：输入即过滤（大小写不敏感），键盘可达（↑↓/Enter/Esc），无结果有占位文案
- `npm run test` / `typecheck` / `build` 全绿；真机 gio launch 实测一次
