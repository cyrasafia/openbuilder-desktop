import { contextBridge, ipcRenderer } from "electron"
import type { DesktopPlatform, StoreShape } from "../shared/ipc"

const api = {
  // 沙箱 preload 的受限 process 对象含 platform；渲染层据此决定是否画自定义头部
  platform: process.platform as DesktopPlatform,
  storeGet: <K extends keyof StoreShape>(key: K) => ipcRenderer.invoke("store:get", key),
  storeSet: <K extends keyof StoreShape>(key: K, value: StoreShape[K]) =>
    ipcRenderer.invoke("store:set", key, value),
  managedStart: (opts?: { binaryPath?: string }) => ipcRenderer.invoke("managed:start", opts ?? {}),
  managedStop: () => ipcRenderer.invoke("managed:stop"),
  openBinaryPicker: () => ipcRenderer.invoke("dialog:openBinaryFile") as Promise<string | null>,
  openFilesPicker: () =>
    ipcRenderer.invoke("dialog:openFiles") as Promise<{
      accepted: Array<{ name: string; type: string | null; bytes: Uint8Array }>
      rejected: Array<{ name: string; reason: string }>
    }>,
  scanBinaries: () => ipcRenderer.invoke("scan:binaries"),
  scanServers: () => ipcRenderer.invoke("scan:servers"),
  onManagedEvent: (cb: (payload: string) => void) => {
    const listener = (_e: unknown, payload: string) => cb(payload)
    ipcRenderer.on("managed:event", listener)
    return () => ipcRenderer.removeListener("managed:event", listener)
  },
  openPathPicker: () => ipcRenderer.invoke("dialog:openPath"),
  openHtmlFilePicker: () => ipcRenderer.invoke("dialog:openHtmlFile") as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  shellOpenPath: (path: string) => ipcRenderer.invoke("shell:openPath", path) as Promise<string>,
  shellOpenWith: (path: string) => ipcRenderer.invoke("shell:openWith", path) as Promise<string>,
  shellListOpenWithApps: (path: string) =>
    ipcRenderer.invoke("shell:listOpenWithApps", path) as Promise<
      { id: string; name: string; icon: string | null; matches: boolean; lastUsed?: boolean }[]
    >,
  shellOpenWithApp: (path: string, appId: string) =>
    ipcRenderer.invoke("shell:openWithApp", path, appId) as Promise<string>,
  browserViewCreate: () => ipcRenderer.invoke("browser:view-create") as Promise<number>,
  browserViewBounds: (viewId: number, rect: unknown) => ipcRenderer.send("browser:view-bounds", viewId, rect),
  browserViewShow: (viewId: number) => ipcRenderer.send("browser:view-show", viewId),
  browserViewHide: (viewId: number) => ipcRenderer.send("browser:view-hide", viewId),
  browserViewDispose: (viewId: number) => ipcRenderer.send("browser:view-dispose", viewId),
  browserViewDisposeAll: () => ipcRenderer.send("browser:dispose-all"),
  browserNavigate: (viewId: number, url: string) => ipcRenderer.send("browser:navigate", viewId, url),
  browserGoBack: (viewId: number) => ipcRenderer.send("browser:goBack", viewId),
  browserGoForward: (viewId: number) => ipcRenderer.send("browser:goForward", viewId),
  browserReload: (viewId: number) => ipcRenderer.send("browser:reload", viewId),
  browserStop: (viewId: number) => ipcRenderer.send("browser:stop", viewId),
  onBrowserViewState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state)
    ipcRenderer.on("browser:view-state", listener)
    return () => ipcRenderer.removeListener("browser:view-state", listener)
  },
  onBrowserShortcut: (cb: (input: unknown) => void) => {
    const listener = (_e: unknown, input: unknown) => cb(input)
    ipcRenderer.on("browser:shortcut", listener)
    return () => ipcRenderer.removeListener("browser:shortcut", listener)
  },
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
