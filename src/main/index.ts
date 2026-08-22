import { app, BrowserWindow, shell } from "electron"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { registerIpc } from "./ipc"

const __dirname = dirname(fileURLToPath(import.meta.url))

// GNOME/Wayland: Ozone + fcitx5 IME（见 AGENTS.md 环境事实）
app.commandLine.appendSwitch("ozone-platform-hint", "auto")
app.commandLine.appendSwitch("enable-wayland-ime")

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"

let mainWindow: BrowserWindow | null = null

function preloadPath(): string {
  // ESM preload 固定输出 .mjs（见 electron.vite.config.ts）
  return join(__dirname, "../preload/index.mjs")
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "openbuilder desktop",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.on("ready-to-show", () => win.show())

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
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
