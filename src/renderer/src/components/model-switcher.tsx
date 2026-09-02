/**
 * composer 工具条：agent / 模型 / 思考强度切换 + 全局默认值编辑（design-agent-model-switch）。
 *
 * 两种模式（同一组件）：
 * - session 模式（chat 视图）：绑定当前会话，切换走 v2 POST（store 乐观更新），
 *   成功后隐式写全局默认值（「上一次手动选择的模型 = 默认」，无显式「设为默认」动作）；
 * - defaults 模式（引导页无会话 / 设置对话框）：绑定 profile 默认值，切换只写本地持久化；
 *   未手动选择时展示生效默认 = 模型列表首项（effectiveDefaultModel）。
 *
 * 形态（D-AM-5）：agent 恰 2 个用分段开关、3+ 退化 pill+popover；model popover（分组+搜索）；
 * thinking popover 仅当前模型有 variants 时显示。「默认」= 省略 variant 字段（清掉已设值）。
 *
 * Popover 是项目首个弹层原语（后续终端/diff 复用）：受控 open、锚元素 fixed 定位、
 * 点击外部/Esc/选中关闭、↑↓+Enter 导航、打开期间 resize/scroll 重定位、锚点出视口关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Check } from "lucide-react"
import { useI18n, useStore } from "../app"
import {
  carriedVariant,
  effectiveDefaultModel,
  findModel,
  normalizeModelRef,
  type ModelCatalog,
  type ModelDefaults,
} from "@shared/model-catalog"
import type { ModelRef, Session } from "@shared/api-types"

// ============ Popover 原语 ============

interface PopoverProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  /** 最大高度（CSS 值）。默认 min(60vh, 480px)。 */
  maxHeight?: string
  /** 宽度（CSS 值）。默认锚元素宽度（最小 200px）。 */
  width?: string
}

