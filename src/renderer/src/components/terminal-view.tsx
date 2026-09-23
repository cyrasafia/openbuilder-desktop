import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SerializeAddon } from "@xterm/addon-serialize"
import "@xterm/xterm/css/xterm.css"
import { useI18n, useStore } from "../app"
import { closeTabInteractive } from "./tab-actions"

/**
 * 终端 Tab 内容（design-terminal-tab §1.2）：xterm.js 恒深色 + server pty WS。
 *
 * 生命周期：挂载建 Terminal（本地即可渲染）→ connect-token → WS 连接（首连
 * 不带 cursor = server 全量回放）；出帧写 term，0x00 控制帧（{cursor}）解析为
 * 续传锚点不写屏，其后 live 帧按长度累计锚点（与 server cursor 同口径）；
 * 入帧 onData 直发；ResizeObserver → fit → PUT size（trailing 去抖 200ms）；
 * 卸载断 WS + dispose（重挂载经全量回放恢复内容）。
 *
 * 自动重连（design-terminal-tab §1.2a）：异常断开（close code 非 1000/4404、
 * token 瞬态失败）按 SSE 同款退避 1→2→4→8→16→30s 封顶重试，成功清零；窗口
 * focus kick（openbuilder design-sse-reconnect-recovery 的 resume 语义）。
 * 重连带 cursor 增量续传（同一 term 只补写缺失输出）；无锚点断开则 reset
 * 清屏走全量回放（防重复）。终态（2026-09-22 修订，同一般终端模拟器）：
 * close **1000** = pty 自然退出（live 终端内 Ctrl+D/exit 的主动中断）→ 标
 * exited + **自动关 Tab**（先标 exited 令 closeTerminalTab 跳过 DELETE——
 * pty 已亡；关栈 Ctrl+Shift+T 原目录新建）；**4404** = session 不在 server
 * （legacy 路由 not-found/exited 同码）、token 404 = pty 已被回收 = **被动
 * 关闭** → 仅标 exited 呈只读终止态（Tab 保持可回滚，此后关 Tab 不再
 * DELETE——404 容忍，评审 M2）。切走/退避期间退出的自然退出客户端无法与
 * server 回收区分——落 404/4404 被动路径呈终止态。断开/错误态 Ctrl+D =
 * 关 Tab（§1.4，closeTabInteractive 与 Ctrl+W/Tab 栏 X 单一路径）。
 * 已退出的 Tab 重挂载：不建 WS（server 侧 exited 即 404），直接呈只读态。
 *
 * 回放幽灵应答闸门（design-terminal-tab §1.2b，2026-09-23）：重挂载/重连的
 * 全量回放把 shell 历史 prompt 的终端查询重放进新 xterm，xterm 自动应答经
 * onData 注入 pty 会被读屏态的 less/more 逐键回显成乱码并逐次累积——回放
 * 写队列未排空期间丢弃匹配应答模式的 onData（isTerminalQueryResponse），
 * live 期应答照常放行（fish prompt 握手依赖）。
 */

/**
 * 恒深色主题（不接 data-theme，spec #5）。
 * 背景 = 深色 surface（#161b16），与工作区一致；前景/ANSI 16 色对齐项目
 * 语法高亮色板（tokens.css §syntax-*，GitHub dark），cursor 取 primary 绿，
 * selection 对齐全局 ::selection idiom（primary 26% 淡染，#98d4a342 =
 * #98d4a3 @26%，tokens.css；原 outline-variant #41494188，2026-09-18 修订
 * 统一——整体与项目配色协调而非独立 Catppuccin
 */
