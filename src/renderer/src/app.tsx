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
import { StatusBar } from "./components/status-bar"

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
    const unsub = store.subscribe(() => force((n) => n + 1))
    store.mountReconciler()
    void store.init().finally(() => setReady(true))
    const onFocus = () => store.kickReconnect()
    window.addEventListener("focus", onFocus)
    return () => {
      unsub()
      window.removeEventListener("focus", onFocus)
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
  return (
    <div className="app-shell">
      <Sidebar />
      <Workspace />
      <FilePanel />
      <StatusBar />
    </div>
  )
}

