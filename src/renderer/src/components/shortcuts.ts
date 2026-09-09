import { useEffect } from "react"
import { useI18n, useStore } from "../app"
import type { MessageKey } from "../i18n"
import { closeTabInteractive } from "./tab-actions"

/**
 * 全局快捷键（design-keyboard-shortcuts §1）：window keydown（bubble）分发；
 * 浏览器视图聚焦时原生 webContents 抢走键盘，经 main 的 before-input-event
 * 转发（onBrowserShortcut，design-browser-tab 评审 M5）走同一分发。
 * IME 组合中（fcitx5 上屏）不触发；已 preventDefault 的事件不重复处理。
 * Ctrl+T/W、Ctrl+Shift+T、Ctrl(+Shift)+Tab（非 mac）、Ctrl+PgUp/PgDn（非 mac）；
 * **Alt 域 = 项目/worktree 管理（2026-09-06 重构，§0/§1.2）**：Alt+O 打开项目
 * 选择器（自 Ctrl+O 迁移，Ctrl+O 放行）、Alt+C 关闭激活 entry、Alt+N 新建
 * worktree、Alt+⌫ 删除当前 worktree（二次确认）；作用域遍历非 mac 绑裸
 * Alt+↑/↓（2026-09-04 修订，原 Ctrl+Alt+↑/↓ 被 GNOME/KDE 合成器抢作工作区
 * 切换，Wayland 下应用收不到；mac 维持 ⌘⌥↑/↓）——**预览-提交模型（§3 修订，
 * 2026-09-06）**：按下修饰键左栏显光标（begin），↑/↓ 只移动光标（move），
 * 松开修饰键才切换（commit）；
 * 面板开关全平台 VS Code 系：Ctrl+B / Ctrl+Alt+B（mac 经 metaKey 等价即 ⌘B / ⌥⌘B）。
 * macOS 切 Tab 仅惯例键 ⌘⌥←/→ 与 ⌘⇧[/]（⌘Tab/⌘⇧Tab 是系统应用切换器到不了应用，
 * Ctrl+Tab/PgUp/PgDn 亦不绑定——用户决策 2026-09-04）。
 */

/** Alt 域键（§1.2）：按 code 匹配（mac ⌥ 系 key 产特殊字符——⌘⌥O 的 key 是
 *  "ø"，KeyB 先例；code 布局无关） */
