# Linux「打开方式」自建选择器 — 设计文档

> 对应 spec-v0.3 #8。修订 design-file-panel-context-menu §2.4 原「Linux 不显示该项」决策（GNOME 无系统级打开方式对话框 → 应用内自建选择器替代）。win32/darwin 原路径不变。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder` 无桌面右键/打开方式场景；`openchamber` 的 linux-app-discovery.mjs 为 .desktop 枚举实证参考（Exec 展开策略）。

## 1. 方案

### 1.1 应用枚举（main，`shell:listOpenWithApps(path)`）

1. MIME：`xdg-mime query filetype <path>`（2s 超时；失败/空 → `application/octet-stream` 兜底）
2. 枚举 .desktop：`$XDG_DATA_DIRS`（缺省 `/usr/local/share:/usr/share`）∪ `$XDG_DATA_HOME`（`~/.local/share`）下 `applications/**/*.desktop`（含子目录如 `kde4/`；v0.3 不读 `settings.dat`/`mimeinfo.cache` 合并去重语义——直读全量）
3. INI 解析（`[Desktop Entry]`）：取 `Name`（`Name[zh_CN]`/`Name[zh]` 本地化优先；Electron getLocale 的 BCP47 连字符在 handler 归一为下划线）、`Exec`（非空近似 Type=Application 判定）、`NoDisplay`/`Hidden`（true 跳过）、`MimeType` 分号列表包含目标 MIME（`application/octet-stream` 兜底时不过滤 MimeType——全量列出）。**遮蔽语义**：首个 data dir 的同名 id 即遮蔽后续（含 NoDisplay 条目）
4. 结果：`{ id（相对 data dir 的 .desktop 相对路径，如 `org.gnome.TextEditor.desktop`）, name }[]`，按 name `localeCompare` 排序（无 icon 字段，见 §2）

### 1.2 启动（main，`shell:openWithApp(path, appId)`）

- `gio launch <appId 对应 desktop 文件绝对路径> <文件路径>`（detached spawn + 1.5s 观察窗：spawn error/立即非零退出回报 stderr 首行，正常 detach 按成功；`gio launch` 负责 Exec 的 %u/%f 替代与 URL/路径转义——不自解析 Exec）
- appId 白名单校验：必须来自上次枚举结果（main 缓存最近一次枚举的 id→desktop 路径映射；未命中返回错误信息）——防任意 desktop 路径注入
- 失败返回 stderr 首行（渲染层经 connectionError 同类通道？否——右键菜单动作静默约定：返回错误字符串，UI 不弹 toast，与既有 shellOpenPath 一致）

### 1.3 UI（渲染层）

- 右键菜单「打开方式…」：Linux 恢复显示（win32/darwin 走原系统对话框 IPC 不变；目录行仍不显示）
- 点击 → `shell:listOpenWithApps` → **应用内选择器弹窗**（复用 `.dialog-mask`/`.dialog` 模式：列表行 = 图标占位（v0.3 文本首字母瓷片，同 ProjectAvatar 模式）+ 名称；键盘 ↑↓ + Enter、Esc 关闭、点击行启动并关闭）
- 加载中/空态（无匹配应用）文案

## 2. 不做的事

- 图标真渲染（Icon 键解析 / icon theme 查找——首字母瓷片占位）
- "设为默认"入口、仅显示推荐应用（mimeinfo.cache 排序）——全量字母序
- Flatpak/Snap 沙箱应用特殊处理（其 .desktop 由桌面环境安装进 data dirs，天然覆盖）
- macOS/Windows 自建选择器（沿用系统机制，spec 明确）
- 记住上次选择（每次全列表）

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/ipc.ts` | `OpenWithApp` 类型；`shellListOpenWithApps(path)` / `shellOpenWithApp(path, appId)` |
| `src/preload/index.ts` / `src/renderer/src/browser-shim.ts` | 暴露/不可用桩 |
| `src/main/ipc.ts` | 两个 handler（xdg-mime 子进程、desktop 枚举与解析、gio launch + 白名单） |
| `src/renderer/src/components/open-with-dialog.tsx` | 新：选择器弹窗 |
| `src/renderer/src/components/file-panel.tsx` | 菜单项 Linux 可见 + 打开弹窗 |
| `src/renderer/src/i18n/index.ts` | openWithEmpty/openWithLoading（标题复用 fileOpenWith） |
| 测试 | main：desktop 解析纯函数（fixture 字符串：MimeType 命中/NoDisplay/本地化名）；组件：弹窗渲染与选择回调 |

## 4. 验收（对齐 spec #8）

- Linux 右键 .json 文件 →「打开方式…」列出支持 application/json 的应用（如文本编辑器/VS Code），选择后对应应用打开该文件
- 目录行/纯浏览器 shim 不显示；win32/darwin 行为不变
- `npm run test` / `typecheck` / `build` 全绿；真机 gio launch 实测一次
