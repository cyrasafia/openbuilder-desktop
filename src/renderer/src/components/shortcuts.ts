import { useEffect } from "react"
import { useI18n, useStore } from "../app"
import type { MessageKey } from "../i18n"
import { closeTabInteractive } from "./tab-actions"

/**
 * 全局快捷键（design-keyboard-shortcuts §1）：window keydown（bubble）分发；
 * 浏览器视图聚焦时原生 webContents 抢走键盘，经 main 的 before-input-event
 * 转发（onBrowserShortcut，design-browser-tab 评审 M5）走同一分发。
 * IME 组合中（fcitx5 上屏）不触发；已 preventDefault 的事件不重复处理。
 * Ctrl+O/T/W、Ctrl+Shift+T、Ctrl(+Shift)+Tab（非 mac）、Ctrl+PgUp/PgDn（非 mac）；
 * 作用域遍历非 mac 绑裸 Alt+↑/↓（2026-09-04 修订，原 Ctrl+Alt+↑/↓ 被 GNOME/KDE
 * 合成器抢作工作区切换，Wayland 下应用收不到；mac 维持 ⌘⌥↑/↓）——
 * **预览-提交模型（§3 修订，2026-09-06）**：按下修饰键左栏显光标（begin），
 * ↑/↓ 只移动光标（move），松开修饰键才切换（commit）；
 * 面板开关全平台 VS Code 系：Ctrl+B / Ctrl+Alt+B（mac 经 metaKey 等价即 ⌘B / ⌥⌘B）。
 * macOS 切 Tab 仅惯例键 ⌘⌥←/→ 与 ⌘⇧[/]（⌘Tab/⌘⇧Tab 是系统应用切换器到不了应用，
 * Ctrl+Tab/PgUp/PgDn 亦不绑定——用户决策 2026-09-04）。
 */

/** 键盘事件统一分发（window keydown 与 browser:shortcut 转发共用）；
 *  返回是否消费（未消费不 preventDefault；Ctrl+W 无激活 Tab 例外仍吞——
 *  放行会命中 Electron 默认菜单 role:close 加速键，把窗口整个关掉） */
