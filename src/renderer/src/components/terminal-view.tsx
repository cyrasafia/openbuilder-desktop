import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SerializeAddon } from "@xterm/addon-serialize"
import "@xterm/xterm/css/xterm.css"
import { useI18n, useStore } from "../app"

/**
 * 终端 Tab 内容（design-terminal-tab §1.2）：xterm.js 恒深色 + server pty WS。
 *
 * 生命周期：挂载建 Terminal（本地即可渲染）→ connect-token → WS 连接（不带
 * cursor——重挂载是全新 Terminal，server 全量回放保留 buffer）；出帧写 term
 * （0x00 控制帧跳过：cursor 供"同 buffer 重连"用，本架构不存在该场景，评审 H1）；
 * 入帧 onData 直发；ResizeObserver → fit → PUT size（trailing 去抖 200ms）；
 * 卸载断 WS + dispose（重挂载经全量回放恢复内容）。
 *
 * WS close **code 1000** = pty 自然退出 → store 标 exited（此后关闭 Tab 不再
 * DELETE——legacy 路由已 404）；**其余 code** = 异常断开 → 仅叠加"已断开"态，
 * 不标 exited（关闭 Tab 仍尝试 DELETE 防孤儿，404 容忍），评审 M2。
 * 已退出的 Tab 重挂载：不建 WS（server 侧 exited 即 404），直接呈只读态。
 */

/**
 * 恒深色主题（不接 data-theme，spec #5）。
 * 背景 = 深色 surface（#161b16），与工作区一致；前景/ANSI 16 色对齐项目
 * 语法高亮色板（tokens.css §syntax-*，GitHub dark），cursor 取 primary 绿，
 * selection 取 outline-variant 半透明——整体与项目配色协调而非独立 Catppuccin
 */
const DARK_THEME = {
  background: "#161b16",
  foreground: "#c8d0c4",
  cursor: "#98d4a3",
  cursorAccent: "#161b16",
  selectionBackground: "#41494188",
  black: "#111511",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#ffa657",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#a5d6ff",
  white: "#adb6ab",
  brightBlack: "#8b949e",
  brightRed: "#f85149",
  brightGreen: "#3fb950",
  brightYellow: "#fbbf24",
  brightBlue: "#58a6ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#a5d6ff",
  brightWhite: "#c8d0c4",
}

