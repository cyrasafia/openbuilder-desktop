import { ipcMain, dialog, app } from "electron"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { StoreShape } from "../shared/ipc"
import { startManagedServer, stopManagedServer, killManagedSync } from "./managed-server"

const storePath = join(app.getPath("userData"), "store.json")

async function loadStore(): Promise<Partial<StoreShape>> {
  try {
    return JSON.parse(await readFile(storePath, "utf8"))
  } catch {
    return {}
  }
}

async function saveStore(data: Partial<StoreShape>) {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(data, null, 2), "utf8")
}

export function registerIpc() {
  ipcMain.handle("store:get", async (_e, key: keyof StoreShape) => {
    const store = await loadStore()
    return store[key] ?? null
  })

  ipcMain.handle("store:set", async (_e, key: keyof StoreShape, value: unknown) => {
    const store = await loadStore()
    store[key] = value as never
    await saveStore(store)
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
