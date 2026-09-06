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
    // closed 触发时原生窗口已销毁：先置 null 使 disposeBrowserView 跳过
    // removeChildView（对已销毁窗口访问 contentView 抛 "Object has been destroyed"）
    mainWindow = null
    disposeAllBrowserViews()
  })
  // 顶层窗口失焦转发（design-keyboard-shortcuts §3 修订）：浏览器视图持焦时
  // renderer 的 window 已是 blur 态——应用失活（Alt+Tab/⌘Tab 被合成器抢走）
  // 不再有 DOM blur 事件，作废 Alt 预览的 cancel 信号由 main 补发。注意不能用
  // 视图自身 webContents 的 blur——焦点回到宿主 UI（点侧栏）时也触发，那条
  // 路径宿主 keyup 监听正常接管，cancel 会误杀按住中的预览
  win.on("blur", () => {
    mainWindow?.webContents.send("browser:window-blur")
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
        // PDF 顶层导航的 PDFium 查看器（设计备选路线验证用）
        plugins: true,
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
    // shortcuts hook 订阅后走同一分发（非 Ctrl 组合不转发，页面自行消费；例外
    // 裸 Alt+↑/↓ 与裸 Alt 修饰键——非 mac 作用域遍历预览-提交，2026-09-06，
    // 见 design-keyboard-shortcuts §3 修订：keyDown 附带 begin、keyUp（仅修饰键）
    // 驱动 commit，载荷 up 标记区分；及裸 Alt 域四键 O/C/N/⌫——项目/worktree
    // 管理，§0.2——转发+消费会覆盖 Linux 页面 accesskey（Alt+字母），罕见使用，
    // 接受并记录）
    wc.on("before-input-event", (_e, input) => {
      const altKey = input.key === "Alt" || input.code === "AltLeft" || input.code === "AltRight"
      const altArrow = input.alt && (input.key === "ArrowUp" || input.key === "ArrowDown")
      const altFamily =
        input.alt &&
        (input.code === "KeyO" ||
          input.code === "KeyC" ||
          input.code === "KeyN" ||
          input.code === "Backspace")
      let forward: boolean
      if (input.type === "keyUp") {
        forward = altKey || input.key === "Meta" || input.key === "Control"
      } else {
        forward = input.type === "keyDown" && (input.control || input.meta || altArrow || altKey || altFamily)
      }
      if (!forward) return
      mainWindow?.webContents.send("browser:shortcut", {
        key: input.key,
        code: input.code,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
        up: input.type === "keyUp",
        isAutoRepeat: input.isAutoRepeat,
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
  // renderer 重载后的孤儿视图清理（design-tab-session-restore §4）：注册表键在
  // renderer 内存，重载即失联——doInit 起步全量 dispose
  ipcMain.on("browser:dispose-all", () => {
    disposeAllBrowserViews()
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
  // window.close 语义；beforeunload 否决是窗口 close 行为，不适用于从父视图移除后的强制清理）。
  // 窗口销毁时子视图树随之销毁，close() 前须防已销毁对象
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
}

export function disposeAllBrowserViews() {
  for (const id of [...views.keys()]) disposeBrowserView(id)
}