function isAltFamilyCode(code: string): boolean {
  return code === "KeyO" || code === "KeyC" || code === "KeyN" || code === "Backspace"
}

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
  repeat: boolean,
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
  // Alt 域 = 项目/worktree 管理（§1.2，2026-09-06）：mac ⌘⌥+键（ctrl 经 metaKey
  // 等价亦覆盖 ⌃⌥，同 ⌘⌥↑/↓ 现状）；非 mac 裸左 Alt（!ctrl 排除 AltGr——东欧/
  // 欧陆布局 AltGr+字母上报 ctrl+alt 同按，打字不受劫持，§0.2）。repeat 不触发
  // （按住 Alt+N 连发会连建 worktree，Ctrl+1/2/3 同守卫先例）；overlay 闸门：
  // 弹窗遮挡时仅消费不动作——统一覆盖"picker 已开仅消费"（openProjectPicker
  // 内已开短路仍在，双保险防 overlay 计数失衡），遮罩下不触发作用域变更/破坏性动作
  if (alt && !shift && !repeat && (mac ? ctrl : !ctrl) && isAltFamilyCode(code)) {
    if (store.overlayCount > 0) return true
    if (code === "KeyO") store.openProjectPicker()
    else if (code === "KeyC") store.closeActiveEntry()
    else if (code === "KeyN") void store.createWorkspace()
    else {
      // Alt+⌫：目标 = 当前作用域 worktree（项目根作用域 currentWorkspace=null
      // 无目标；global 的 currentWorkspace 是目录复用，requestWorktreeDelete
      // 内 global 兜底拒绝——双保险）
      const ws = store.currentWorkspace
      if (ws) store.requestWorktreeDelete(ws.directory)
    }
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
  // KeyB——mac ⌥B 的 key 是 "∫"（Option 产特殊字符），key 不可靠。ctrl 守卫
  // （2026-09-06）：入口放行裸 Alt 系后 Alt+B 不得误触右栏开关（§0.1 其余
  // Alt+字母仍页面/输入框自用）。终端 Tab 聚焦时 xterm 抢先消费 Ctrl+B
  //（STX 0x02 归 pty），事件到不了这里——与 Ctrl+T/W 在终端内不生效一致
  if (!shift && ctrl && (code === "KeyB" || key.toLowerCase() === "b")) {
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
  if (key.toLowerCase() === "t") {
    store.showGuidePage()
    return true
  }
  // Ctrl+F：页面内搜索（design-find-in-page §2.4）——激活 Tab 已注册唤起回调
  // 即开查找条/CM 面板；未注册放行（消息流/终端/引导页无页面内搜索语义。
  // 2026-09-09 起代码文件亦注册：CM 已聚焦时事件先被其 keymap 消费到不了
  // 这里，未聚焦时经回调 openSearchPanel 唤起——原「必须先点正文」消除）。
  // overlay 闸门（review 二轮 #5）：弹窗/右键菜单遮挡时仅消费不动作——查找条
  // 会开在弹窗之下且其挂载聚焦会抢走弹窗控件焦点（同 Alt 域四键 §1.2 的闸门
  // 语义）
  if (key.toLowerCase() === "f") {
    const active = store.activeTab
    if (!active) return false
    const requester = store.findRequesterFor(active.key)
    if (!requester) return false
    if (store.overlayCount > 0) return true
    requester()
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
      // 平台按事件读取（同 dispatch 惰性判定）。Alt 域四键同按 Alt 亦触发 begin
      //（光标短暂可见，未移动的 commit 是 no-op——与 §3 已知边界一致，无害瞬态）
      if (traversalModifiersHeld(window.desktop.platform === "darwin", e.key, ctrl, e.altKey)) {
        store.beginScopePreview()
      }
      // 裸 Alt 系进分发（§0.1 修订）：方向键（作用域遍历）+ Alt 域四键（项目/
      // worktree 管理）；其余 Alt+字母仍页面/输入框自用。mac 裸 ⌫/⌥ 系可入分发
      // 但 Alt 域分支要求 ctrl（⌘⌥），未匹配组合照常放行（⌥⌫ 删词等打字不受扰）
      const altCombo =
        e.altKey &&
        !ctrl &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || isAltFamilyCode(e.code))
      if (!ctrl && !altCombo) return
      // 消费才吞（未映射组合放行——Ctrl+S 浏览器保存；Ctrl+W 无激活 Tab 也吞，见 dispatch）
      if (dispatch(store, t, e.key, ctrl, e.shiftKey, e.altKey, e.code, e.repeat))
        e.preventDefault()
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
        dispatch(
          store,
          t,
          input.key,
          ctrl,
          input.shift,
          input.alt,
          input.code ?? "",
          input.isAutoRepeat ?? false,
        )
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
      { keys: "Alt+O", macKeys: "⌘⌥O", action: "scOpenProject" },
      { keys: "Alt+C", macKeys: "⌘⌥C", action: "closeProject" },
      { keys: "Alt+N", macKeys: "⌘⌥N", action: "newWorkspace" },
      { keys: "Alt+⌫", macKeys: "⌘⌥⌫", action: "deleteWorkspace" },
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
      { keys: "Ctrl+F", macKeys: "⌘F", action: "scPageSearch" },
      { keys: "Enter / Shift+Enter", action: "scFindNext" },
      { keys: "Ctrl+Alt+[ / Ctrl+Alt+]", macKeys: "⌃⌥[ / ⌃⌥]", action: "scFoldCode" },
      { keys: "Ctrl+Shift+C", macKeys: "⌘C", action: "scTermCopy" },
      { keys: "Ctrl+Shift+V", macKeys: "⌘V", action: "scTermPaste" },
      { keys: "Esc", action: "scDismiss" },
    ],
  },
]
