import { useState } from "react"
import { useI18n, useStore } from "../app"
import type { ConnectionProfile } from "@shared/ipc"
import { ApiError, RestClient } from "@shared/rest-client"

export function SettingsDialog() {
  const store = useStore()
  const { t } = useI18n()
  const [tab, setTab] = useState<"connection" | "appearance">("connection")

  const close = () => {
    store.closeSettings()
  }

  return (
    <div className="dialog-mask" onClick={close}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t.settings}</div>
        <div className="settings-tabs">
          <button className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}>
            {t.connectionTitle}
          </button>
          <button className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>
            {t.theme} / {t.language}
          </button>
        </div>
        <div className="dialog-body">
          {tab === "connection" ? <ConnectionSettings /> : <AppearanceSettings />}
        </div>
        <div className="dialog-actions">
          <button className="btn-primary" onClick={close}>
            {t.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConnectionSettings() {
  const store = useStore()
  const { t } = useI18n()
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(store.profiles)
  const [activeId, setActiveId] = useState<string | null>(store.activeProfileId)
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const activate = async (id: string) => {
    // 先断开（此时旧 profile 仍激活，managed 模式才能正确 stop 旧进程）
    await store.disconnect()
    setActiveId(id)
    await store.saveProfiles(profiles, id)
    // 切换 profile = 全量重对账（回到 snapshot 态）
    await store.connect()
  }

  const addProfile = () => {
    setEditing({
      id: `prof_${Date.now()}`,
      name: "",
      baseUrl: "http://127.0.0.1:4096",
      mode: "attach",
    })
  }

  // 持久化必须用计算出的 next 列表（不能依赖 render 闭包里的旧 state）
  const upsert = (p: ConnectionProfile) => {
    const idx = profiles.findIndex((x) => x.id === p.id)
    const next = idx >= 0 ? profiles.map((x, i) => (i === idx ? p : x)) : [...profiles, p]
    setProfiles(next)
    setEditing(null)
    void store.saveProfiles(next, activeId)
  }

  const remove = async (p: ConnectionProfile) => {
    // 删除的是当前连接的 profile：先断开（managed stop 命中旧进程）
    if (p.id === activeId) {
      await store.disconnect()
    }
    const next = profiles.filter((x) => x.id !== p.id)
    const nextActive = activeId === p.id ? next[0]?.id ?? null : activeId
    setProfiles(next)
    setActiveId(nextActive)
    await store.saveProfiles(next, nextActive)
    // 后继 profile 存在则自动重连（避免"启用"按钮 disabled 导致无重连入口）
    if (p.id === activeId && nextActive) {
      await store.connect()
    }
  }

  const test = async (p: ConnectionProfile) => {
    setTesting(true)
    setTestResult(null)
    try {
      const client = new RestClient({ baseUrl: p.baseUrl, username: p.username, password: p.password })
      const health = await client.health()
      setTestResult(`${p.name || p.baseUrl}: ${t.testOk.replace("{version}", health.version)}`)
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      setTestResult(`${p.name || p.baseUrl}: ${t.testFailed} (${msg})`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-connection">
      <div className="profile-list">
        {profiles.map((p) => (
          <div key={p.id} className={"profile-row" + (p.id === activeId ? " active" : "")}>
            <span className="profile-mode">{p.mode}</span>
            <span className="tree-label">{p.name || p.baseUrl}</span>
            <span className="tree-meta mono">{p.baseUrl}</span>
            <button disabled={p.id === activeId} onClick={() => void activate(p.id)}>
              {p.id === activeId ? t.activeProfile : t.activateProfile}
            </button>
            <button onClick={() => setEditing(p)}>✎</button>
            <button className="danger" onClick={() => void remove(p)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="profile-actions">
        <button className="btn-primary" onClick={addProfile}>
          {t.addProfile}
        </button>
      </div>
      {testResult && <div className="form-note">{testResult}</div>}
      {editing && (
        <ProfileForm profile={editing} onCancel={() => setEditing(null)} onSave={upsert} onTest={test} testing={testing} />
      )}
    </div>
  )
}

function ProfileForm({
  profile,
  onCancel,
  onSave,
  onTest,
  testing,
}: {
  profile: ConnectionProfile
  onCancel: () => void
  onSave: (p: ConnectionProfile) => void
  onTest: (p: ConnectionProfile) => Promise<void>
  testing: boolean
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<ConnectionProfile>(profile)

  const field = (key: keyof ConnectionProfile, label: string, type = "text") => (
    <label className="form-label">
      {label}
      <input
        type={type}
        value={String(draft[key] ?? "")}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  )

  return (
    <div className="profile-form">
      {field("name", t.profileName)}
      {field("baseUrl", t.profileUrl)}
      {field("username", t.profileUser)}
      {field("password", t.profilePassword, "password")}
      <label className="form-label">
        {t.profileMode}
        <select
          value={draft.mode}
          onChange={(e) => setDraft({ ...draft, mode: e.target.value as ConnectionProfile["mode"] })}
        >
          <option value="attach">{t.modeAttach}</option>
          <option value="managed">{t.modeManaged}</option>
        </select>
      </label>
      <div className="dialog-actions">
        <button onClick={onCancel}>{t.cancel}</button>
        <button disabled={testing} onClick={() => void onTest(draft)}>
          {t.testConnection}
        </button>
        <button className="btn-primary" onClick={() => onSave(draft)}>
          {t.confirm}
        </button>
      </div>
    </div>
  )
}

function AppearanceSettings() {
  const store = useStore()
  const { t } = useI18n()
  return (
    <div className="settings-appearance">
      <label className="form-label">
        {t.theme}
        <select
          value={store.themeMode}
          onChange={(e) => void store.setThemeMode(e.target.value as "auto" | "dark" | "light")}
        >
          <option value="auto">{t.themeAuto}</option>
          <option value="dark">{t.themeDark}</option>
          <option value="light">{t.themeLight}</option>
        </select>
      </label>
      <label className="form-label">
        {t.language}
        <select
          value={store.localeMode}
          onChange={(e) => void store.setLocaleMode(e.target.value as "auto" | "zh" | "en")}
        >
          <option value="auto">{t.langAuto}</option>
          <option value="zh">{t.langZh}</option>
          <option value="en">{t.langEn}</option>
        </select>
      </label>
    </div>
  )
}
