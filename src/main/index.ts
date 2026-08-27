import { app, BrowserWindow, session, shell } from "electron"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { registerIpc, bindMainWindow } from "./ipc"
import { bindMainWindowForBrowserViews, registerBrowserViewIpc } from "./browser-views"

const __dirname = dirname(fileURLToPath(import.meta.url))

// GNOME/Wayland: Ozone + fcitx5 IME（见 AGENTS.md 环境事实）
app.commandLine.appendSwitch("ozone-platform-hint", "auto")
app.commandLine.appendSwitch("enable-wayland-ime")

if (process.env.NODE_ENV === "development") {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"
}

let mainWindow: BrowserWindow | null = null

function preloadPath(): string {
  // CJS preload（sandbox:true 需要；见 electron.vite.config.ts）
  return join(__dirname, "../preload/index.cjs")
}

// 窗口/任务栏图标：打包后来自 extraResources（electron-builder.config.ts），
// 开发态直接用仓库内 build/icons/512.png（gen-icons.sh 生成）
function windowIconPath(): string | undefined {
  const p = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build/icons/512.png")
  return existsSync(p) ? p : undefined
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 680,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: "OpenBuilder",
    icon: windowIconPath(),
    // Linux 用自定义头部（renderer title-bar.tsx：拖拽区 + 窗口控制，颜色随主题）；
    // GNOME/Wayland 下 CSD 由应用自绘；其他平台保留系统装饰
    frame: process.platform !== "linux",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  bindMainWindow(win)
  bindMainWindowForBrowserViews(win)

  win.on("ready-to-show", () => win.show())

  // 外链走系统浏览器（仅 http/https）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  // 窗口内禁止导航到任意地址（保持应用 origin）
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault()
  })

  // 子帧（html 预览的 sandboxed iframe）禁止一切导航：will-navigate 只覆盖主帧，
  // meta refresh / 链接点击可导航 iframe 自身——新文档不携带注入的 CSP，
  // 主动外发请求即绕过预览安全模型（design-html-preview §2）。srcdoc 初始
  // 建档不走 renderer-initiated 的 WillStartRequest 路径，不触发本事件、无误伤
  win.webContents.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame) details.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"))
  }

  return win
}

app.whenReady().then(() => {
  registerIpc()
  registerBrowserViewIpc()

  // pty WS 握手去 Origin（design-terminal-tab §1.2 实测）：server 对 connect 路径
  // 校验 Origin allowlist（localhost/127.0.0.1/官方 scheme），浏览器 WS 必发
  // Origin——打包形态 renderer 是 file://，dev 是 localhost:5173。删头后 server
  // 视同无 Origin 放行（实测 101）；dev 的 localhost Origin 本就在 allowlist 内，
  // 删除无副作用。锚定 /pty/ 路径（host 随用户配置不可枚举）——未来引入第三方
  // WS 不受影响。版本前提：webRequest 拦截 WS 握手需较新 Electron（旧版不拦，
  // electron#20710），本仓库 ^43 实测有效
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://*/pty/*", "wss://*/pty/*"] },
    (details, callback) => {
      delete details.requestHeaders.Origin
      callback({ requestHeaders: details.requestHeaders })
    },
  )
  mainWindow = createMainWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
