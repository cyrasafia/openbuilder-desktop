/**
 * 欢迎屏（design-welcome-screen）：启动无激活 profile 时的居中卡片向导。
 * 入口二选一（managed 推荐 / attach）→ 连接成功后 provider/默认模型引导（可跳过）。
 * 替代 Shell 渲染（TitleBar 由 App 层保留）。
 */
import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Copy, RefreshCw } from "lucide-react"
import { useI18n, useStore } from "../app"
import type { BinaryCandidate, ConnectionProfile, ServerCandidate } from "@shared/ipc"
import { ApiError, RestClient } from "@shared/rest-client"

type View = "choose" | "managed" | "attach" | "guidance"

/** 安装指引命令（design-welcome-screen §3；范围外：不自动安装） */
const INSTALL_COMMANDS = [
  { label: "linux / macOS", cmd: "curl -fsSL https://opencode.ai/install | bash" },
  { label: "brew", cmd: "brew install anomalyco/tap/opencode" },
  { label: "npm", cmd: "npm install -g opencode-ai" },
]

export function WelcomeScreen() {
  const store = useStore()
  const { t } = useI18n()
  const [view, setView] = useState<View>("choose")
  // provider 引导内容（design-welcome-screen §5）
  const [guidance, setGuidance] = useState<"providers" | "model-default" | null>(null)
  const guidanceChecked = useRef(false)

  // 连接成功后的 provider 检查（一次；失败静默跳过——不阻断进入主界面）。
  // 检查完成后才关闭欢迎屏（store.connect 不代劳——本组件须挂载着做检查，
  // design-welcome-screen §5）
  useEffect(() => {
    if (store.connectionState !== "streaming" || guidanceChecked.current) return
    guidanceChecked.current = true
    const client = store.getActiveClient()
    if (!client) {
      store.closeWelcome()
      return
    }
    void client
      .listProviderCatalog("/")
      .then((cat) => {
        if (cat.connected.length === 0) {
          setGuidance("providers")
          setView("guidance")
        } else if (!store.defaultsFor().model) {
          setGuidance("model-default")
          setView("guidance")
        } else {
          store.closeWelcome()
        }
      })
      .catch(() => {
        /* 检查失败不阻断 */
        store.closeWelcome()
      })
  }, [store.connectionState, store])

  return (
    <div className="welcome-wrap">
      <div className="welcome-card">
        {view === "choose" && <ChooseView onManaged={() => setView("managed")} onAttach={() => setView("attach")} />}
        {view === "managed" && <ManagedBranch onBack={() => setView("choose")} />}
        {view === "attach" && <AttachBranch onBack={() => setView("choose")} />}
        {view === "guidance" && (
          <GuidanceView
            kind={guidance ?? "providers"}
            onBack={() => {
              store.closeWelcome()
            }}
          />
        )}
      </div>
    </div>
  )
}

