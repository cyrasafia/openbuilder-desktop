/**
 * 纯浏览器环境（无 Electron preload，如 vite dev 下远程访问 5173）的 desktop API shim。
 * localStorage 持久化，语义与 main 进程 JSON store 一致；managed 模式不可用。
 * 有 preload 时不覆盖。
 */
import type { DesktopApi, StoreShape } from "@shared/ipc"

const PREFIX = "ob-desktop-shim:"

function createBrowserDesktopApi(): DesktopApi {
  return {
    platform: "browser",
    async storeGet(key) {
      const raw = localStorage.getItem(PREFIX + key)
      return raw ? (JSON.parse(raw) as StoreShape[typeof key]) : null
    },
    async storeSet(key, value) {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    },
    async managedStart() {
      return { ok: false, error: "managed 模式仅在 Electron 内可用" }
    },
    async managedStop() {},
    onManagedEvent() {
      return () => {}
    },
    async openPathPicker() {
      return null
    },
    async getAppVersion() {
      return "0.1.0-browser"
    },
    winMinimize() {},
    winToggleMaximize() {},
    winClose() {},
    async winIsMaximized() {
      return false
    },
    onWindowMaximized() {
      return () => {}
    },
  }
}

export function ensureDesktopApi() {
  if (!("desktop" in window) || !window.desktop) {
    ;(window as { desktop?: DesktopApi }).desktop = createBrowserDesktopApi()
  }
}