function dispatch(
  store: ReturnType<typeof useStore>,
  t: ReturnType<typeof useI18n>["t"],
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  code: string,
): boolean {
  const mac = window.desktop.platform === "darwin"
  // 作用域遍历（design-keyboard-shortcuts §3，2026-09-04 修订）：非 mac 绑裸
  // Alt+↑/↓——原 Ctrl+Alt+↑/↓ 是 GNOME/KDE 合成器的工作区切换（Wayland 下应用
  // 收不到，实测 gsettings switch-to-workspace-up/down），Ctrl+Alt+Shift+↑/↓ 亦被
  // GNOME move-to-workspace 占用；mac 维持 ⌘⌥↑/↓——裸 ⌥↑/↓ 是 NSText 段落
  // 首/尾移动惯例，绑定会劫持聊天输入框的打字。§3 修订（2026-09-06）：只移动
  // 预览光标不切换，切换在松开修饰键时提交（commitScopePreview）
  if (alt && !shift && (key === "ArrowDown" || key === "ArrowUp") && (mac ? ctrl : !ctrl)) {
    store.moveScopePreview(key === "ArrowDown" ? 1 : -1)
    return true
  }
  // macOS 专属切 Tab 键（浏览器惯例，2026-09-03 修订，design-keyboard-shortcuts
  // §1）：⌘⌥←/→ 与 ⌘⇧[/]。⌘⇧[ 按 code 匹配——US 布局 shift+[ 的 key 是 "{"，
  // code 布局无关。linux 不绑这两组：Ctrl+Alt+←/→ 是 GNOME/KDE 工作区切换，
  // Ctrl+Shift+[/] 维持放行语义
  if (mac && ctrl && alt && (key === "ArrowLeft" || key === "ArrowRight")) {
    store.cycleTab(key === "ArrowRight" ? 1 : -1)
    return true
  }
  if (mac && ctrl && shift && !alt && (code === "BracketLeft" || code === "BracketRight")) {
    store.cycleTab(code === "BracketRight" ? 1 : -1)
    return true
  }
  // Ctrl+Tab 系仅非 mac 绑定（mac 切 Tab 只有上面的惯例键，用户决策 2026-09-04）
  if (!mac && !alt && key === "Tab") {
    store.cycleTab(shift ? -1 : 1)
    return true
  }
  if (!mac && !alt && (key === "PageDown" || key === "PageUp")) {
    // Shift 反转方向（与 Ctrl+Shift+Tab 一致）
    const base = key === "PageDown" ? 1 : -1
    store.cycleTab(shift ? (-base as 1 | -1) : (base as 1 | -1))
    return true
  }
  // Ctrl+B / Ctrl+Alt+B：左/右栏收起/展开（翻转，与标题栏开关同路径 toggle；
  // VS Code 系全平台统一，2026-09-04 修订替换原 Ctrl+[/]）。按 code 匹配
  // KeyB——mac ⌥B 的 key 是 "∫"（Option 产特殊字符），key 不可靠。终端 Tab
  // 聚焦时 xterm 抢先消费 Ctrl+B（STX 0x02 归 pty），事件到不了这里——与
  // Ctrl+T/W 在终端内不生效一致
  if (!shift && (code === "KeyB" || key.toLowerCase() === "b")) {
    if (alt) store.toggleRightPanel()
    else store.toggleLeftPanel()
    return true
  }
  if (alt || shift) {
    // Ctrl+Shift+T：恢复刚关闭的 Tab
    if (shift && !alt && key.toLowerCase() === "t") {
      store.restoreClosedTab()
      return true
    }
    return false
  }
  if (key.toLowerCase() === "o") {
    store.openProjectPicker()
    return true
  }
  if (key.toLowerCase() === "t") {
    store.showGuidePage()
    return true
  }
  if (key.toLowerCase() === "w") {
    const active = store.activeTab
    // 无激活 Tab 也吞（禁用而非放行）：Electron 默认菜单的 close 加速键会关窗口
    if (!active) return true
    closeTabInteractive(store, active, t)
    return true
  }
  return false
}
/** Alt 预览进入判定（§3 修订，window keydown 与浏览器转发共用）：非 mac =
 *  裸 Alt 按下（无 Ctrl/⌘——Ctrl+Alt+B 等组合不显光标）；mac = ⌘⌥ 弦凑齐
 *  （后到的修饰键 keydown 时另一修饰已在位，用户按压顺序不定） */
function traversalModifiersHeld(mac: boolean, key: string, ctrl: boolean, alt: boolean): boolean {
  if (mac) return alt && ctrl && (key === "Alt" || key === "Meta" || key === "Control")
  return key === "Alt" && !ctrl && alt
}

/** Alt 预览提交键（§3 修订）：非 mac = Alt 松开；mac = ⌘⌥ 弦任一修饰松开 */
function isTraversalModifierKey(mac: boolean, key: string): boolean {
  return key === "Alt" || (mac && (key === "Meta" || key === "Control"))
}

