import { ipcMain, dialog, app, type BrowserWindow } from "electron"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { StoreShape } from "../shared/ipc"
import { startManagedServer, stopManagedServer, killManagedSync } from "./managed-server"

const storePath = join(app.getPath("userData"), "store.json")

// 内存缓存 + 串行写队列：防并发 storeSet 的读改写竞态（后写覆盖前写丢 key）
let storeCache: Partial<StoreShape> | null = null
let writeChain: Promise<unknown> = Promise.resolve()

async function loadStore(): Promise<Partial<StoreShape>> {
  if (storeCache) return storeCache
  try {
    storeCache = JSON.parse(await readFile(storePath, "utf8")) as Partial<StoreShape>
  } catch {
    storeCache = {}
  }
  return storeCache
}

function persistStore(): Promise<void> {
  const data = storeCache ?? {}
  const task = writeChain.then(() =>
    mkdir(dirname(storePath), { recursive: true }).then(() =>
      writeFile(storePath, JSON.stringify(data, null, 2), "utf8"),
    ),
  )
  // 失败不阻断后续写
  writeChain = task.catch(() => {})
  return task
}

let mainWindow: BrowserWindow | null = null

/** 绑定主窗口（createMainWindow 时调用；重建窗口后重新绑定） */
export function bindMainWindow(win: BrowserWindow) {
  mainWindow = win
  // 最大化/还原状态推送（Linux 自定义头部按钮图标切换）
  win.on("maximize", () => win.webContents.send("win:maximized", true))
  win.on("unmaximize", () => win.webContents.send("win:maximized", false))
}

export function registerIpc() {
  ipcMain.handle("store:get", async (_e, key: keyof StoreShape) => {
    const store = await loadStore()
    return store[key] ?? null
  })

  ipcMain.handle("store:set", async (_e, key: keyof StoreShape, value: unknown) => {
    const store = await loadStore()
    store[key] = value as never
    await persistStore()
  })

  ipcMain.handle("managed:start", () => startManagedServer())
  ipcMain.handle("managed:stop", () => stopManagedServer())

  ipcMain.handle("dialog:openPath", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle("app:getVersion", () => app.getVersion())

  // Linux 自定义头部窗口控制（renderer title-bar.tsx）
  ipcMain.on("win:minimize", () => mainWindow?.minimize())
  ipcMain.on("win:toggleMaximize", () => {
    const win = mainWindow
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on("win:close", () => mainWindow?.close())
  ipcMain.handle("win:isMaximized", () => mainWindow?.isMaximized() ?? false)

  app.on("will-quit", () => {
    killManagedSync()
  })
}
