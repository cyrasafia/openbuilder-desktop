/**
 * Ctrl/⌘+W 吞键判定（纯函数供单测；调用方 browser-views.ts）。
 * 浏览器/PDF 视图（WebContentsView）持焦时，before-input-event 的快捷键转发
 * 只驱动应用侧关 Tab 动作、不消费按键——renderer 未消费的键回流 Chromium
 * HandleKeyboardEvent，命中 Electron 默认菜单 Window>Close 的
 * CommandOrControl+W 加速键，把整个窗口关掉（实测 Electron 43 Linux，
 * autoHideMenuBar 不摘除默认菜单；主窗口 renderer 聚焦时由 shortcuts.ts
 * window keydown 的 preventDefault 拦截，视图持焦时该路径不可达）。故视图侧
 * 在 before-input-event 里对命中组合 preventDefault 切断加速键路径，转发照旧。
 * 按 code KeyW 匹配（布局无关，shortcuts KeyB 先例）+ key 字面双保险：非拉丁
 * 布局 key 非 "w"（renderer dispatch 不识别、不关 Tab）时加速键仍按物理键位
 * 触发，必须吞。Shift/Alt 组合不吞——Ctrl+Shift+W / Ctrl+Alt+W 非应用映射，
 * 默认菜单亦无对应加速键；isAutoRepeat 不拦（与主窗口 window keydown 路径
 * 一致——dispatch 对 W 无 repeat 守卫）。
 */
export interface TabCloseInput {
  type: string
  key: string
  code?: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

export function isTabCloseShortcut(input: TabCloseInput): boolean {
  if (input.type !== "keyDown" || input.shift || input.alt) return false
  if (!(input.control || input.meta)) return false
  return input.code === "KeyW" || input.key === "w" || input.key === "W"
}
