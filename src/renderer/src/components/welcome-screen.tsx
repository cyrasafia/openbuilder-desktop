/**
 * 欢迎屏（design-welcome-screen，2026-09-06 二次修订）：无激活 profile（无服务
 * 器）时的全页向导。只呈现「添加服务器」入口；点击进入与设置弹窗**同源复用**的
 * 引导式流程（design-guided-add-server 的 DiscoverView + ProfileFormView，单一
 * 来源非复制），差异仅注入项：动作语义 = 建档 + 激活 + 连接（设置弹窗 = 启用流
 * 挂起；attach 先 health 验证再建档，失败不残留——managed 建档→connect，原分支
 * 各自语义保留）、busy（连接/预验中禁用）、emptyContent（首装安装指引）。连接
 * 成功直接关闭欢迎屏（无 provider/默认模型引导）——Shell 接管，未打开项目时中
 * 栏即「打开项目」页。连接中卡片内「连接中…」行带 spinner（与设置弹窗挂起行
 * 同视觉，design-guided-add-server 修订 2）；失败停在原视图（候选可再点）。
 * 替代 Shell 渲染（TitleBar 由 App 层保留）；入口页底部保留设置入口。
 */
import { useEffect, useState } from "react"
import { ArrowLeft, Copy, LoaderCircle } from "lucide-react"
import { useI18n, useStore } from "../app"
import type { ConnectionProfile } from "@shared/ipc"
import { ApiError, RestClient } from "@shared/rest-client"
import { DiscoverView, ProfileFormView, newProfileDraft } from "./settings-dialog"

type View = "entry" | "discover" | "manual"

/** 安装指引命令（design-welcome-screen；范围外：不自动安装） */
const INSTALL_COMMANDS = [
  { label: "linux / macOS", cmd: "curl -fsSL https://opencode.ai/install | bash" },
  { label: "brew", cmd: "brew install anomalyco/tap/opencode" },
  { label: "npm", cmd: "npm install -g opencode-ai" },
]

export function WelcomeScreen() {
  const store = useStore()
  const { t } = useI18n()
  const [view, setView] = useState<View>("entry")
  const connecting = store.connectionState === "connecting"
  // attach 预验进行中（health 探测期禁用候选/动作，兼作 review 指出的
  // saveProfiles 往返窗口的防重复闸门）
  const [testing, setTesting] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const busy = connecting || testing

  // 连接成功即关闭欢迎屏（2026-09-06 修订：不再做 provider/默认模型检查）——
  // Shell 接管，未打开项目时中栏即「打开项目」引导页
  useEffect(() => {
    if (store.connectionState === "streaming") store.closeWelcome()
  }, [store.connectionState, store])

  // 与设置弹窗的唯一语义差异：候选/表单产物建档（固定 id upsert，重试/往返不堆
  // profile）+ 激活 + 连接。attach 先 health 再建档（原 attach 分支语义，恢复于
  // review 追问）：失败不残留死 profile；候选虽经扫描无凭据预验证，此处带凭据
  // 复验一并关闭"扫描后 server 下线"窄窗。managed 维持建档→connect（spawn 失败
  // 保留固定 id profile，设置内可调整重试，原 managed 分支同语义）
  const pick = (p: ConnectionProfile) => {
    const profile: ConnectionProfile = {
      ...p,
      id: p.mode === "managed" ? "welcome-managed" : "welcome-attach",
    }
    setPickError(null)
    if (profile.mode === "managed") {
      void connectWithProfile(store, profile)
      return
    }
    setTesting(true)
    const client = new RestClient({
      baseUrl: profile.baseUrl,
      username: profile.username,
      password: profile.password,
    })
    void client
      .health()
      .then(() => connectWithProfile(store, profile))
      .catch((e: unknown) => {
        setPickError(
          e instanceof ApiError
            ? `${t.testFailed} (${e.message})`
            : e instanceof Error
              ? e.message
              : String(e),
        )
      })
      .finally(() => setTesting(false))
  }

  return (
    <div className="welcome-wrap">
      <div className="welcome-card">
        {view === "entry" ? (
          <>
            <div className="welcome-title">{t.welcomeTitle}</div>
            <div className="welcome-sub">{t.welcomeSubtitle}</div>
            <div className="welcome-body">
              <button className="btn-primary welcome-entry-btn" onClick={() => setView("discover")}>
                {t.addProfileTitle}
              </button>
            </div>
            <button className="welcome-settings" onClick={() => store.openSettings()}>
              {t.openSettings}
            </button>
          </>
        ) : view === "discover" ? (
          <>
            <WelcomeHeader title={t.addProfileTitle} onBack={() => setView("entry")} />
            <DiscoverView
              busy={busy}
              emptyContent={<InstallHint />}
              onManual={() => setView("manual")}
              onPick={pick}
            />
          </>
        ) : (
          <>
            <WelcomeHeader title={t.addProfileManualTitle} onBack={() => setView("discover")} />
            <ProfileFormView
              profile={newProfileDraft()}
              saveLabel={(mode) => (mode === "managed" ? t.welcomeStartAndConnect : t.welcomeConnect)}
              busy={busy}
              onCancel={() => setView("discover")}
              onSave={pick}
            />
          </>
        )}
        {connecting && (
          <div className="form-note welcome-connecting">
            <LoaderCircle className="welcome-connecting-spinner" size={14} aria-hidden />
            <span>{t.welcomeConnecting}</span>
          </div>
        )}
        {pickError && <div className="form-note welcome-error">{pickError}</div>}
        {store.connectionError && !connecting && (
          <div className="form-note welcome-error">{store.connectionError}</div>
        )}
      </div>
    </div>
  )
}

/** 双路皆空的安装指引（欢迎屏专属 emptyContent——首装用户兜底，设置弹窗不传；
 *  复制反馈为本地态） */
function InstallHint() {
  const { t } = useI18n()
  const [copied, setCopied] = useState<string | null>(null)
  return (
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
    </>
  )
}

/** 建 profile + 激活 + 连接（discover/manual 共用；connect 内部含 spawn/健康/快照）。
 *  openPickerAfter 同设置页新增流（design-guided-add-server 修订）：连接成功且
 *  无已打开项目时直达项目选择器；先断开再改激活（同 activate 惯例，managed
 *  旧进程正确 stop）。拒绝路径吞掉（调用方 void 挂起无收尾 UI，IPC 层异常
 *  不冒 unhandled rejection；连接失败走 store 状态机由 connectionError 呈现） */
async function connectWithProfile(
  store: ReturnType<typeof useStore>,
  profile: ConnectionProfile,
): Promise<void> {
  try {
    const idx = store.profiles.findIndex((p) => p.id === profile.id)
    const next =
      idx >= 0 ? store.profiles.map((p, i) => (i === idx ? profile : p)) : [...store.profiles, profile]
    await store.disconnect()
    await store.saveProfiles(next, profile.id)
    await store.connect({ openPickerAfter: true })
  } catch {
    // store 状态机收尾（connectionError 行可见）；此处无额外 UI
  }
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
