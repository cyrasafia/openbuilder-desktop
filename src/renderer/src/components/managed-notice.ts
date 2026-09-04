/**
 * managed 可观察状态文案（design-managed-config §3.2/§4）：结构化 notice →
 * i18n 文案。独立于组件文件（settings-dialog/sidebar 共用；组件文件混出
 * 非组件导出会破坏 React Fast Refresh——vite 实测 hmr invalidate 全链）
 */
import type { ManagedNotice } from "@shared/ipc"

export function managedNoticeText(
  notice: ManagedNotice,
  t: { managedNoticeExit: string; managedNoticeRestart: string; managedNoticeRestartError: string },
): string {
  switch (notice.kind) {
    case "exit":
      return t.managedNoticeExit.replace("{code}", String(notice.code ?? "?"))
    case "restart":
      return t.managedNoticeRestart
        .replace("{attempt}", String(notice.attempt))
        .replace("{delay}", String(Math.round(notice.delayMs / 1000)))
    case "restart-error":
      return t.managedNoticeRestartError
        .replace("{attempt}", String(notice.attempt))
        .replace("{error}", notice.error)
  }
}