function ChooseView({ onManaged, onAttach }: { onManaged: () => void; onAttach: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  return (
    <>
      <div className="welcome-title">{t.welcomeTitle}</div>
      <div className="welcome-sub">{t.welcomeSubtitle}</div>
      <div className="welcome-entries">
        <button className="welcome-entry" onClick={onManaged}>
          <span className="welcome-entry-name">{t.welcomeManaged}</span>
          <span className="welcome-entry-badge">{t.welcomeRecommended}</span>
          <span className="welcome-entry-desc">{t.welcomeManagedDesc}</span>
        </button>
        <button className="welcome-entry" onClick={onAttach}>
          <span className="welcome-entry-name">{t.welcomeAttach}</span>
          <span className="welcome-entry-desc">{t.welcomeAttachDesc}</span>
        </button>
      </div>
      <button className="welcome-later" onClick={() => store.closeWelcome()}>
        {t.welcomeLater}
      </button>
    </>
  )
}

/** 建 profile + 激活 + 连接（managed/attach 共用；connect 内部含 spawn/健康/快照） */
async function connectWithProfile(
  store: ReturnType<typeof useStore>,
  profile: ConnectionProfile,
): Promise<void> {
  const idx = store.profiles.findIndex((p) => p.id === profile.id)
  const next =
    idx >= 0 ? store.profiles.map((p, i) => (i === idx ? profile : p)) : [...store.profiles, profile]
  await store.saveProfiles(next, profile.id)
  await store.connect()
}

function ManagedBranch({ onBack }: { onBack: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  const [candidates, setCandidates] = useState<BinaryCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const connecting = store.connectionState === "connecting"

  const runScan = async () => {
    setScanning(true)
    try {
      const list = await window.desktop.scanBinaries()
      setCandidates(list)
      // 默认选首候选（有版本者优先——扫描已按发现序，PATH 序即推荐序）
      setSelected((prev) => prev ?? list.find((c) => c.version)?.path ?? list[0]?.path ?? null)
    } catch {
      setCandidates([])
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    if (candidates === null && !scanning) void runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    if (!selected) return
    await connectWithProfile(store, {
      id: "welcome-managed",
      name: t.welcomeManagedProfileName,
      baseUrl: "",
      mode: "managed",
      ...(selected ? { binaryPath: selected } : {}),
    })
  }

  const found = (candidates?.length ?? 0) > 0
  const shown = showAll ? candidates : candidates?.slice(0, 3)

  return (
    <>
      <WelcomeHeader title={t.welcomeManagedTitle} onBack={onBack} />
      <div className="welcome-body">
        {candidates === null || scanning ? (
          <div className="form-note">{t.scanRescanning}</div>
        ) : found ? (
          <>
            <div className="scan-section-title">
              <span>{t.scanCandidatesTitle}</span>
              <button type="button" disabled={scanning} onClick={() => void runScan()}>
                <RefreshCw size={12} aria-hidden />
                {t.scanRescan}
              </button>
            </div>
            {(shown ?? []).map((c) => (
              <button
                key={c.path}
                type="button"
                className={"scan-candidate" + (selected === c.path ? " selected" : "")}
                title={c.path}
                onClick={() => setSelected(c.path)}
              >
                <span className="mono scan-candidate-path">{c.path}</span>
                <span className="tree-meta mono">{c.version ?? "—"}</span>
              </button>
            ))}
            {(candidates?.length ?? 0) > 3 && (
              <button type="button" className="welcome-link" onClick={() => setShowAll(!showAll)}>
                {showAll ? t.welcomeShowLess : t.welcomeShowMore.replace("{count}", String(candidates!.length))}
              </button>
            )}
            <button className="btn-primary welcome-action" disabled={connecting} onClick={() => void start()}>
              {connecting ? t.welcomeConnecting : t.welcomeStartAndConnect}
            </button>
          </>
        ) : (
          <>
            <div className="form-note">{t.welcomeInstallHint}</div>
            {INSTALL_COMMANDS.map((c) => (
              <div key={c.cmd} className="install-cmd">
                <span className="install-cmd-label">{c.label}</span>
                <code className="mono install-cmd-text">{c.cmd}</code>
                <button
                  type="button"
                  className="icon-btn"
                  title={t.copy}
                  aria-label={t.copy}
                  onClick={() => {
                    void navigator.clipboard?.writeText(c.cmd)?.then(() => {
                      setCopied(c.cmd)
                      window.setTimeout(() => setCopied(null), 1500)
                    })
                  }}
                >
                  {copied === c.cmd ? <span className="welcome-copied">✓</span> : <Copy size={12} aria-hidden />}
                </button>
              </div>
            ))}
            <div className="welcome-row">
              <button type="button" disabled={scanning} onClick={() => void runScan()}>
                {t.scanRescan}
              </button>
              <button type="button" className="welcome-link" onClick={onBack}>
                {t.welcomeUseAttach}
              </button>
            </div>
          </>
        )}
        {store.connectionError && <div className="form-note">{store.connectionError}</div>}
      </div>
    </>
  )
}

function AttachBranch({ onBack }: { onBack: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  const [candidates, setCandidates] = useState<ServerCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [url, setUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const connecting = store.connectionState === "connecting"

  const runScan = async () => {
    setScanning(true)
    try {
      setCandidates(await window.desktop.scanServers())
    } catch {
      setCandidates([])
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    if (candidates === null && !scanning) void runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    setTesting(true)
    setError(null)
    try {
      const client = new RestClient({ baseUrl: url, username: username || undefined, password: password || undefined })
      await client.health()
    } catch (e) {
      setError(e instanceof ApiError ? `${t.testFailed} (${e.message})` : e instanceof Error ? e.message : String(e))
      setTesting(false)
      return
    }
    await connectWithProfile(store, {
      id: "welcome-attach",
      name: url,
      baseUrl: url,
      mode: "attach",
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    })
    setTesting(false)
  }

  return (
    <>
      <WelcomeHeader title={t.welcomeAttachTitle} onBack={onBack} />
      <div className="welcome-body">
        <div className="scan-section-title">
          <span>{t.welcomeDiscoveredServers}</span>
          <button type="button" disabled={scanning} onClick={() => void runScan()}>
            <RefreshCw size={12} aria-hidden />
            {t.scanRescan}
          </button>
        </div>
        {candidates === null || scanning ? (
          <div className="form-note">{t.scanRescanning}</div>
        ) : candidates.length === 0 ? (
          <div className="form-note">{t.welcomeNoServers}</div>
        ) : (
          candidates.map((c) => (
            <button
              key={c.url}
              type="button"
              className={"scan-candidate" + (url === c.url ? " selected" : "")}
              title={c.url}
              onClick={() => setUrl(c.url)}
            >
              <span className="mono scan-candidate-path">{c.url}</span>
              <span className="tree-meta mono">
                {c.source} · {c.version ?? "—"}
              </span>
            </button>
          ))
        )}
        <label className="form-label">
          {t.profileUrl}
          <input autoFocus value={url} placeholder="http://127.0.0.1:4096" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="form-label">
          {t.profileUser}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="form-label">
          {t.profilePassword}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="form-note">{error}</div>}
        {store.connectionError && <div className="form-note">{store.connectionError}</div>}
        <button
          className="btn-primary welcome-action"
          disabled={testing || connecting || !url.trim()}
          onClick={() => void connect()}
        >
          {connecting || testing ? t.welcomeConnecting : t.welcomeConnect}
        </button>
      </div>
    </>
  )
}

function GuidanceView({ kind, onBack }: { kind: "providers" | "model-default"; onBack: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  return (
    <>
      <WelcomeHeader
        title={kind === "providers" ? t.welcomeProviderTitle : t.welcomeModelTitle}
        onBack={onBack}
      />
      <div className="welcome-body">
        <div className="form-note">
          {kind === "providers" ? t.welcomeProviderHint : t.welcomeModelHint}
        </div>
        <button
          className="btn-primary welcome-action"
          onClick={() => store.openSettings(kind === "providers" ? "providers" : "defaults")}
        >
          {kind === "providers" ? t.welcomeGoProviders : t.welcomeGoDefaults}
        </button>
        <button className="welcome-link" onClick={onBack}>
          {t.welcomeSkip}
        </button>
      </div>
    </>
  )
}

function WelcomeHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useI18n()
  return (
    <div className="dialog-title dialog-title-row">
      <div className="dialog-title-side">
        <button className="icon-btn" title={t.back} aria-label={t.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden />
        </button>
        <span>{title}</span>
      </div>
    </div>
  )
}
