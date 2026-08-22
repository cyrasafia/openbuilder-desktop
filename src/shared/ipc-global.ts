// 全局类型挂载：让 renderer 内 window.desktop 可见（类型来自 shared/ipc）
import type { DesktopApi } from "./ipc"

declare global {
  interface Window {
    desktop: DesktopApi
  }
}

export {}
