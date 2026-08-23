import { app, BrowserWindow, shell } from "electron"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { registerIpc } from "./ipc"

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

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 680,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: "openbuilder desktop",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

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
  mainWindow = createMainWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
