import { ipcMain, dialog, app } from "electron"
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

  app.on("will-quit", () => {
    killManagedSync()
  })
}