const DARK_THEME = {
  background: "#161b16",
  foreground: "#c8d0c4",
  cursor: "#98d4a3",
  cursorAccent: "#161b16",
  selectionBackground: "#98d4a342",
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

/**
 * 断线重连退避序列（design-terminal-tab §1.2a）：与 SSE 订阅器同款
 * （来源 openbuilder design-sse-reconnect-recovery），封顶 30s 稳态重试
 */
const BACKOFF_SEQUENCE = [1, 2, 4, 8, 16, 30]

/**
 * xterm.js 对终端查询的自动应答模式（design-terminal-tab §1.2b，2026-09-23）。
 * 回放期间 onData 出现的这类**完整转义序列**只可能是 xterm 解析回放流中历史
 * 查询（shell 每条 prompt 发的 OSC 11;? / CSI 6n / CSI 0c，实测 fish 三件套）
 * 后的自动应答，不是用户键入——ESC 打头的完整应答无法逐键敲出，粘贴经
 * bracketed-paste 包裹（CSI 200~…201~）也不匹配 ^…$：
 * - CSI [?>=]?…c —— DA1/DA2/DA3（ESC[?1;2c、ESC[>0;276;0c）
 * - CSI [?]…R —— CPR/DECXCPR（ESC[29;1R）；CSI [?]…$y —— DECRPM（DECRQM 应答）
 * - CSI …n —— DSR 应答（ESC[0n，CSI 5n 的应答）
 * - DCS …ST —— DECRQSS/XTGETTCAP 状态应答（ESC P1$r0m ESC\；XTWINOPS 18 应答
 *   需 windowOptions 开启，本应用未开，实测不产生）
 * - OSC 4/10/11/12 颜色报告（ESC]11;rgb:1616/1b1b/1616 = 主题背景色序列化，
 *   xterm 6.0.0 该应答仅在 open 后经 _themeService 生效）
 */
const TERMINAL_RESPONSE_PATTERNS: readonly RegExp[] = [
  /^\x1b\[[?>=]?[0-9;]*[cRn]$/,
  /^\x1b\[\??[0-9;]*\$y$/,
  /^\x1bP[^\x1b]*\x1b\\$/,
  /^\x1b\]\d+(?:;\d+)?;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)?$/,
]

/** onData 数据是否为 xterm 终端查询自动应答（供回放闸门识别幽灵应答） */
export function isTerminalQueryResponse(data: string): boolean {
  return TERMINAL_RESPONSE_PATTERNS.some((re) => re.test(data))
}

export function TerminalView({ ptyID }: { ptyID: string }) {
  const store = useStore()
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // 回放闸门状态（design-terminal-tab §1.2b）：主 effect 写、输入 effect 读。
  // 对象按 effect 运行重建——卸载后残留的迟到写回调递减的是旧对象，不污染
  // 下一轮（React StrictMode 双挂载/重连同 ptyID 重跑 effect 同理）
  const replayGateRef = useRef({ pending: 0 })
  const runtime = store.ptyRuntimeFor(ptyID)
  const [state, setState] = useState<"connecting" | "live" | "reconnecting" | "closed">("connecting")
  // 已退出 = store 标记（自然退出/session 不在，重挂载仍呈只读态）或本次连接已终结
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

    // 复制/粘贴快捷键（design-terminal-tab §1.4）：macOS 依系统习惯 ⌘C/⌘V；
    // 其余平台（linux/win32/浏览器开发态）Ctrl+Shift+C/V——裸 Ctrl+C 是 SIGINT
    // 不可占用，故需 Shift 区分。attachCustomKeyEventHandler 返回 false 即
    // 吞掉 xterm 默认处理（仅命中组合键），返回 true 则放行其余键不受影响。
    const mac = window.desktop.platform === "darwin"
    // 无 live 连接（连接中/重连中/已退出/已断开——无 OPEN 的 WS）时不消费
    // Ctrl/⌘ 系组合与裸 Alt+↑/↓（非 mac 作用域遍历，shortcuts §3）及裸 Alt 域
    // 四键 O/C/N/⌫（项目/worktree 管理，shortcuts §1.2，2026-09-06；mac ⌘⌥ 系
    // 经下方 ctrl/meta 判定本就释放）：xterm 对这类键 preventDefault+
    // stopPropagation（textarea 上 capture），全局分发（shortcuts.ts）收不到事件，
    // Ctrl+W/Tab/Shift+Tab 等被无声吞掉而按键本就无处可去（onData 只发 OPEN 态
    // WS）；返回 true = 释放给应用快捷键。覆盖含 Shift 的 mod 组合（Ctrl+Shift+Tab
    // 也释放），仅复制/粘贴组合例外——断开态仍可复制回滚选区（§1.4）。例外须
    // 带 Ctrl/⌘ 修饰（2026-09-06 修订）：裸 Alt+C 是 Alt 域键（关激活 entry），
    // 无修饰不属复制语义，不得被 code===KeyC 误吞。无修饰键不释放（键盘滚动等
    // xterm 默认行为保留，产生的 onData 发不出去无害）
    const deadRelease = (ev: KeyboardEvent): boolean => {
      const altArrow =
        ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")
      const altFamily =
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        (ev.code === "KeyO" ||
          ev.code === "KeyC" ||
          ev.code === "KeyN" ||
          ev.code === "Backspace")
      if (!ev.ctrlKey && !ev.metaKey && !altArrow && !altFamily) return false
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) return false
      const copyPasteMods = ev.ctrlKey || ev.metaKey
      const isCopyKey = copyPasteMods && (ev.code === "KeyC" || ev.key === "C" || ev.key === "c")
      const isPasteKey = copyPasteMods && (ev.code === "KeyV" || ev.key === "V" || ev.key === "v")
      return !isCopyKey && !isPasteKey
    }
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true
      // 断开/错误态 Ctrl+D 关 Tab（2026-09-22）：无 OPEN WS 时 EOF 无处可发，
      // 拦截为关闭入口走 closeTabInteractive（与 Ctrl+W/Tab 栏 X 单一语义；
      // exited/disconnected 免确认直关，连接中则按 running 走确认）。live 态
      // 不拦——Ctrl+D 是 EOF 归 pty，shell 退出 → WS close 1000 → onclose
      // 自动关 Tab（终端模拟器惯例）。排除 Shift/Alt/meta：Ctrl+Shift+D 等
      // 修饰组合不属 EOF 语义（live 态发 0x04 之外的转义序列归 pty）
      if (
        ev.ctrlKey &&
        !ev.shiftKey &&
        !ev.altKey &&
        !ev.metaKey &&
        (ev.code === "KeyD" || ev.key === "d" || ev.key === "D")
      ) {
        const ws = wsRef.current
        if (!(ws && ws.readyState === WebSocket.OPEN)) {
          const tab = store.tabs.find((t) => t.key === `terminal:${ptyID}`)
          if (tab) {
            ev.preventDefault()
            closeTabInteractive(store, tab)
            return false
          }
        }
      }
      if (deadRelease(ev)) return false
      // live 态切 Tab 释放（2026-09-10 修订，design-terminal-tab §1.4）：xterm
      // 对 Tab 类按键忽略 ctrl 修饰——Ctrl+Tab 发 \t、Ctrl+Shift+Tab 发 CSI Z，
      // 与裸 Tab/Shift+Tab 字节相同（CLI 无法感知 ctrl 是否按下），且无主流
      // CLI 绑定 Ctrl+Tab，释放给应用切 Tab 零损失。仅非 mac：mac 无
      // Ctrl+Tab 系绑定（切 Tab 走 ⌘⌥←/→ 惯例键，shortcuts §1），释放只丢
      // Tab 键入无收益。Ctrl+W（readline backward-kill-word、vim 窗口前缀、
      // nano 搜索、emacs kill-region）与 Ctrl+PgUp/PgDn 维持归 pty。排除
      // alt/meta：Ctrl+Alt+Tab 非 dispatch 的 Tab 分支（!alt 守卫），不放行
      // 才不留"释放了却切不了 Tab"的空洞
      if (!mac && ev.key === "Tab" && ev.ctrlKey && !ev.altKey && !ev.metaKey) return false
      const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && ev.shiftKey
      if (!mod) return true
      if (ev.code === "KeyC" || ev.key === "C" || ev.key === "c") {
        const sel = term.getSelection()
        if (sel) {
          ev.preventDefault()
          void navigator.clipboard?.writeText(sel).catch(() => {})
          return false
        }
        // 无选区时不拦截：保留终端对该组合键的默认处理（用户自定义 shell 键绑定等）
        return true
      }
      if (ev.code === "KeyV" || ev.key === "V" || ev.key === "v") {
        ev.preventDefault()
        void navigator.clipboard?.readText().then((text) => {
          if (text) term.paste(text)
        }).catch(() => {})
        return false
      }
      return true
    })
    // IME 组字期间隐藏光标块（画布绘制，CSS 不可达；transparent 不被 xterm
    // 颜色解析接受会回退白色）：光标色画成背景色即隐身，cursorAccent 对齐
    // 前景色保证光标下字符仍正常显示，避免预编辑首字符被光标遮挡
    const imeTextarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
    const onCompositionStart = () => {
      term.options.theme = {
        ...DARK_THEME,
        cursor: DARK_THEME.background,
        cursorAccent: DARK_THEME.foreground,
      }
    }
    const onCompositionEnd = () => {
      term.options.theme = DARK_THEME
    }
    imeTextarea?.addEventListener("compositionstart", onCompositionStart)
    imeTextarea?.addEventListener("compositionend", onCompositionEnd)
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
    // —— 断线重连运行时（§1.2a）——
    let retryTimer: number | null = null
    let backoffIdx = 0
    // 绝对输出游标（0x00 控制帧 {cursor} 为锚点，其后 live 帧按长度累计，
    // 与 server session.cursor 同口径）：null = 尚未收到锚点——此时断开
    // 重连必须 term.reset() + 全量回放，否则重放内容与已写屏内容重复
    let cursor: number | null = null

    const scheduleReconnect = () => {
      if (disposed) return
      setState("reconnecting")
      // 断连标记（closeTabInteractive 消费）：断连态关 Tab 免二次确认
      store.markPtyDisconnected(ptyID, true)
      const delay = BACKOFF_SEQUENCE[Math.min(backoffIdx, BACKOFF_SEQUENCE.length - 1)]!
      backoffIdx++
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        void connect()
      }, delay * 1000)
    }

    const connect = async () => {
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
      // —— 回放幽灵应答闸门（design-terminal-tab §1.2b，2026-09-23）——
      // 重挂载/重连不带（或带 cursor 的）回放把 shell 历史 prompt 的终端查询
      // （fish 每条 prompt：OSC 11;? + CSI 6n + CSI 0c）重放进新 xterm，xterm
      // 自动应答经 onData → ws.send 注入 pty——打在读屏态的 less/more 上被逐
      // 键回显成乱码（应答按帧分离到达，前台程序无法重组转义序列），且回显
      // 会进 server buffer 随下次回放复现、逐次累积。闸门：meta 帧前的输出帧
      // 是回放，经带回调的 write 计数未排空期间，输入 effect 丢弃匹配应答模式
      // 的 onData。live 期（回放排空后）应答必须放行——fish prompt 握手依赖
      // 即时应答（实测无应答则阻塞等待）。写回调先于计数递减不会漏拦：解析
      // 在回调前同步完成，最后一块的应答发出时计数仍 >0；live 帧在回放之后
      // 排队，处理时计数已归零，其查询的应答不受影响
      const gate = { pending: 0 }
      replayGateRef.current = gate
      let metaSeen = false
      const writeOutput = (text: string) => {
        if (metaSeen) {
          term.write(text)
          return
        }
        gate.pending++
        term.write(text, () => {
          gate.pending--
        })
      }
      const res = await store.ptyConnectUrl(ptyID, cursor ?? undefined)
      if (disposed) return
      if (res && "gone" in res) {
        // 404 = pty 已不在 server（退出回收 / server 重启内存态丢失）——终态
        setState("closed")
        store.markPtyExited(ptyID)
        return
      }
      if (!res) {
        // token 瞬态失败（网络/未连接）：退避重试，不写入错误行——重连成功后
        // 本地写屏内容会永久留在 scrollback（cursor 续传只补 server 侧输出）
        scheduleReconnect()
        return
      }
      const ws = new WebSocket(res.url)
      ws.binaryType = "arraybuffer"
      wsRef.current = ws
      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return
        backoffIdx = 0
        setState("live")
        store.markPtyDisconnected(ptyID, false)
        // 建连即同步一次尺寸（server 会话保留断线前 size，视图可能已变）
        store.reportPtySize(ptyID, term.rows, term.cols)
      }
      ws.onmessage = (ev) => {
        if (disposed || wsRef.current !== ws) return
        if (typeof ev.data === "string") {
          writeOutput(ev.data)
          if (cursor != null) cursor += ev.data.length
          return
        }
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array()
        if (buf.length === 0) return
        // 二进制帧：0x00 控制帧（{cursor}）更新续传锚点不写屏；其余按输出写屏
        if (buf[0] === 0) {
          try {
            const meta = JSON.parse(decoder.decode(buf.subarray(1))) as { cursor?: unknown }
            if (typeof meta.cursor === "number" && Number.isSafeInteger(meta.cursor)) {
              cursor = meta.cursor
            }
          } catch {
            // 残缺控制帧：保留旧锚点（无锚点则重连退化为 reset + 全量回放）
          }
          // 控制帧 = server 回放终点（契约：replay → meta → live，见 §1.2）；
          // 其后帧走无回调直写（live 期闸门常开）
          metaSeen = true
          return
        }
        const text = decoder.decode(buf)
        writeOutput(text)
        if (cursor != null) cursor += text.length
      }
      ws.onclose = (ev) => {
        if (disposed || wsRef.current !== ws) return
        setState(ev.code === 1000 || ev.code === 4404 ? "closed" : "reconnecting")
        bufferReady = true
        wsRef.current = null
        // 1000 = pty 自然退出（server onEnd 主动关）——live 终端内 Ctrl+D/exit
        // 的**主动中断**：同一般终端模拟器自动关 Tab。先标 exited 再关（exited
        // 令 closeTerminalTab 跳过 DELETE——pty 已亡；closeTab 清 pendingTabClose
        // 兜底弹窗在途场景；关栈可 Ctrl+Shift+T 原目录新建）。4404 = session 不在
        // server = **被动关闭**（server 重启/回收/切走期间退出）→ 仅标 exited 呈
        // 只读终止态（此后关 Tab 不再 DELETE——404 容忍，评审 M2）；其余 = 异常
        // 断开 → 退避重连，不标 exited（关闭 Tab 仍尝试 DELETE 防孤儿，评审 M2）
        if (ev.code === 1000) {
          store.markPtyExited(ptyID)
          void store.closeTerminalTab(ptyID)
          return
        }
        if (ev.code === 4404) {
          store.markPtyExited(ptyID)
          return
        }
        if (cursor == null) term.reset()
        scheduleReconnect()
      }
    }
    void connect()

    // 窗口 focus kick（openbuilder resume 语义）：退避睡眠中立即重试并重置
    // 退避——断网恢复/系统挂起后不用等满 30s 稳态；建连尝试在途时不打扰
    const onFocusKick = () => {
      if (disposed || retryTimer == null) return
      window.clearTimeout(retryTimer)
      retryTimer = null
      backoffIdx = 0
      void connect()
    }
    window.addEventListener("focus", onFocusKick)

    return () => {
      disposed = true
      imeTextarea?.removeEventListener("compositionstart", onCompositionStart)
      imeTextarea?.removeEventListener("compositionend", onCompositionEnd)
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      if (retryTimer != null) window.clearTimeout(retryTimer)
      window.removeEventListener("focus", onFocusKick)
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
      // 回放幽灵应答闸门（design-terminal-tab §1.2b）：回放写队列未排空期间
      // 丢弃 xterm 对回放流中历史查询的自动应答（完整转义模式用户物理敲不
      // 出、粘贴有 bracketed-paste 包裹，误杀面≈0）；live 期照常放行
      if (replayGateRef.current.pending > 0 && isTerminalQueryResponse(data)) return
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
      {!exited && state === "reconnecting" && (
        <div className="terminal-exited-overlay is-reconnecting">
          <span>{t.terminalReconnecting}</span>
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
