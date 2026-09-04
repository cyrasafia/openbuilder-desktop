import { ipcMain, dialog, app, shell, type BrowserWindow } from "electron"
import { execFile, spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { StoreShape } from "../shared/ipc"
import { startManagedServer, stopManagedServer, killManagedSync } from "./managed-server"
import { scanBinaries, scanServers } from "./scan"
import {
  listOpenWithApps,
  mimeOf,
  openWithApp,
  sanitizedChildEnv,
  spawnSessionApp,
  xdgOpen,
} from "./linux-open-with"

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

  // 自动扫描（design-auto-scan §4）：单次收束 + in-flight 去重（StrictMode 双触发
  // 不重复 spawn 一串 --version 子进程/开两条 mDNS 浏览）
  let binariesInFlight: Promise<unknown> | null = null
  ipcMain.handle("scan:binaries", () => {
    if (!binariesInFlight) {
      binariesInFlight = scanBinaries().finally(() => {
        binariesInFlight = null
      })
    }
    return binariesInFlight
  })
  let serversInFlight: Promise<unknown> | null = null
  ipcMain.handle("scan:servers", () => {
    if (!serversInFlight) {
      serversInFlight = scanServers().finally(() => {
        serversInFlight = null
      })
    }
    return serversInFlight
  })

  ipcMain.handle("dialog:openPath", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle("app:getVersion", () => app.getVersion())

  // 浏览器 Tab「打开本地文件」（design-browser-tab §1.3）：HTML 文件选择器
  ipcMain.handle("dialog:openHtmlFile", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 文件栏右键菜单动作（design-file-panel-context-menu）：路径来自本客户端信任域
  // （server 文件列表/作用域目录），错误信息回传渲染层（""=成功）。
  // Linux/darwin 走自管 spawn（净化 env）：shell.openPath 无法定制子进程环境，
  // dev 模式 NODE_ENV 泄漏会破坏外部应用（见 linux-open-with.ts 实证注释）；
  // darwin `open` 与「打开方式」的 open -b 同机制。win32 保留 shell.openPath
  // （ShellExecuteEx；其 env 继承的同类泄漏为已知残余风险——`cmd /c start`
  // 的引号/元字符注入面更不可取，且主开发环境为 Linux 无法实测验证）
  ipcMain.handle("shell:openPath", (_e, path: string): Promise<string> => {
    if (typeof path !== "string" || path.length === 0) return Promise.resolve("invalid path")
    if (process.platform === "linux") return xdgOpen(path)
    // 观察窗同 xdgOpen 的 5s（LaunchServices 首调/慢盘可能超默认 1.5s）
    if (process.platform === "darwin") return spawnSessionApp("open", [path], 5000)
    return shell.openPath(path)
  })

  ipcMain.handle("shell:openWith", (_e, path: string): string | Promise<string> => {
    if (typeof path !== "string" || path.length === 0) return "invalid path"
    if (process.platform === "win32") {
      // Windows 原生「打开方式」对话框。ENOENT 等经异步 error 事件投递，
      // 无监听会升级为未捕获异常崩溃主进程——吞掉（动作 fire-and-forget）
      try {
        spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", path], {
          detached: true,
          stdio: "ignore",
          env: sanitizedChildEnv(process.env),
        })
          .on("error", () => {})
          .unref()
        return ""
      } catch {
        return "spawn failed"
      }
    }
    if (process.platform === "darwin") {
      // macOS 无系统对话框：系统应用选择器取 bundle id 后 open -b；取消选择 = 静默无操作
      return new Promise((resolve) => {
        execFile(
          "osascript",
          ["-e", "set chosenApp to choose application", "-e", "return id of chosenApp"],
          (err, stdout) => {
            const bundleId = stdout?.trim() ?? ""
            if (err || !bundleId) return resolve("")
            try {
              spawn("open", ["-b", bundleId, path], {
                detached: true,
                stdio: "ignore",
                env: sanitizedChildEnv(process.env),
              })
                .on("error", () => {})
                .unref()
              resolve("")
            } catch {
              resolve("spawn failed")
            }
          },
        )
      })
    }
    // linux：渲染层不提供入口，防御分支
    return "unsupported platform"
  })

  // Linux「打开方式」自建选择器（design-linux-open-with）：枚举 + 白名单启动
  ipcMain.handle("shell:listOpenWithApps", async (_e, path: string) => {
    if (process.platform !== "linux" || typeof path !== "string" || !path) return []
    // app.getLocale() 是 BCP47 连字符（zh-CN）；desktop 本地化键是下划线（zh_CN）
    const locale = (app.getLocale() || "en").replace("-", "_")
    // 上次使用记忆（§1.4）：先查 MIME（列表与启动同一来源），再查记忆表
    const mime = await mimeOf(path)
    const lastUsed = (await loadStore())["openWith.lastUsed"]?.[mime]
    return listOpenWithApps(path, locale, lastUsed)
  })
  ipcMain.handle("shell:openWithApp", async (_e, path: string, appId: string): Promise<string> => {
    if (process.platform !== "linux") return Promise.resolve("unsupported platform")
    if (typeof path !== "string" || !path || typeof appId !== "string") {
      return Promise.resolve("invalid path")
    }
    const result = await openWithApp(path, appId)
    // 启动成功才记忆（失败下次仍无「上次使用」段）；MIME 与列表枚举同源缓存
    if (result === "") {
      const mime = await mimeOf(path)
      if (mime) {
        const store = await loadStore()
        store["openWith.lastUsed"] = { ...store["openWith.lastUsed"], [mime]: appId }
        await persistStore()
      }
    }
    return result
  })

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