export function TerminalView({ ptyID }: { ptyID: string }) {
  const store = useStore()
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const runtime = store.ptyRuntimeFor(ptyID)
  const [state, setState] = useState<"connecting" | "live" | "closed">("connecting")
  // 已退出 = store 标记（自然退出，重挂载仍呈只读态）或本次连接已关闭
  const exited = !!runtime?.exited || state === "closed"
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      theme: DARK_THEME,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000,
      convertEol: false,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // 复制/粘贴快捷键（design-terminal-tab §1.4）：Ctrl+Shift+C 复制选区、
    // Ctrl+Shift+V 粘贴剪贴板。attachCustomKeyEventHandler 返回 false 即
    // 吞掉 xterm 默认处理（仅这两个组合键），返回 true 则放行其余键不受影响。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true
      if (ev.ctrlKey && ev.shiftKey && (ev.code === "KeyC" || ev.key === "C" || ev.key === "c")) {
        const sel = term.getSelection()
        if (sel) {
          ev.preventDefault()
          void navigator.clipboard?.writeText(sel).catch(() => {})
          return false
        }
        // 无选区时不拦截：保留终端对该组合键的默认处理（用户自定义 shell 键绑定等）
        return true
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.code === "KeyV" || ev.key === "V" || ev.key === "v")) {
        ev.preventDefault()
        void navigator.clipboard?.readText().then((text) => {
          if (text) term.paste(text)
        }).catch(() => {})
        return false
      }
      return true
    })
    // 打开/切换至 terminal Tab 时自动聚焦（key 隔离重挂载，mount 即获焦）
    term.focus()
    try {
      fit.fit()
    } catch {
      // host 未布局（display:none 等）——ResizeObserver 首帧再试
    }

    let disposed = false
    let resizeTimer: number | null = null
    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      // 已退出 pty 不再上报 size（server 404）
      if (store.ptyRuntimeFor(ptyID)?.exited) return
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        store.reportPtySize(ptyID, term.rows, term.cols)
      }, 200)
    }
    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    const decoder = new TextDecoder()
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    // 已退出 pty 的重挂载：write 缓存到 term 后标记 ready，
    // cleanup 时仅在 write 完成后才 serialize（xterm write 是异步队列）
    let bufferReady = false
    const openWs = async () => {
      // 已退出的 pty 不再连接（server legacy 路由 exited 即 404）；
      // 但若有 client 侧序列化缓存（上次卸载前缓存），还原 buffer 保回滚
      const rt = store.ptyRuntimeFor(ptyID)
      if (rt?.exited) {
        setState("closed")
        if (rt.buffer) {
          term.write(rt.buffer, () => {
            bufferReady = true
          })
        } else {
          bufferReady = true
        }
        return
      }
      const url = await store.ptyConnectUrl(ptyID)
      if (disposed) return
      if (!url) {
        setState("closed")
        term.writeln(`\r\n\x1b[31m${t.terminalConnectFailed}\x1b[0m`)
        return
      }
      const ws = new WebSocket(url)
      ws.binaryType = "arraybuffer"
      wsRef.current = ws
      ws.onopen = () => {
        if (disposed) return
        setState("live")
        // 建连即同步一次尺寸（pty 创建时是 server 默认 size）
        store.reportPtySize(ptyID, term.rows, term.cols)
      }
      ws.onmessage = (ev) => {
        if (disposed) return
        if (typeof ev.data === "string") {
          term.write(ev.data)
          return
        }
        // 二进制帧 = 0x00 控制帧（{cursor}）：跳过不写屏（见头注释）
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array()
        if (buf.length > 0 && buf[0] !== 0) {
          term.write(decoder.decode(buf))
        }
      }
      ws.onclose = (ev) => {
        if (disposed) return
        setState("closed")
        bufferReady = true
        // 1000 = pty 自然退出（server onEnd 主动关）；其余 = 异常断开——
        // 不标 exited，关闭 Tab 时仍尝试 DELETE 防孤儿
        if (ev.code === 1000) store.markPtyExited(ptyID)
      }
    }
    void openWs()

    return () => {
      disposed = true
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      observer.disconnect()
      wsRef.current?.close()
      wsRef.current = null
      // 已退出 pty 的 serialize 遍历 scrollback 可能阻塞 Tab 切换渲染。
      // 延迟到空闲帧：切 Tab 立即完成，serialize + dispose 在原 term 仍持
      // buffer 期间跑（dispose 推迟到回调内）。延迟 dispose 对运行中 pty
      // 也安全（WS 已断、观察者已拆）。兜底 1s 防空闲帧不触发。
      const rt = store.ptyRuntimeFor(ptyID)
      const needSerialize = !!rt?.exited && bufferReady
      const ric = (window as unknown as {
        requestIdleCallback?: (cb: IdleRequestCallback) => number
      }).requestIdleCallback
      let done = false
      const finalize = () => {
        if (done) return
        done = true
        if (needSerialize) {
          try {
            store.cachePtyBuffer(ptyID, serialize.serialize())
          } catch {
            // dispose 边界异常不阻断
          }
        }
        term.dispose()
      }
      if (needSerialize && ric) {
        ric(() => finalize())
        window.setTimeout(finalize, 1000)
      } else {
        finalize()
      }
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyID])

  // 输入：live 态直发（closed 后 onData 仍挂——send 到已关 WS 无害）
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const d = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
    })
    return () => d.dispose()
  }, [ptyID])

  const onContextMenu = (e: React.MouseEvent) => {
    // 终端右键：阻止 xterm 默认（其内置无菜单），弹复制/粘贴菜单
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div className="terminal-view" onMouseDown={() => termRef.current?.focus()} onContextMenu={onContextMenu}>
      <div ref={hostRef} className="terminal-host" />
      {exited && (
        <div className={`terminal-exited-overlay ${runtime?.exited ? "is-exited" : "is-disconnected"}`}>
          <span>{runtime?.exited ? t.terminalExited : t.terminalDisconnected}</span>
        </div>
      )}
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          hasSelection={() => !!termRef.current?.hasSelection()}
          onCopy={() => {
            const sel = termRef.current?.getSelection() ?? ""
            if (sel) void navigator.clipboard?.writeText(sel).catch(() => {})
          }}
          onPaste={() => {
            void navigator.clipboard
              ?.readText()
              .then((text) => {
                if (text) termRef.current?.paste(text)
              })
              .catch(() => {})
          }}
        />
      )}
    </div>
  )
}

/**
 * 终端右键菜单（design-terminal-tab §1.4）：复用 FileContextMenu 模式
 * （首帧隐藏测量钳制 + capture 四触发关闭 + 浮层计数 z-order）。
 * 复制 = 选区写入剪贴板；粘贴 = 读剪贴板 term.paste。
 */
function TerminalContextMenu({
  x,
  y,
  onClose,
  hasSelection,
  onCopy,
  onPaste,
}: {
  x: number
  y: number
  onClose: () => void
  hasSelection: () => boolean
  onCopy: () => void
  onPaste: () => void
}) {
  const { t } = useI18n()
  const store = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [sel, setSel] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 首帧隐藏渲染供测量，再钳制到视口内定位（同 Popover 无闪烁模式）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)),
    })
    setSel(hasSelection())
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 浮层计数（design-browser-tab §1.2 z-order）：菜单存在期间隐藏浏览器视图
  useEffect(() => {
    store.pushOverlay()
    return () => store.popOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部 mousedown / Esc / 滚动 / 失焦关闭（capture 阶段；回调走 ref 免重订阅）
  useEffect(() => {
    const outside = (target: EventTarget | null) => !ref.current?.contains(target as Node)
    const onDown = (e: MouseEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onBlur = () => onCloseRef.current()
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("wheel", onWheel, true)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("wheel", onWheel, true)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  const run = (action: () => void) => {
    onClose()
    action()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === "ArrowDown" ? (idx + 1) % items.length : idx <= 0 ? items.length - 1 : idx - 1
    items[next].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="popover context-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <button
        className="context-menu-item"
        disabled={!sel}
        onClick={() => run(onCopy)}
      >
        {t.terminalCopy}
      </button>
      <button className="context-menu-item" onClick={() => run(onPaste)}>
        {t.terminalPaste}
      </button>
    </div>,
    document.body,
  )
}
