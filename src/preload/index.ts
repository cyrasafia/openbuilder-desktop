import { contextBridge, ipcRenderer } from "electron"
import type { DesktopPlatform, StoreShape } from "../shared/ipc"

const api = {
  // 沙箱 preload 的受限 process 对象含 platform；渲染层据此决定是否画自定义头部
  platform: process.platform as DesktopPlatform,
  storeGet: <K extends keyof StoreShape>(key: K) => ipcRenderer.invoke("store:get", key),
  storeSet: <K extends keyof StoreShape>(key: K, value: StoreShape[K]) =>
    ipcRenderer.invoke("store:set", key, value),
  managedStart: () => ipcRenderer.invoke("managed:start"),
  managedStop: () => ipcRenderer.invoke("managed:stop"),
  onManagedEvent: (cb: (payload: string) => void) => {
    const listener = (_e: unknown, payload: string) => cb(payload)
    ipcRenderer.on("managed:event", listener)
    return () => ipcRenderer.removeListener("managed:event", listener)
  },
  openPathPicker: () => ipcRenderer.invoke("dialog:openPath"),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  shellOpenPath: (path: string) => ipcRenderer.invoke("shell:openPath", path) as Promise<string>,
  shellOpenWith: (path: string) => ipcRenderer.invoke("shell:openWith", path) as Promise<string>,
  winMinimize: () => ipcRenderer.send("win:minimize"),
  winToggleMaximize: () => ipcRenderer.send("win:toggleMaximize"),
  winClose: () => ipcRenderer.send("win:close"),
  winIsMaximized: () => ipcRenderer.invoke("win:isMaximized") as Promise<boolean>,
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("win:maximized", listener)
    return () => ipcRenderer.removeListener("win:maximized", listener)
  },
}

contextBridge.exposeInMainWorld("desktop", api)
