import { contextBridge, ipcRenderer } from "electron"
import type { StoreShape } from "../shared/ipc"

const api = {
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
}

contextBridge.exposeInMainWorld("desktop", api)
