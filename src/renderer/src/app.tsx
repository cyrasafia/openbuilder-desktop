import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { AppStore } from "./store/app-store"
import { getCatalog, type Catalog, type Locale } from "./i18n"
import { Sidebar } from "./components/sidebar"
import { Workspace } from "./components/workspace"
import { FilePanel } from "./components/file-panel"
import { TitleBar } from "./components/title-bar"
import { useShortcuts } from "./components/shortcuts"

const StoreContext = createContext<AppStore | null>(null)

export function useStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error("StoreContext missing")
  return store
}

const I18nContext = createContext<{ t: Catalog; locale: Locale } | null>(null)

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("I18nContext missing")
  return ctx
}

export function App() {
  const [store] = useState(() => new AppStore())
  const [ready, setReady] = useState(false)
  const [, force] = useState(0)

  // 联调调试钩子（生产无害）
  useEffect(() => {
    ;(window as unknown as { __store?: AppStore }).__store = store
  }, [store])

  useEffect(() => {
    // emit 合帧（2026-09-04）：一次作用域切换的同步段/快照落地/二段恢复各发
    // emit，逐次全树渲染是切换卡顿主源（实测每按键 ~5 次）——订阅侧 rAF 批处
    // 理，一帧内任意次 emit 只渲染一次。store 保持同步通知（测试与顺序语义不
    // 变）；jsdom 无 rAF 时退化为 setTimeout(0)
    let scheduled = false
    let handle: number | null = null
    const flush = () => {
      scheduled = false
      handle = null
      force((n) => n + 1)
    }
    const unsub = store.subscribe(() => {
      if (scheduled) return
      scheduled = true
      if (typeof requestAnimationFrame === "function") handle = requestAnimationFrame(flush)
      else handle = setTimeout(flush, 0)
    })
    store.mountReconciler()
    void store.init().finally(() => setReady(true))
    const onFocus = () => {
      store.kickReconnect()
      // worktree 删除检测（design-worktree-sync §2）：删除无 SSE 事件，窗口 focus 时
      // 刷新 listProjects() diff 补偿他端删除（切回应用即见最新态）
      void store.syncWorktrees()
    }
    window.addEventListener("focus", onFocus)
    return () => {
      unsub()
      window.removeEventListener("focus", onFocus)
      // 卸载后不再触发渲染（React 18+ 对卸载后 setState 已是 no-op，此处取消
      // 只为整洁）
      if (handle != null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle)
        else clearTimeout(handle)
      }
    }
  }, [store])

  const locale: Locale = useMemo(() => {
    if (store.localeMode !== "auto") return store.localeMode
    return navigator.language.startsWith("zh") ? "zh" : "en"
  }, [store.localeMode])

  // 主题跟随
  useEffect(() => {
    const apply = () => {
      const mode =
        store.themeMode === "auto"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : store.themeMode
      document.documentElement.dataset.theme = mode
    }
    apply()
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [store.themeMode])

  const i18nValue = useMemo(() => ({ t: getCatalog(locale), locale }), [locale])

  if (!ready) {
    return <div className="boot">…</div>
  }

  return (
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={i18nValue}>
        <Shell />
      </I18nContext.Provider>
    </StoreContext.Provider>
  )
}

function Shell() {
  const store = useStore()
  // 全局快捷键（design-keyboard-shortcuts）：注册于 provider 内，store/t 就绪
  useShortcuts()
  // 三栏栅格（design-layout-collapse §2.3）：折叠列宽 0；展开列用 store 记忆宽度。
  // 内联覆盖 app.css 的默认 grid-template-columns（CSS 变量无第二写入点，单一来源）
  const left = store.layoutLeftCollapsed ? "0px" : `${store.layoutLeftWidth}px`
  const right = store.layoutRightCollapsed ? "0px" : `${store.layoutRightWidth}px`
  return (
    <div className="app-root">
      {/* 标题栏全平台渲染（面板开关载体）；窗口控制在其内部按平台门控 */}
      <TitleBar />
      <div
        className="app-shell"
        style={{ gridTemplateColumns: `${left} minmax(0, 1fr) ${right}` }}
      >
        <Sidebar />
        <Workspace />
        <FilePanel />
      </div>
    </div>
  )
}

