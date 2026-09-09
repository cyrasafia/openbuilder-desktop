/**
 * 页面内搜索（design-find-in-page）：
 *
 * - `FindBar`：三视图共用查找条 UI（输入框 + 计数 + 上一处/下一处 + 关闭），
 *   纯展示 + 回调驱动，匹配模型由调用方自带（DOM 扫描或 findInPage 推送）。
 * - `useWebContentsFind`：浏览器 Tab / PDF 的 findInPage 会话状态机
 *   （输入即新 query、findNext 前后跳、requestId 旧帧守卫、导航清零）。
 * - `useFindBarController`：视图挂载时向 store 注册 Ctrl+F 唤起回调（Tab 注册制
 *   精神——无注册回调的视图全局分发放行）；返回查找条开合态 + 打开函数。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import { format } from "../i18n"

export interface FindBarProps {
  /** 当前输入（受控；调用方驱动搜索） */
  value: string
  onValueChange: (value: string) => void
  /** 当前匹配序号（1-based）；null = 未知/在途（浏览器 PDF 首帧前） */
  active: number | null
  /** 匹配总数；null 同上 */
  matches: number | null
  /** 重聚焦请求（递增计数；0 起步不触发）——查找条已开时再按 Ctrl+F 用 */
  focusRequest: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export function FindBar({
  value,
  onValueChange,
  active,
  matches,
  focusRequest,
  onPrev,
  onNext,
  onClose,
}: FindBarProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  // 挂载即聚焦并全选（唤起后立即可输入替换整个词）
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  // Ctrl+F 重触发（focusRequest 变化）：重新聚焦全选——查找条开着但焦点被
  // 视图/页面抢走后再按 Ctrl+F，事件被消费须有可见效果（review 2026-09-09）
  useEffect(() => {
    if (focusRequest > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])
  const empty = value.length === 0
  const noMatch = !empty && matches === 0
  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className={"find-input mono" + (noMatch ? " no-match" : "")}
        value={value}
        spellCheck={false}
        placeholder={t.findPlaceholder}
        aria-label={t.findPlaceholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === "Enter") {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === "Escape") {
            e.preventDefault()
            // Esc 不冒泡：只关查找条，不成全局「关弹窗」语义
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <span className="find-count mono" aria-live="polite">
        {empty || active == null || matches == null
          ? t.findIdle
          : format(t.findMatchCount, { active, matches })}
      </span>
      <button type="button" className="icon-btn" title={t.findPrev} aria-label={t.findPrev} onClick={onPrev}>
        <ChevronUp size={14} aria-hidden />
      </button>
      <button type="button" className="icon-btn" title={t.findNext} aria-label={t.findNext} onClick={onNext}>
        <ChevronDown size={14} aria-hidden />
      </button>
      <button type="button" className="icon-btn" title={t.findClose} aria-label={t.findClose} onClick={onClose}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

/** findInPage 会话状态机（浏览器 Tab / PDF；viewId 由调用方给出）。
 *  返回 FindBar 所需的全套受控值与回调 + 开合态。 */
export function useWebContentsFind(viewId: number | null, tabKey: string) {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [count, setCount] = useState<{ active: number; matches: number } | null>(null)
  // 重聚焦请求计数（FindBar focusRequest prop；递增触发已开查找条重新聚焦）
  const [focusRequest, setFocusRequest] = useState(0)
  // requestId 守卫：find-start 同帧回传（main 经 browser:find-request 推送），
  // found-in-page 帧的 requestId 与之不符 = 旧请求迟到帧，丢弃
  const requestIdRef = useRef<number | null>(null)
  // 会话在途标志（review 三轮 #2）：run() 置位、close/清空/失效复位——
  // 一切 stop（close/清空/卸载兜底）仅在确有会话时发（stopFindInPage 会清
  // 页面选区：用户手动选中的文本不能因切 Tab/无会话操作被抹掉）
  const sessionRef = useRef(false)

  useEffect(() => {
    if (viewId == null) return
    const unsubs = [
      window.desktop.onBrowserFindRequest?.((payload) => {
        if (payload && payload.viewId === viewId) requestIdRef.current = payload.requestId
      }),
      window.desktop.onBrowserFindState?.((state) => {
        if (state?.viewId !== viewId) return
        // 严格相等守卫（review 二轮 #3）：无在途请求（close/reset/清空后 ref
        // 为 null）时迟到帧一律拒收——不设 null 宽免，防旧帧闪入新会话计数。
        // 合法帧的 find-request 恒先于 find-state 到达（IPC 顺序保证）
        if (state.requestId !== requestIdRef.current) return
        setCount({ active: state.active, matches: state.matches })
      }),
    ]
    return () => {
      for (const u of unsubs) u?.()
    }
  }, [viewId])

  const run = useCallback(
    (text: string, opts: { forward: boolean; findNext: boolean }) => {
      if (viewId == null || text.length === 0) return
      sessionRef.current = true
      window.desktop.browserFindStart(viewId, text, opts)
    },
    [viewId],
  )

  const openFind = useCallback(() => {
    // 原生视图持焦场景（review 三轮 #1）先收回键盘焦点：element.focus() 只是
    // renderer 文档内聚焦，不与持焦的兄弟视图竞争——焦点不回主窗口时键入
    // 落进页面，查找条呈 inert。主窗口已持焦时幂等无害
    window.desktop.browserFocusMain()
    setOpen(true)
    // 已开时重按 Ctrl+F → 计数递增触发 FindBar 重聚焦重选（未开时挂载
    // effect 自行聚焦，计数同增无害——下次重开前的重按仍正确触发）
    setFocusRequest((n) => n + 1)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setCount(null)
    requestIdRef.current = null
    // 会话闸门（同卸载兜底）：未输入即 Esc 的场景无会话——不发 stop，
    // 免得 stopFindInPage 抹掉用户手动选中的文本
    if (viewId != null && sessionRef.current) window.desktop.browserFindStop(viewId)
    sessionRef.current = false
  }, [viewId])

  const onValueChange = useCallback(
    (value: string) => {
      setQuery(value)
      if (value.length === 0) {
        // 清空 = 清除高亮与计数（保留查找条开态，用户可能接着输入）；
        // 会话闸门同 close/卸载兜底：导航 reset 后已无会话（Chromium 侧
        // 高亮随重载消失），清空不发 stop
        setCount(null)
        requestIdRef.current = null
        if (viewId != null && sessionRef.current) window.desktop.browserFindStop(viewId)
        sessionRef.current = false
        return
      }
      run(value, { forward: true, findNext: false })
    },
    [run, viewId],
  )

  const next = useCallback(() => {
    if (query.length > 0) run(query, { forward: true, findNext: true })
  }, [query, run])

  const prev = useCallback(() => {
    if (query.length > 0) run(query, { forward: false, findNext: true })
  }, [query, run])

  /** 导航/刷新清零（浏览器 Tab §2.2）：Chromium 搜索态随页面重载作废——
   *  计数清空（查询词保留供重搜），requestId 守卫复位（旧帧不再有归属）；
   *  会话标志复位（Chromium 侧已失效，卸载兜底无需再 stop） */
  const reset = useCallback(() => {
    setCount(null)
    requestIdRef.current = null
    sessionRef.current = false
  }, [])

  // 唤起注册（§2.4）：挂载即注册、卸载注销；重复注册幂等（StrictMode 双跑）。
  // viewId 未落地不注册（review 2026-09-09）——PDF 加载窗口内（view-create
  // 在途）/纯浏览器 shim（恒 -1）下 Ctrl+F 会开一个死查找条（输入 no-op、
  // 计数永不到）；shim 验收口径 = Ctrl+F 无动作
  useEffect(() => {
    if (viewId == null) return
    store.registerFindRequester(tabKey, openFind)
    return () => store.unregisterFindRequester(tabKey)
  }, [store, tabKey, openFind, viewId])

  // 卸载兜底：查找条开着且有在途会话时视图被切走/关闭——清原生高亮（视图
  // 内容仍存活，浏览器 Tab 切回重挂载；不清会残留高亮）。**会话闸门**
  //（review 三轮 #2）：无会话时不发 stop——stopFindInPage 会清页面选区，
  // 用户手动选中的文本不能因切 Tab 被抹掉
  useEffect(() => {
    return () => {
      if (viewId != null && sessionRef.current) window.desktop.browserFindStop(viewId)
    }
  }, [viewId])

  return {
    open,
    openFind,
    query,
    count,
    focusRequest,
    onValueChange,
    next,
    prev,
    close,
    reset,
  }
}

/** Ctrl+F 唤起注册（DOM 扫描视图用——markdown 预览态自带匹配模型，
 *  只需要注册回调 + 开合态；匹配状态机由调用方自持）。
 *  register = 是否参与注册（**非 markdown 文件必须 false**——PDF 文件 Tab 下
 *  FileView 与 PdfFrameView 共用 `file:` 前缀注册键，父组件后注册会覆盖子组件
 *  的 findInPage 回调，PDF Ctrl+F 即失效；代码视图 CM 自持搜索亦不注册）；
 *  active = 当前态是否可搜索（markdown 预览态且内容落地），false 时回调不动作 */
export function useFindRequester(tabKey: string, register: boolean, active: boolean, onOpen: () => void) {
  const store = useStore()
  const activeRef = useRef(active)
  const openRef = useRef(onOpen)
  activeRef.current = active
  openRef.current = onOpen
  useEffect(() => {
    if (!register) return
    store.registerFindRequester(tabKey, () => {
      if (activeRef.current) openRef.current()
    })
    return () => store.unregisterFindRequester(tabKey)
  }, [store, tabKey, register])
}