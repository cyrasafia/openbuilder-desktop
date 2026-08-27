import { ipcMain, shell, WebContentsView, type BrowserWindow } from "electron"

/**
 * 浏览器 Tab 的 WebContentsView 注册表与 IPC（design-browser-tab §1.1）。
 * 原生视图恒在 renderer DOM 之上——显隐由 renderer 驱动（overlay 防挡/Tab 切换），
 * bounds 同步由 BrowserTabView 的 ResizeObserver 推送。
 */

interface StateAgg {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

let nextViewId = 1
const views = new Map<number, { view: WebContentsView; agg: StateAgg }>()
let mainWindow: BrowserWindow | null = null

export function bindMainWindowForBrowserViews(win: BrowserWindow) {
  mainWindow = win
  win.on("closed", () => {
    disposeAllBrowserViews()
    mainWindow = null
  })
}

function pushState(viewId: number) {
  const entry = views.get(viewId)
  if (!entry || !mainWindow) return
  mainWindow.webContents.send("browser:view-state", { viewId, ...entry.agg })
}

/** 远端页面（http/https）禁跳 file://（design-browser-tab §1.1 导航安全） */
function isRemoteUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

export function registerBrowserViewIpc() {
  ipcMain.handle("browser:view-create", () => {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const viewId = nextViewId++
    const agg: StateAgg = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
    views.set(viewId, { view, agg })

    const wc = view.webContents
    // 导航安全：远端（含 about:blank——继承远端 origin 的跳板，纵深防御）→
    // file:// 拦截（本地页面互链放行）；外链 window.open 走系统浏览器
    wc.on("will-navigate", (e, url) => {
      const current = wc.getURL()
      if ((isRemoteUrl(current) || current === "about:blank") && url.startsWith("file://")) e.preventDefault()
    })
    // 页面聚焦后快捷键转发（design-browser-tab 评审 M5）：原生 webContents 抢走
    // 键盘焦点，renderer 的 window keydown 收不到——Ctrl 系快捷键经主窗口转发，
    // shortcuts hook 订阅后走同一分发（非 Ctrl 组合不转发，页面自行消费）
    wc.on("before-input-event", (_e, input) => {
      if (input.type !== "keyDown" || !(input.control || input.meta)) return
      mainWindow?.webContents.send("browser:shortcut", {
        key: input.key,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
      })
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (isRemoteUrl(url)) void shell.openExternal(url)
      return { action: "deny" }
    })
    const update = (patch: Partial<StateAgg>) => {
      Object.assign(agg, patch)
      pushState(viewId)
    }
    wc.on("did-navigate", (_e, url) => update({ url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }))
    wc.on("did-navigate-in-page", (_e, url) =>
      update({ url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }),
    )
    wc.on("page-title-updated", (_e, title) => update({ title }))
    wc.on("did-start-loading", () => update({ loading: true }))
    wc.on("did-stop-loading", () =>
      update({ loading: false, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }),
    )

    if (mainWindow) {
      mainWindow.contentView.addChildView(view)
      // 初始隐藏：显隐由 renderer 协调（z-order 对策）
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
    return viewId
  })

  ipcMain.on("browser:view-bounds", (_e, viewId: number, rect: { x: number; y: number; width: number; height: number }) => {
    views.get(viewId)?.view.setBounds(rect)
  })
  ipcMain.on("browser:view-show", (_e, viewId: number) => {
    views.get(viewId)?.view.setVisible(true)
  })
  ipcMain.on("browser:view-hide", (_e, viewId: number) => {
    views.get(viewId)?.view.setVisible(false)
  })
  ipcMain.on("browser:view-dispose", (_e, viewId: number) => {
    disposeBrowserView(viewId)
  })
  ipcMain.on("browser:navigate", (_e, viewId: number, url: string) => {
    const wc = views.get(viewId)?.view.webContents
    if (wc && typeof url === "string" && url.length > 0) void wc.loadURL(url)
  })
  ipcMain.on("browser:goBack", (_e, viewId: number) => {
    const wc = views.get(viewId)?.view.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })
  ipcMain.on("browser:goForward", (_e, viewId: number) => {
    const wc = views.get(viewId)?.view.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  })
  ipcMain.on("browser:reload", (_e, viewId: number) => {
    views.get(viewId)?.view.webContents.reload()
  })
  ipcMain.on("browser:stop", (_e, viewId: number) => {
    views.get(viewId)?.view.webContents.stop()
  })
}

function disposeBrowserView(viewId: number) {
  const entry = views.get(viewId)
  if (!entry) return
  views.delete(viewId)
  if (mainWindow) mainWindow.contentView.removeChildView(entry.view)
  // Electron 43 无 webContents.destroy()——close() 即销毁（BrowserView 语境非
  // window.close 语义；beforeunload 否决是窗口 close 行为，不适用于从父视图移除后的强制清理）
  entry.view.webContents.close()
}

export function disposeAllBrowserViews() {
  for (const id of [...views.keys()]) disposeBrowserView(id)
}
