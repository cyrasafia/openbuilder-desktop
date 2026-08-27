import type { Catalog } from "../i18n"
import type { TabEntity } from "../store/app-store"
import type { AppStore } from "../store/app-store"

/**
 * 用户主动关闭 Tab 的统一路径（design-keyboard-shortcuts §4）：
 * Tab 栏关闭按钮与 Ctrl+W 共用。chat Tab 流式中先确认（abort + 归档语义，
 * design-layout 锁定）；关闭成功入关闭栈（Ctrl+Shift+T 可恢复）。
 */
export function closeTabInteractive(store: AppStore, tab: TabEntity, t: Catalog): void {
  if (tab.kind === "chat") {
    const streaming = store.isSessionActive(tab.key.slice(5))
    if (streaming && !confirm(t.confirmCloseStreamingTab)) return
    void store.closeChatTab(tab.key.slice(5), { streaming })
  } else if (tab.kind === "terminal") {
    // 关终端 Tab = 杀 pty（design-terminal-tab §1.1）：运行中先确认
    const ptyID = tab.key.slice("terminal:".length)
    const running = !store.ptyRuntimeFor(ptyID)?.exited
    if (running && !confirm(t.confirmCloseTerminal)) return
    void store.closeTerminalTab(ptyID)
  } else {
    store.closeTab(tab.key, { pushClosed: true })
  }
}