export function Popover({ open, anchorRef, onClose, children, maxHeight, width }: PopoverProps) {
  const [pos, setPos] = useState<{ left: number; top: number; w: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // onClose 经 ref 稳定：父树每次 store emit 全量重渲染（流式中高频），
  // 内联箭头新身份不应触发监听器重注册/定位重算
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 定位 + 跟踪：open 时算一次，resize/scroll 重算；锚点出视口则关闭
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const compute = () => {
      const anchor = anchorRef.current
      const pop = popRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      if (r.bottom < -10 || r.top > window.innerHeight + 10) {
        onCloseRef.current()
        return
      }
      const margin = 4
      const w = width ? parseFloat(width) : Math.max(200, r.width)
      // 高度用实测渲染值（短弹窗如 thinking 远小于 max-height，按 max-height 上翻
      // 底部会悬空一段——AM-IMPL2-1"上翻后底边 ≤ 锚点上沿"须以实测高度保证）。
      // 隐藏首帧先直接定宽再测量（宽度影响换行高度）；已定位后取实时值
      if (pop) pop.style.width = `${w}px`
      const actualH =
        pop?.offsetHeight ??
        (maxHeight ? parseFloat(maxHeight) : Math.min(window.innerHeight * 0.6, 480))
      let left = r.left
      let top = r.bottom + margin
      // 溢出翻转：下方放不下且上方够 → 上翻，底边贴锚点上沿（margin）
      if (top + actualH > window.innerHeight - margin && r.top - margin - actualH > margin) {
        top = r.top - margin - actualH
      }
      // 右溢出收
      if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w
      if (left < margin) left = margin
      setPos({ left, top, w })
    }
    compute()
    // 内容高度变化（如搜索过滤收窄列表）重定位，保持底边贴锚点
    const ro = popRef.current ? new ResizeObserver(() => compute()) : null
    popRef.current && ro?.observe(popRef.current)
    // capture：捕获阶段先于内容 scroll，确保锚点滚动后也重定位
    window.addEventListener("resize", compute, true)
    window.addEventListener("scroll", compute, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", compute, true)
      window.removeEventListener("scroll", compute, true)
    }
  }, [open, anchorRef, maxHeight, width])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open])

  // 点击外部关闭（mousedown 在 popover 外则关）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const anchor = anchorRef.current
      const target = e.target as Node | null
      if (anchor && anchor.contains(target)) return
      // popover 内容本身由 data-popover 标记，见渲染处
      const pop = (e.target as HTMLElement | null)?.closest?.("[data-popover-content]")
      if (pop) return
      onCloseRef.current()
    }
    window.addEventListener("mousedown", onDown, true)
    return () => window.removeEventListener("mousedown", onDown, true)
  }, [open, anchorRef])

  if (!open) return null
  return createPortal(
    <div
      ref={popRef}
      data-popover-content
      className="popover"
      style={{
        position: "fixed",
        // 首帧未定位：隐藏渲染供测量（useLayoutEffect 同帧完成定位，无闪烁）
        ...(pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }),
        width: width ?? pos?.w,
        maxHeight: maxHeight ?? "min(60vh, 480px)",
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

// ============ 工具条 ============

type Mode = "session" | "defaults"

interface BarProps {
  directory: string
  mode: Mode
  /** session 模式必填；defaults 模式忽略 */
  session?: Session | null
  /** 外部禁用（如发送中） */
  disabled?: boolean
  /** 清空态（重置动效保持期）：分段全不选、模型 pill 空值——仅显示层，数据不变 */
  cleared?: boolean
}

export function ModelSwitcherBar({ directory, mode, session, disabled, cleared }: BarProps) {
  const store = useStore()
  const { t } = useI18n()
  const [switching, setSwitching] = useState(false)
  // 首次挂载拉取目录数据；popover 打开时也触发 SWR（各 control 内）
  useEffect(() => {
    void store.ensureModelCatalog(directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory])

  // 无目录（已连接但无打开项目）：无目录可解析，不渲染工具条
  //（AM-IMPL3-1：防 catalogLoading 永真的永久"加载中"）
  if (!directory) return null

  const catalog = store.modelCatalogFor(directory)
  const agents = catalog.agents
  const models = catalog.models

  // 当前值（session 模式来自会话，defaults 模式来自 profile 默认值）；
  // 读边界归一化字面 "default" variant（AM-IMPL3-2）。
  // defaults 模式展示生效默认（隐式默认）：显式默认未设/失效 → 列表首项；
  // 目录未加载/为空（catalogLoading/失败态）不做首项解析——保留显式默认原值显示
  //（错误表"仍显示当前值"；effectiveDefaultModel 空列表返回 undefined 仅适用于 createSession）
  const def = mode === "defaults" ? store.defaultsFor() : null
  const currentAgent = mode === "session" ? session?.agent ?? "build" : def?.agent ?? "build"
  const currentModel: ModelRef | undefined =
    mode === "session"
      ? normalizeModelRef(session?.model)
      : models.length
        ? effectiveDefaultModel(normalizeModelRef(def?.model), models)
        : normalizeModelRef(def?.model)

  const busy = switching || !!disabled
  const catalogLoading = !store.modelCatalogs.has(directory)

  // 加载失败且无缓存（设计错误表）：仍显示当前值，点击重试
  if (store.modelCatalogFailedFor(directory)) {
    return (
      <div className="ms-bar" title={t.modelLoadFailed}>
        <button
          className="ms-pill ms-pill-error"
          onClick={() => void store.refreshModelCatalog(directory)}
        >
          <span>{currentAgent}</span>
          {currentModel && (
            <span className="ms-pill-label">
              {currentModel.providerID}/{currentModel.id}
            </span>
          )}
          <span className="ms-pill-prefix">{t.loadFailed}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={"ms-bar" + (busy ? " disabled" : "")}>
      <AgentControl
        agents={agents}
        current={currentAgent}
        cleared={cleared}
        disabled={busy}
        directory={directory}
        onPick={async (name) => {
          if (name === currentAgent) return
          setSwitching(true)
          try {
            if (mode === "session") {
              // 防御：chat Tab 存在但会话记录缺失（快照竞态等未来路径）→ no-op，
              // 不得退化为写全局默认值（AM-IMPL2-2）
              if (!session) return
              await store.switchSessionAgent(session.id, name)
            } else {
              await store.setModelDefaults({ agent: name })
            }
          } finally {
            setSwitching(false)
          }
        }}
      />
      <ModelControl
        models={models}
        current={currentModel}
        cleared={cleared}
        loading={catalogLoading}
        disabled={busy}
        directory={directory}
        onPick={async (providerID, id) => {
          setSwitching(true)
          try {
            if (mode === "session") {
              if (!session) return // 防御：同上（AM-IMPL2-2）
              // 成功切换后由 store 隐式写全局默认（最后一次手动选择）
              await store.switchSessionModel(session.id, providerID, id)
            } else {
              // defaults 模式同样执行携带规则（与 session 模式一致）：
              // 新模型有同名 variant 才沿用，否则省略（重置默认）
              const target = findModel(models, providerID, id)
              const variant = target ? carriedVariant(currentModel?.variant, target) : undefined
              await store.setModelDefaults({
                model: variant ? { id, providerID, variant } : { id, providerID },
              })
            }
          } finally {
            setSwitching(false)
          }
        }}
      />
      {(() => {
        // thinking 控件仅当前模型有 variants 时显示
        const cur = currentModel ? findModel(models, currentModel.providerID, currentModel.id) : undefined
        if (!cur || cur.variants.length === 0) return null
        return (
          <ThinkingControl
            variants={cur.variants}
            current={currentModel?.variant}
            cleared={cleared}
            disabled={busy}
            directory={directory}
            onPick={async (variant) => {
              if (!currentModel) return
              setSwitching(true)
              try {
                if (mode === "session") {
                  if (!session) return // 防御：同上（AM-IMPL2-2）
                  await store.switchSessionVariant(
                    session.id,
                    currentModel.providerID,
                    currentModel.id,
                    variant,
                  )
                } else {
                  await store.setModelDefaults({
                    model: {
                      id: currentModel.id,
                      providerID: currentModel.providerID,
                      ...(variant ? { variant } : {}),
                    },
                  })
                }
              } finally {
                setSwitching(false)
              }
            }}
          />
        )
      })()}
    </div>
  )
}

// ============ Agent 控件 ============

function AgentControl({
  agents,
  current,
  cleared,
  disabled,
  directory,
  onPick,
}: {
  agents: ModelCatalog["agents"]
  current: string
  /** 清空态：所有分段不选中 / pill 空值（重置动效保持期） */
  cleared?: boolean
  disabled: boolean
  directory: string
  onPick: (name: string) => void
}) {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const anchorRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      // 初始焦点 = 当前选中项（未设/不在列表 → 首项）
      const idx = agents.findIndex((a) => a.name === current)
      setSel(idx >= 0 ? idx : 0)
      // popover 打开时 SWR（与 ModelControl 一致）
      void store.refreshModelCatalog(directory)
      requestAnimationFrame(() => listRef.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, directory])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".ms-row.focused")
      ?.scrollIntoView({ block: "nearest" })
    // open：重开时 sel 可能不变（同一项），仍需把焦点行滚入视野
  }, [sel, open])

  const selClamped = Math.min(sel, Math.max(0, agents.length - 1))

  const segmented = agents.length === 2

  // 形态切换为分段开关时关闭遗留的 popover 打开态
  //（防后台 SWR 刷新 3+→2→3+ 时 popover 自发重开，AM-IMPL3-5）
  useEffect(() => {
    if (segmented) setOpen(false)
  }, [segmented])

  // 恰好 2 个 → 分段开关；否则 pill + popover
  if (segmented) {
    return (
      <div className="ms-segmented" ref={anchorRef as React.RefObject<HTMLDivElement>}>
        {agents.map((a) => {
          const active = !cleared && a.name === current
          return (
            <button
              key={a.name}
              className={"ms-seg" + (active ? " active" : "")}
              disabled={disabled}
              title={a.description}
              onClick={() => onPick(a.name)}
            >
              {a.name}
            </button>
          )
        })}
      </div>
    )
  }

  // ≤1 个 → 静态 pill（无可切换目标，仅显示当前值）
  if (agents.length <= 1) {
    return <div className="ms-pill ms-pill-static">{cleared ? "" : current}</div>
  }

  // ≥3 → pill + popover（↑↓+Enter 导航，对齐 CommandHints）
  return (
    <>
      <button
        className="ms-pill"
        ref={anchorRef as React.RefObject<HTMLButtonElement>}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{cleared ? "" : current}</span>
        <span className="ms-chev">▾</span>
      </button>
      <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)}>
        <div
          className="ms-list"
          ref={listRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const len = agents.length
              if (len === 0) return
              setSel(e.key === "ArrowDown" ? (selClamped + 1) % len : (selClamped - 1 + len) % len)
            } else if (e.key === "Enter") {
              e.preventDefault()
              const a = agents[selClamped]
              if (a) {
                setOpen(false)
                onPick(a.name)
              }
            }
          }}
        >
          {agents.map((a, i) => (
            <button
              key={a.name}
              className={
                "ms-row" +
                (a.name === current ? " selected" : "") +
                (i === selClamped ? " focused" : "")
              }
              onClick={() => {
                setOpen(false)
                onPick(a.name)
              }}
            >
              <span>{a.name}</span>
              {a.name === current && <Check className="ms-check" size={14} aria-hidden />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

// ============ Model 控件 ============

function ModelControl({
  models,
  current,
  cleared,
  loading,
  disabled,
  directory,
  onPick,
}: {
  models: ModelCatalog["models"]
  current: ModelRef | undefined
  /** 清空态：pill 空值（重置动效保持期），不回落到占位词条 */
  cleared?: boolean
  loading: boolean
  disabled: boolean
  directory: string
  onPick: (providerID: string, id: string) => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [sel, setSel] = useState(0)

  // 打开时 SWR 重拉
  useEffect(() => {
    if (open) {
      void store.refreshModelCatalog(directory)
      setQuery("")
      // 初始焦点 = 当前选中项。空 query 下 flatRows 与 models 同序（分组保首现序），
      // 直接在 models 上找索引；未设/不在列表（失效默认）→ 首项
      const idx = current
        ? models.findIndex((m) => m.providerID === current.providerID && m.id === current.id)
        : -1
      setSel(idx >= 0 ? idx : 0)
      // rAF 聚焦搜索框（popover 首帧隐藏渲染供测量，autoFocus 在隐藏帧落空——
      // 与 agent/thinking 列表同模式，此时定位已完成）
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, directory])

  const label = cleared ? "" : current ? `${current.providerID}/${current.id}` : t.model

  // 按 provider 分组（保序：首现序）
  const groups = new Map<string, ModelCatalog["models"]>()
  const q = query.trim().toLowerCase()
  for (const m of models) {
    if (q) {
      const hay = `${m.name} ${m.id} ${m.providerID}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    const arr = groups.get(m.providerID) ?? []
    arr.push(m)
    groups.set(m.providerID, arr)
  }
  const flatRows: Array<{ providerID: string; id: string }> = []
  for (const [pid, arr] of groups) {
    for (const m of arr) flatRows.push({ providerID: pid, id: m.id })
  }
  const selClamped = Math.min(sel, Math.max(0, flatRows.length - 1))

  // 键盘移动时保持焦点行可见（60+ 模型内部滚动，对齐 CommandHints）
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".ms-row.focused")
      ?.scrollIntoView({ block: "nearest" })
    // open：重开时 sel 可能不变（同一项），仍需把焦点行滚入视野
  }, [selClamped, open])

  return (
    <>
      <button
        className="ms-pill"
        ref={anchorRef}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ms-pill-label">{label}</span>
        <span className="ms-chev">▾</span>
      </button>
      <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} width="320px">
        <div className="ms-model">
          <input
            ref={searchRef}
            className="ms-search"
            placeholder={t.modelSearchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const len = flatRows.length
                if (len === 0) return
                setSel(e.key === "ArrowDown" ? (selClamped + 1) % len : (selClamped - 1 + len) % len)
              } else if (e.key === "Enter") {
                e.preventDefault()
                const row = flatRows[selClamped]
                if (row) {
                  setOpen(false)
                  onPick(row.providerID, row.id)
                }
              }
            }}
          />
          <div className="ms-model-list scroll" ref={listRef}>
            {loading && models.length === 0 && <div className="ms-empty">{t.loading}</div>}
            {!loading && flatRows.length === 0 && <div className="ms-empty">{t.noModelMatch}</div>}
            {[...groups.entries()].map(([pid, arr]) => (
              <div key={pid} className="ms-group">
                <div className="ms-group-head">
                  <span className="mono">{pid}</span>
                  <span className="ms-group-count">{arr.length}</span>
                </div>
                {arr.map((m) => {
                  const isCurrent =
                    current?.providerID === m.providerID && current?.id === m.id
                  const rowIdx = flatRows.findIndex(
                    (r) => r.providerID === m.providerID && r.id === m.id,
                  )
                  return (
                    <button
                      key={`${m.providerID}/${m.id}`}
                      className={
                        "ms-row" +
                        (isCurrent ? " selected" : "") +
                        (rowIdx === selClamped ? " focused" : "")
                      }
                      onClick={() => {
                        setOpen(false)
                        onPick(m.providerID, m.id)
                      }}
                    >
                      <span className="ms-row-main">
                        <span className="ms-row-name">{m.name}</span>
                        <span className="ms-row-id mono">{m.id}</span>
                      </span>
                      {isCurrent && <Check className="ms-check" size={14} aria-hidden />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </Popover>
    </>
  )
}

// ============ Thinking 控件 ============

function ThinkingControl({
  variants,
  current,
  cleared,
  disabled,
  directory,
  onPick,
}: {
  variants: string[]
  current: string | undefined
  /** 清空态：值空（保留 Thinking 前缀作控件标识） */
  cleared?: boolean
  disabled: boolean
  directory: string
  onPick: (variant: string | undefined) => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      // 初始焦点 = 当前选中项（opts = [undefined, ...variants]；未设/不在列表 → 0 = 「默认」）
      const idx = current ? 1 + variants.indexOf(current) : 0
      setSel(idx >= 0 ? idx : 0)
      // popover 打开时 SWR（与 agent/model popover 一致）
      void store.refreshModelCatalog(directory)
      requestAnimationFrame(() => listRef.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, directory])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".ms-row.focused")
      ?.scrollIntoView({ block: "nearest" })
    // open：重开时 sel 可能不变（同一项），仍需把焦点行滚入视野
  }, [sel, open])

  // 选项 = 「默认」（undefined）+ variants keys
  const opts: (string | undefined)[] = [undefined, ...variants]
  const selClamped = Math.min(sel, Math.max(0, opts.length - 1))
  const label = cleared ? "" : current ?? t.thinkingDefault
  return (
    <>
      <button
        className="ms-pill"
        ref={anchorRef}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ms-pill-prefix">{t.thinkingLabel}</span>
        <span>{label}</span>
        <span className="ms-chev">▾</span>
      </button>
      <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} width="180px">
        <div
          className="ms-list"
          ref={listRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const len = opts.length
              if (len === 0) return
              setSel(e.key === "ArrowDown" ? (selClamped + 1) % len : (selClamped - 1 + len) % len)
            } else if (e.key === "Enter") {
              e.preventDefault()
              setOpen(false)
              onPick(opts[selClamped])
            }
          }}
        >
          <button
            className={"ms-row" + (!current ? " selected" : "") + (selClamped === 0 ? " focused" : "")}
            onClick={() => {
              setOpen(false)
              onPick(undefined)
            }}
          >
            <span>{t.thinkingDefault}</span>
            {!current && <Check className="ms-check" size={14} aria-hidden />}
          </button>
          {variants.map((v, i) => (
            <button
              key={v}
              className={
                "ms-row" +
                (v === current ? " selected" : "") +
                (i + 1 === selClamped ? " focused" : "")
              }
              onClick={() => {
                setOpen(false)
                onPick(v)
              }}
            >
              <span>{v}</span>
              {v === current && <Check className="ms-check" size={14} aria-hidden />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