export function useShortcuts() {
  const store = useStore()
  const { t } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      // Cmd 视同 Ctrl（macOS 开发态惯例；Linux 主环境无影响）
      const ctrl = e.ctrlKey || e.metaKey
      // 按下 Alt（mac ⌘⌥ 弦）→ 光标落当前行（已在预览中 = no-op）；
      // 平台按事件读取（同 dispatch 惰性判定）
      if (traversalModifiersHeld(window.desktop.platform === "darwin", e.key, ctrl, e.altKey)) {
        store.beginScopePreview()
      }
      // 裸 Alt+↑/↓（非 mac 作用域遍历）无 Ctrl 也进分发
      const altArrow = e.altKey && !ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown")
      if (!ctrl && !altArrow) return
      // 消费才吞（未映射组合放行——Ctrl+S 浏览器保存；Ctrl+W 无激活 Tab 也吞，见 dispatch）
      if (dispatch(store, t, e.key, ctrl, e.shiftKey, e.altKey, e.code)) e.preventDefault()
    }
    // 松开 Alt（mac ⌘ 或 ⌥ 任一）→ 提交切换（未预览/未移动 = no-op）
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTraversalModifierKey(window.desktop.platform === "darwin", e.key)) store.commitScopePreview()
    }
    // 窗口失焦作废预览：Alt+Tab/⌘Tab 被合成器抢走后 keyup 不再来，不清高亮残留
    //（同 workspace-guide Ctrl 角标的 blur 清理先例）
    const onBlur = () => store.cancelScopePreview()
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [store, t])
  // 浏览器视图内快捷键转发（main → renderer；无 preventDefault 语义——页面
  // 原按键已发生，转发仅驱动应用侧动作）；keyDown 载荷附带 begin，keyUp 载荷
  // （仅修饰键，browser-views 过滤）驱动 commit；顶层窗口失焦（视图持焦时
  // renderer 的 window 已 blur 态、应用失活无 DOM blur）补发 cancel
  useEffect(() => {
    const unsubs = [
      window.desktop.onBrowserShortcut?.((input) => {
        if (!input || typeof input.key !== "string") return
        if (input.up) {
          if (isTraversalModifierKey(window.desktop.platform === "darwin", input.key)) {
            store.commitScopePreview()
          }
          return
        }
        const ctrl = input.control || input.meta
        if (traversalModifiersHeld(window.desktop.platform === "darwin", input.key, ctrl, input.alt)) {
          store.beginScopePreview()
        }
        dispatch(store, t, input.key, ctrl, input.shift, input.alt, input.code ?? "")
      }),
      window.desktop.onBrowserWindowBlur?.(() => store.cancelScopePreview()),
    ]
    return () => {
      for (const u of unsubs) u?.()
    }
  }, [store, t])
}

// ============ 设置页快捷键列表（§8） ============

/** 单行：keys = 默认（非 mac）键位、macKeys = mac 键位（缺省回退 keys）；
 *  only 标记平台专属行（mac 切 Tab 惯例键 / 非 mac Ctrl+Tab 系互斥展示），
 *  only:"mac" 行不渲染非 mac 侧，keys 直接放 mac 键位即可 */
export interface ShortcutRow {
  keys: string
  macKeys?: string
  action: MessageKey
  only?: "mac" | "non-mac"
}

export interface ShortcutGroup {
  title: MessageKey
  rows: ShortcutRow[]
}

/** 快捷键清单（设置页展示，§1 表的渲染数据）：与 dispatch 同文件维护防漂移；
 *  另收各视图内局部键（聊天输入 Enter 系、code-view 搜索、终端复制/粘贴、
 *  Esc 关闭——全局分发之外用户可感知的键） */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "scGroupGlobal",
    rows: [
      { keys: "Ctrl+T", macKeys: "⌘T", action: "newTab" },
      { keys: "Ctrl+O", macKeys: "⌘O", action: "scOpenProject" },
      { keys: "Ctrl+W", macKeys: "⌘W", action: "scCloseTab" },
      { keys: "Ctrl+Shift+T", macKeys: "⌘⇧T", action: "scRestoreTab" },
      { keys: "Ctrl+Tab / Ctrl+PageDown", action: "scNextTab", only: "non-mac" },
      { keys: "Ctrl+Shift+Tab / Ctrl+PageUp", action: "scPrevTab", only: "non-mac" },
      { keys: "⌘⌥→ / ⌘⇧]", action: "scNextTab", only: "mac" },
      { keys: "⌘⌥← / ⌘⇧[", action: "scPrevTab", only: "mac" },
      { keys: "Alt+↓ / Alt+↑", macKeys: "⌘⌥↓ / ⌘⌥↑", action: "scCycleScope" },
      { keys: "Ctrl+B", macKeys: "⌘B", action: "scToggleLeft" },
      { keys: "Ctrl+Alt+B", macKeys: "⌥⌘B", action: "scToggleRight" },
    ],
  },
  {
    title: "scGroupInput",
    rows: [
      { keys: "Enter", action: "scSend" },
      { keys: "Shift+Enter", action: "scNewline" },
      { keys: "Ctrl+F", macKeys: "⌘F", action: "scFileSearch" },
      { keys: "Ctrl+Shift+C", macKeys: "⌘C", action: "scTermCopy" },
      { keys: "Ctrl+Shift+V", macKeys: "⌘V", action: "scTermPaste" },
      { keys: "Esc", action: "scDismiss" },
    ],
  },
]
