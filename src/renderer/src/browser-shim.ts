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
    async openBinaryPicker() {
      return null
    },
    async openFilesPicker() {
      return { accepted: [], rejected: [] }
    },
    onManagedEvent() {
      return () => {}
    },
    // 自动扫描要 spawn 子进程/UDP 多播，纯浏览器环境不可用（空候选）
    async scanBinaries() {
      return []
    },
    async scanServers() {
      return []
    },
    async openPathPicker() {
      return null
    },
    async openHtmlFilePicker() {
      return null
    },
    async getAppVersion() {
      return "0.1.0-browser"
    },
    async shellOpenPath() {
      return "系统打开仅 Electron 环境可用"
    },
    async shellOpenWith() {
      return "系统打开仅 Electron 环境可用"
    },
    async shellListOpenWithApps() {
      return []
    },
    async shellOpenWithApp() {
      return "系统打开仅 Electron 环境可用"
    },
    // 浏览器 Tab（design-browser-tab）：纯浏览器环境无 main 进程，view API 不可用。
    // create 失败即可让上层回退（openBrowserTab 捕获后走文件 Tab / 隐藏入口）
    async browserViewCreate() {
      return -1
    },
    browserViewBounds() {},
    browserViewShow() {},
    browserViewHide() {},
    browserViewDispose() {},
    browserViewDisposeAll() {},
    browserNavigate() {},
    browserGoBack() {},
    browserGoForward() {},
    browserReload() {},
    browserStop() {},
    onBrowserViewState() {
      return () => {}
    },
    onBrowserShortcut() {
      return () => {}
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
