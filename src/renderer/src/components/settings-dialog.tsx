import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Pencil, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import type { BinaryCandidate, ConnectionProfile, ManagedNotice } from "@shared/ipc"
import { MIN_SERVER_VERSION } from "@shared/semver"
import { ApiError, RestClient } from "@shared/rest-client"
import type { ProviderCatalog, ProviderInfo } from "@shared/api-types"
import { ConfirmDialog } from "./confirm-dialog"
import { managedNoticeText } from "./managed-notice"
import { ModelSwitcherBar } from "./model-switcher"

/** 设置弹窗（dialog-lg）。模态不重叠（DESIGN.md §标准弹窗）：添加/编辑服务器
 *  在弹窗内跳转视图（标题行左置返回钮），不叠加二级弹窗 */
export function SettingsDialog() {
  const store = useStore()
  const { t } = useI18n()
  const [tab, setTab] = useState<"connection" | "providers" | "appearance" | "defaults">("connection")
  // 非空 = 弹窗内跳转到服务器表单视图（丢弃 tabs 视图，草稿随视图卸载）
  const [editing, setEditing] = useState<{ profile: ConnectionProfile; isNew: boolean } | null>(null)
  // 非空 = 弹窗内跳转到 provider key 表单视图（review P2：与 profile 表单同层，
  // Esc 退回列表、标题行返回钮、actions 钉底）
  const [providerEdit, setProviderEdit] = useState<ProviderInfo | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const close = () => {
    store.closeSettings()
  }

  // 列表视图聚焦弹窗容器（Esc keydown 有落脚点，表单视图焦点在首输入框）
  useEffect(() => {
    if (!editing) dialogRef.current?.focus()
  }, [editing])

  // 保存 = upsert 直落 store（弹窗内视图跳转后 ConnectionSettings 卸载重挂，
  // 列表从 store 直读，无本地镜像；持久化用计算出的 next 列表）
  const saveProfile = (p: ConnectionProfile) => {
    const idx = store.profiles.findIndex((x) => x.id === p.id)
    const next =
      idx >= 0 ? store.profiles.map((x, i) => (i === idx ? p : x)) : [...store.profiles, p]
    void store.saveProfiles(next, store.activeProfileId)
    setEditing(null)
  }

  return (
    <div className="dialog-mask" onClick={close}>
      <div
        ref={dialogRef}
        className="dialog dialog-lg"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // IME 组合中的 Escape 是取消候选词，不能顺手关弹窗（同项目选择器）
          if (e.nativeEvent.isComposing) return
          // Esc 分层（review P2）：profile 表单 / provider key 表单先退回列表
          //（丢弃草稿），列表视图才关弹窗
          if (e.key === "Escape") {
            if (editing) setEditing(null)
            else if (providerEdit) setProviderEdit(null)
            else close()
          }
        }}
      >
        {editing ? (
          <>
            <div className="dialog-title dialog-title-row">
              <div className="dialog-title-side">
                <button
                  className="icon-btn"
                  title={t.back}
                  aria-label={t.back}
                  onClick={() => setEditing(null)}
                >
                  <ArrowLeft size={14} aria-hidden />
                </button>
                <span>{editing.isNew ? t.addProfileTitle : t.editProfileTitle}</span>
              </div>
              <button className="icon-btn" title={t.close} aria-label={t.close} onClick={close}>
                <X size={14} aria-hidden />
              </button>
            </div>
            <ProfileFormView
              profile={editing.profile}
              onCancel={() => setEditing(null)}
              onSave={saveProfile}
            />
          </>
        ) : providerEdit ? (
          <>
            <div className="dialog-title dialog-title-row">
              <div className="dialog-title-side">
                <button
                  className="icon-btn"
                  title={t.back}
                  aria-label={t.back}
                  onClick={() => setProviderEdit(null)}
                >
                  <ArrowLeft size={14} aria-hidden />
                </button>
                <span>{t.providerKeyFor.replace("{name}", providerEdit.name)}</span>
              </div>
              <button className="icon-btn" title={t.close} aria-label={t.close} onClick={close}>
                <X size={14} aria-hidden />
              </button>
            </div>
            <ProviderKeyForm
              provider={providerEdit}
              onCancel={() => setProviderEdit(null)}
              onSaved={() => setProviderEdit(null)}
            />
          </>
        ) : (
          <>
            <div className="dialog-title dialog-title-row">
              <span>{t.settings}</span>
              <button className="icon-btn" title={t.close} aria-label={t.close} onClick={close}>
                <X size={14} aria-hidden />
              </button>
            </div>
            <div className="settings-tabs">
              <button className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}>
                {t.connectionTitle}
              </button>
              <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}>
                {t.providerTitle}
              </button>
              <button className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>
                {t.appearanceTitle}
              </button>
              <button className={tab === "defaults" ? "active" : ""} onClick={() => setTab("defaults")}>
                {t.defaultsTitle}
              </button>
            </div>
            <div className="dialog-body">
              {tab === "connection" ? (
                <ConnectionSettings onEdit={setEditing} />
              ) : tab === "providers" ? (
                <ProviderSettings onEditKey={setProviderEdit} />
              ) : tab === "appearance" ? (
                <AppearanceSettings />
              ) : (
                <DefaultsSettings />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ConnectionSettings({
  onEdit,
}: {
  onEdit: (editing: { profile: ConnectionProfile; isNew: boolean }) => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const profiles = store.profiles
  const activeId = store.activeProfileId
  const activeManaged = store.activeProfile?.mode === "managed"

  const activate = async (id: string) => {
    // 先断开（此时旧 profile 仍激活，managed 模式才能正确 stop 旧进程）
    await store.disconnect()
    await store.saveProfiles(profiles, id)
    // 切换 profile = 全量重对账（回到 snapshot 态）
    await store.connect()
  }

  const addProfile = () => {
    onEdit({
      profile: {
        id: `prof_${Date.now()}`,
        name: "",
        baseUrl: "http://127.0.0.1:4096",
        mode: "attach",
      },
      isNew: true,
    })
  }

  const remove = async (p: ConnectionProfile) => {
    // 删除的是当前连接的 profile：先断开（managed stop 命中旧进程）
    if (p.id === activeId) {
      await store.disconnect()
    }
    const next = profiles.filter((x) => x.id !== p.id)
    const nextActive = activeId === p.id ? next[0]?.id ?? null : activeId
    await store.saveProfiles(next, nextActive)
    // 后继 profile 存在则自动重连（避免"启用"按钮 disabled 导致无重连入口）
    if (p.id === activeId && nextActive) {
      await store.connect()
    }
  }

  const copyLogs = () => {
    void navigator.clipboard?.writeText(store.managedLogLines.join(""))?.catch(() => {})
  }

  return (
    <div className="settings-connection">
      {store.serverVersionWarning && (
        <div className="form-note">
          {t.serverVersionWarn
            .replace("{version}", store.serverVersionWarning.version)
            .replace(/\{min\}/g, MIN_SERVER_VERSION)}
        </div>
      )}
      {activeManaged && store.managedNotice && (
        <div className="form-note">{managedNoticeText(store.managedNotice, t)}</div>
      )}
      <div className="profile-list">
        {profiles.map((p) => (
          <div key={p.id} className={"profile-row" + (p.id === activeId ? " active" : "")}>
            <span className="profile-mode">{p.mode}</span>
            <span className="tree-label">{p.name || (p.mode === "managed" ? p.binaryPath || "opencode" : p.baseUrl)}</span>
            <span className="tree-meta mono">{p.mode === "managed" ? "managed" : p.baseUrl}</span>
            <button disabled={p.id === activeId} onClick={() => void activate(p.id)}>
              {p.id === activeId ? t.activeProfile : t.activateProfile}
            </button>
            <button title={t.editProfile} aria-label={t.editProfile} onClick={() => onEdit({ profile: p, isNew: false })}>
              <Pencil size={12} aria-hidden />
            </button>
            <button className="danger" title={t.removeProfile} aria-label={t.removeProfile} onClick={() => void remove(p)}>
              <X size={12} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="profile-actions">
        <button className="btn-primary" onClick={addProfile}>
          {t.addProfile}
        </button>
      </div>
      {activeManaged && (
        <div className="server-log-section">
          <div className="scan-section-title">
            <span>{t.serverLogTitle}</span>
            <button type="button" disabled={store.managedLogLines.length === 0} onClick={copyLogs}>
              {t.serverLogCopy}
            </button>
          </div>
          {store.managedLogLines.length === 0 ? (
            <div className="form-note">{t.serverLogEmpty}</div>
          ) : (
            <pre className="server-log-tail mono">{store.managedLogLines.join("")}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/** 添加/编辑服务器视图：渲染 dialog-body + dialog-actions（标题行的返回/关闭
 *  钮由 SettingsDialog 提供）；取消 = 丢弃草稿返回列表，保存 = upsert 落盘。
 *  表单按模式分化（design-managed-config §1）：managed 隐藏 URL/凭据（随机端口
 *  + 自动凭据），新增二进制路径（自动扫描候选 + 浏览手选）；attach 字段不变 */
function ProfileFormView({
  profile,
  onCancel,
  onSave,
}: {
  profile: ConnectionProfile
  onCancel: () => void
  onSave: (p: ConnectionProfile) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<ConnectionProfile>(profile)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  // managed 扫描候选（design-auto-scan）：进入 managed 表单自动跑一轮 + 手动重扫
  const [candidates, setCandidates] = useState<BinaryCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const runScan = async () => {
    setScanning(true)
    try {
      setCandidates(await window.desktop.scanBinaries())
    } catch {
      setCandidates([])
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    if (draft.mode === "managed" && candidates === null && !scanning) void runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.mode])

  const browseBinary = async () => {
    const p = await window.desktop.openBinaryPicker()
    if (p) setDraft({ ...draft, binaryPath: p })
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const client = new RestClient({ baseUrl: draft.baseUrl, username: draft.username, password: draft.password })
      const health = await client.health()
      setTestResult(t.testOk.replace("{version}", health.version))
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      setTestResult(`${t.testFailed} (${msg})`)
    } finally {
      setTesting(false)
    }
  }

  const field = (key: keyof ConnectionProfile, label: string, type = "text", autoFocus = false) => (
    <label className="form-label">
      {label}
      <input
        type={type}
        autoFocus={autoFocus}
        value={String(draft[key] ?? "")}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  )

  const managed = draft.mode === "managed"

  return (
    <>
      <div className="dialog-body">
        {field("name", t.profileName, "text", true)}
        {managed ? (
          <>
            <label className="form-label">
              {t.profileBinaryPath}
              <div className="binary-path-row">
                <input
                  value={draft.binaryPath ?? ""}
                  placeholder={t.profileBinaryPathHint}
                  onChange={(e) => setDraft({ ...draft, binaryPath: e.target.value })}
                />
                <button type="button" onClick={() => void browseBinary()}>
                  {t.browseBinary}
                </button>
              </div>
            </label>
            <div className="form-note">{t.managedCredsHint}</div>
            <div className="scan-section">
              <div className="scan-section-title">
                <span>{t.scanCandidatesTitle}</span>
                <button type="button" disabled={scanning} onClick={() => void runScan()}>
                  {scanning ? t.scanRescanning : t.scanRescan}
                </button>
              </div>
              {candidates === null || scanning ? (
                <div className="form-note">{t.scanRescanning}</div>
              ) : candidates.length === 0 ? (
                <div className="form-note">{t.scanNone}</div>
              ) : (
                candidates.map((c) => (
                  <button
                    key={c.path}
                    type="button"
                    className={"scan-candidate" + (draft.binaryPath === c.path ? " selected" : "")}
                    title={c.path}
                    onClick={() => setDraft({ ...draft, binaryPath: c.path })}
                  >
                    <span className="mono scan-candidate-path">{c.path}</span>
                    <span className="tree-meta mono">{c.version ?? "—"}</span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            {field("baseUrl", t.profileUrl)}
            {field("username", t.profileUser)}
            {field("password", t.profilePassword, "password")}
          </>
        )}
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
        {!managed && testResult && <div className="form-note">{testResult}</div>}
      </div>
      <div className="dialog-actions">
        <button onClick={onCancel}>{t.cancel}</button>
        {!managed && (
          <button disabled={testing} onClick={() => void test()}>
            {t.testConnection}
          </button>
        )}
        <button className="btn-primary" onClick={() => onSave(draft)}>
          {t.save}
        </button>
      </div>
    </>
  )
}

/** Provider 页签数据操作面（注入供测试；默认走激活连接的 client） */
export interface ProviderOps {
  list: (directory: string) => Promise<ProviderCatalog>
  setKey: (providerID: string, key: string) => Promise<boolean>
  removeKey: (providerID: string) => Promise<boolean>
}

function defaultProviderOps(store: ReturnType<typeof useStore>): ProviderOps {
  const client = () => {
    const c = store.getActiveClient()
    if (!c) throw new Error("not connected")
    return c
  }
  return {
    list: (directory) => client().listProviderCatalog(directory),
    setKey: (id, key) => client().setProviderKey(id, key),
    removeKey: (id) => client().deleteProviderKey(id),
  }
}

/** 全目录搜索过滤（纯函数供单测）：id/名称子串不区分大小写，上限 20 */
export function filterProviders(all: ProviderInfo[], query: string): ProviderInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: ProviderInfo[] = []
  for (const p of all) {
    if (p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
      out.push(p)
      if (out.length >= 20) break
    }
  }
  return out
}

/** Provider 页签（design-provider-config）：已连接组 + 全目录搜索 + key 删除；
 *  key 设置经 onEditKey 提升到 SettingsDialog 层的表单视图（review P2：Esc 分层
 *  与 ProfileFormView 一致、actions 钉底）。ops 注入供测试 */
export function ProviderSettings({
  ops,
  onEditKey,
}: {
  ops?: ProviderOps
  onEditKey: (p: ProviderInfo) => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const directory = store.scopeQuery.directory
  const connected = !!store.getActiveClient()
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // 删除二次确认
  const [confirming, setConfirming] = useState<ProviderInfo | null>(null)
  const realOps = ops ?? defaultProviderOps(store)
  // 请求序号（review P3）：作用域/连接态变化重拉时，迟到的旧响应不覆盖新结果
  const reloadSeq = useRef(0)

  const reload = async () => {
    if (!connected || !directory) return
    const seq = ++reloadSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await realOps.list(directory)
      if (seq !== reloadSeq.current) return
      setCatalog(next)
    } catch (e) {
      if (seq !== reloadSeq.current) return
      // 错误不清已渲染列表（review P3：瞬态网络错误不白屏）
      setError(e instanceof Error && e.message !== "not connected" ? e.message : t.connectFirst)
    } finally {
      if (seq === reloadSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, directory])

  if (!connected || !directory) {
    return (
      <div className="settings-providers">
        <div className="form-note">{t.connectFirst}</div>
      </div>
    )
  }

  // 默认视图 = 已配置（key 非空 **或** 在 connected 集——多 env 候选的 provider
  // key 合并为 undefined 但已连接，review P2：漏掉会误显示"尚无已配置"）
  const connectedIds = new Set(catalog?.connected ?? [])
  const searchResults = filterProviders(catalog?.all ?? [], query)
  const rows = query.trim()
    ? searchResults
    : (catalog?.all ?? []).filter((p) => !!p.key || connectedIds.has(p.id))

  return (
    <div className="settings-providers">
      <div className="scan-section-title">
        <input
          className="provider-search"
          placeholder={t.providerSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? t.providerReloading : t.providerRefresh}
        </button>
      </div>
      {error && <div className="form-note">{error}</div>}
      {!error && !loading && catalog && (
        <div className="provider-key-hint form-note">{t.providerKeyHint}</div>
      )}
      {!loading && catalog && rows.length === 0 && (
        <div className="form-note">{query.trim() ? t.providerNoMatch : t.providerNoneConnected}</div>
      )}
      <div className="provider-list">
        {rows.map((p) => {
          const keyOn = !!p.key || connectedIds.has(p.id)
          return (
            <div key={p.id} className="provider-row">
              <span
                className={"provider-key-dot " + (keyOn ? "on" : "off")}
                title={keyOn ? t.providerKeyOn : t.providerKeyOff}
              />
              <span className="tree-label">{p.name}</span>
              <span className="profile-mode">{p.source}</span>
              <span className="tree-meta mono">
                {t.providerModels.replace("{count}", String(Object.keys(p.models ?? {}).length))}
              </span>
              <button onClick={() => onEditKey(p)}>
                {keyOn ? t.providerKeyReplace : t.providerKeySet}
              </button>
              {keyOn && (
                <button className="danger" onClick={() => setConfirming(p)}>
                  {t.providerKeyDelete}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {confirming && (
        <ConfirmDialog
          title={t.providerKeyDeleteConfirmTitle.replace("{name}", confirming.name)}
          message={t.providerKeyDeleteConfirmBody}
          confirmLabel={t.providerKeyDelete}
          cancelLabel={t.cancel}
          danger
          onConfirm={() => {
            const target = confirming
            setConfirming(null)
            void realOps
              .removeKey(target.id)
              .then(() => reload())
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

/** provider key 表单（SettingsDialog 层视图，同 ProfileFormView 结构；review P2）：
 *  保存成功后 ProviderSettings 重挂自动重拉列表 */
export function ProviderKeyForm({
  provider,
  ops,
  onCancel,
  onSaved,
}: {
  provider: ProviderInfo
  ops?: ProviderOps
  onCancel: () => void
  onSaved: () => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const realOps = ops ?? defaultProviderOps(store)
  const [keyDraft, setKeyDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  return (
    <>
      <div className="dialog-body">
        <label className="form-label">
          {t.providerKeyFor.replace("{name}", provider.name)}
          <input
            type="password"
            autoFocus
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
        </label>
        {editError && <div className="form-note">{editError}</div>}
      </div>
      <div className="dialog-actions">
        <button onClick={onCancel}>{t.cancel}</button>
        <button
          className="btn-primary"
          disabled={saving || !keyDraft.trim()}
          onClick={() => {
            setSaving(true)
            setEditError(null)
            void realOps
              .setKey(provider.id, keyDraft.trim())
              .then(() => onSaved())
              .catch((e: unknown) => {
                setEditError(e instanceof Error && e.message !== "not connected" ? e.message : t.connectFirst)
              })
              .finally(() => setSaving(false))
          }}
        >
          {t.save}
        </button>
      </div>
    </>
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
      <label className="settings-check">
        <input
          type="checkbox"
          checked={store.showThinking}
          onChange={(e) => void store.setShowThinking(e.target.checked)}
        />
        <span className="settings-check-text">
          <span>{t.showThinking}</span>
          <span className="settings-check-hint">{t.showThinkingHint}</span>
        </span>
      </label>
    </div>
  )
}

function DefaultsSettings() {
  const store = useStore()
  const { t } = useI18n()
  const [resetting, setResetting] = useState(false)
  const resetTimer = useRef<number>(0)
  const directory = store.scopeQuery.directory
  const connected = !!store.getActiveClient()

  // 重置动效：点击即清默认值（数据层立即回退隐式默认），但控件先呈现空态
  //（分段全不选 + 模型 pill 空值）保持 ~500ms，再刷新出生效默认值；
  // 连点重置时只认最后一次点击的计时
  const reset = () => {
    setResetting(true)
    void store.setModelDefaults({ agent: undefined, model: undefined })
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setResetting(false), 500)
  }

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  return (
    <div className="settings-defaults">
      <div className="form-note">{t.defaultsHint}</div>
      {!connected ? (
        <div className="form-note">{t.connectFirst}</div>
      ) : !directory ? (
        // 已连接但无打开项目：无目录可解析模型列表，不渲染工具条（防永久"加载中"）
        <div className="form-note">{t.noProject}</div>
      ) : (
        <>
          <ModelSwitcherBar directory={directory} mode="defaults" cleared={resetting} />
          <button className="btn-tonal" onClick={reset}>
            {t.resetDefaults}
          </button>
        </>
      )}
    </div>
  )
}
