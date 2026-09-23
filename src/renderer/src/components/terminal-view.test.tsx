/**
 * 终端组件生命周期（design-terminal-tab §1.2/§1.2a）：mock xterm/FitAddon 与
 * 全局 WebSocket 假类，验证 connect-token→WS 组装、出帧 write / 控制帧 cursor
 * 锚点、onData 直发、close code 终态区分（1000 主动中断自动关 Tab / 4404 被动
 * 已退出叠加）、断开/错误态 Ctrl+D 关 Tab（closeTabInteractive 真实路径）、
 * 异常断开的退避自动重连（cursor 续传 / 无锚点 reset 全量 / focus kick / 终态不重试）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalView, isTerminalQueryResponse } from "./terminal-view"
import { ResizeObserverStub } from "./resize-observer-stub"

// xterm mock：记录 write/onData/dispose/reset；keyHandler/lastTerm 挂载时捕获
// （复制/粘贴快捷键用例直接调 handler、访问实例上的 getSelection/paste mock）
const writes: string[] = []
let resetCount = 0
let dataHandler: ((d: string) => void) | null = null
let keyHandler: ((ev: KeyboardEvent) => boolean) | null = null
let lastTerm: { getSelection: () => string; paste: (text: string) => void } | null = null
vi.mock("@xterm/xterm", () => {
  // class 而非 vi.fn+箭头 impl：`new Terminal()` 需要可构造体
  class FakeTerminal {
    rows = 24
    cols = 80
    constructor() {
      lastTerm = this
    }
    loadAddon = vi.fn()
    open = vi.fn()
    focus = vi.fn()
    write = vi.fn((d: string, cb?: () => void) => {
      writes.push(d)
      // xterm write 回调是异步的（队列渲染后），用 setTimeout 模拟
      if (cb) setTimeout(cb, 0)
    })
    writeln = vi.fn((d: string) => {
      writes.push(d + "\n")
    })
    reset = vi.fn(() => {
      resetCount++
    })
    onData = vi.fn((cb: (d: string) => void) => {
      dataHandler = cb
      return { dispose: vi.fn() }
    })
    attachCustomKeyEventHandler = vi.fn((h: (ev: KeyboardEvent) => boolean) => {
      keyHandler = h
      return true
    })
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => "")
    paste = vi.fn()
    dispose = vi.fn()
  }
  return { Terminal: FakeTerminal }
})
vi.mock("@xterm/addon-fit", () => {
  class FakeFitAddon {
    fit = vi.fn()
  }
  return { FitAddon: FakeFitAddon }
})
vi.mock("@xterm/addon-serialize", () => {
  class FakeSerializeAddon {
    serialize = vi.fn(() => "SERIALIZED_OUTPUT")
  }
  return { SerializeAddon: FakeSerializeAddon }
})
vi.mock("@xterm/xterm/css/xterm.css", () => ({}))

/** WebSocket 假类：记录 url/send，测试侧手动派发 message/open/close */
class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  url: string
  sent: string[] = []
  readyState = 0
  binaryType = ""
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((ev: Pick<CloseEvent, "code">) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
}

/** 可变 runtime 对象：markPtyExited/markPtyDisconnected 模拟 store 原位突变（真实 store 改同一引用） */
const runtimeObj: { exited: boolean; disconnected: boolean; title: string; buffer?: string } = {
  exited: false,
  disconnected: false,
  title: "bash",
}

/** platform 可变的 window.desktop 假体（复制/粘贴快捷键按 platform 区分修饰键） */
let platform: "linux" | "win32" | "darwin" | "browser" = "linux"
Object.defineProperty(window, "desktop", { get: () => ({ platform }), configurable: true })

/** navigator.clipboard 假体（复制写入/粘贴读取断言） */
const clipboard = {
  writeText: vi.fn(async (_text: string) => {}),
  readText: vi.fn(async () => "PASTED"),
}
Object.defineProperty(navigator, "clipboard", { get: () => clipboard, configurable: true })
const actions = {
  ptyConnectUrl: vi.fn(
    async (): Promise<{ url: string } | { gone: true } | null> => ({
      url: "ws://s/pty/pty_1/connect?ticket=t",
    }),
  ),
  reportPtySize: vi.fn(),
  markPtyExited: vi.fn((_id: string) => {
    runtimeObj.exited = true
  }),
  markPtyDisconnected: vi.fn((_id: string, disconnected: boolean) => {
    runtimeObj.disconnected = disconnected
  }),
  cachePtyBuffer: vi.fn((_id: string, _buf: string) => {
    runtimeObj.buffer = _buf
  }),
  ptyRuntimeFor: vi.fn(() => runtimeObj),
  closeTerminalTab: vi.fn(async (_id: string) => {}),
  requestTabCloseConfirm: vi.fn((_key: string) => {}),
  pushOverlay: vi.fn(),
  popOverlay: vi.fn(),
}
/** 断开/错误态 Ctrl+D 走真实 closeTabInteractive：storeStub 须供 tabs 实体
 *  （terminal 关闭路径按 key 查找；与 actions 分开持有——mockClear 循环只清函数） */
const terminalTab = { kind: "terminal" as const, key: "terminal:pty_1", projectId: "p1", title: "bash", directory: "/w" }
let storeStub: unknown = { ...actions, tabs: [terminalTab] }

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      terminalExited: "终端已退出",
      terminalDisconnected: "终端已断开",
      terminalReconnecting: "重连中",
      terminalCopy: "复制",
      terminalPaste: "粘贴",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

/** 建立首连并 open（fake timers 下冲刷 microtask 链）；返回 ws 与 unmount */
async function bootLive() {
  const res = render(<TerminalView ptyID="pty_1" />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  const ws = FakeWS.instances[0]!
  ws.readyState = 1
  act(() => {
    ws.onopen?.()
  })
  return { ws, unmount: res.unmount }
}

/** 0x00 控制帧（{cursor}）构造 */
function metaFrame(cursor: number): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ cursor }))
  const buf = new Uint8Array(1 + json.length)
  buf.set(json, 1)
  return buf.buffer
}

beforeEach(() => {
  ResizeObserverStub.reset()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  writes.length = 0
  resetCount = 0
  dataHandler = null
  FakeWS.instances = []
  for (const fn of Object.values(actions)) fn.mockClear()
  actions.ptyConnectUrl.mockResolvedValue({ url: "ws://s/pty/pty_1/connect?ticket=t" })
  runtimeObj.exited = false
  runtimeObj.disconnected = false
  runtimeObj.buffer = undefined
  platform = "linux"
  keyHandler = null
  lastTerm = null
  clipboard.writeText.mockClear()
  clipboard.readText.mockClear()
  clipboard.readText.mockResolvedValue("PASTED")
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = undefined
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined
})

describe("TerminalView", () => {
  it("挂载：connect-token URL 建 WS（首连不带 cursor = 全量回放）；文本帧写入终端；建连即上报尺寸", async () => {
    vi.useFakeTimers()
    await bootLive()
    const ws = FakeWS.instances[0]!
    expect(ws.url).toBe("ws://s/pty/pty_1/connect?ticket=t")
    expect(actions.ptyConnectUrl).toHaveBeenNthCalledWith(1, "pty_1", undefined)
    expect(actions.reportPtySize).toHaveBeenCalledWith("pty_1", 24, 80)
    ws.onmessage?.({ data: "hello $ " })
    expect(writes).toContain("hello $ ")
  })

  it("二进制 0x00 控制帧解析 cursor 锚点不写屏；非 0x00 二进制输出块解码写入", async () => {
    vi.useFakeTimers()
    await bootLive()
    const ws = FakeWS.instances[0]!
    const before = writes.length
    ws.onmessage?.({ data: metaFrame(42) })
    expect(writes.length).toBe(before)
    // 非 0x00 首字节的二进制块按输出写入（防御路径）
    const out = new Uint8Array(new TextEncoder().encode("out"))
    ws.onmessage?.({ data: out.buffer })
    expect(writes).toContain("out")
  })

  it("onData 直发 WS（open 态）；close code 1000（pty 自然退出 = 主动中断）→ markPtyExited + 自动关 Tab（closeTabInteractive 同款 closeTerminalTab，不呈已退出态）", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    expect(dataHandler).toBeTruthy()
    dataHandler!("ls\r")
    expect(ws.sent).toContain("ls\r")
    act(() => {
      ws.onclose?.({ code: 1000 })
    })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(actions.closeTerminalTab).toHaveBeenCalledWith("pty_1")
  })

  it("close 4404（session 不在 server：legacy not-found/exited 同码 = 被动关闭）→ markPtyExited 终态叠加、不自动关 Tab、不重连", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 4404 })
    })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(actions.closeTerminalTab).not.toHaveBeenCalled()
    expect(screen.getByText("终端已退出")).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeWS.instances.length).toBe(1)
  })

  it("live 态 Ctrl+D 归 pty（EOF 不拦截）；断开/错误态（已退出）Ctrl+D → closeTabInteractive 直关（exited 免确认）", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    const evD = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyD" })
    expect(keyHandler!(evD)).toBe(true)
    expect(actions.closeTerminalTab).not.toHaveBeenCalled()
    act(() => {
      ws.onclose?.({ code: 4404 })
    })
    const evD2 = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyD" })
    expect(keyHandler!(evD2)).toBe(false)
    expect(evD2.defaultPrevented).toBe(true)
    expect(actions.requestTabCloseConfirm).not.toHaveBeenCalled()
    expect(actions.closeTerminalTab).toHaveBeenCalledWith("pty_1")
  })

  it("重连中（disconnected 断连态）Ctrl+D → 直关不确认；Ctrl+Shift+D（带 Shift 非 EOF 语义）不受影响走 deadRelease", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 1006 })
    })
    const evD = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyD" })
    expect(keyHandler!(evD)).toBe(false)
    expect(actions.requestTabCloseConfirm).not.toHaveBeenCalled()
    expect(actions.closeTerminalTab).toHaveBeenCalledWith("pty_1")
    const evShiftD = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyD" })
    expect(keyHandler!(evShiftD)).toBe(false)
    expect(actions.closeTerminalTab).toHaveBeenCalledTimes(1)
  })

  it("连接中（首连 WS 未 OPEN）Ctrl+D → running 态走确认弹窗（requestTabCloseConfirm），不直关", async () => {
    vi.useFakeTimers()
    render(<TerminalView ptyID="pty_1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // WS 已建但未 open（readyState 0 = 连接中）
    expect(FakeWS.instances.length).toBe(1)
    const evD = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyD" })
    expect(keyHandler!(evD)).toBe(false)
    expect(evD.defaultPrevented).toBe(true)
    expect(actions.requestTabCloseConfirm).toHaveBeenCalledWith("terminal:pty_1")
    expect(actions.closeTerminalTab).not.toHaveBeenCalled()
  })

  it("异常断开（非 1000/4404）→ 重连中叠加、不 markPtyExited；退避后自动重连带 cursor 续传，成功后叠加消失", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    // meta 锚点 100 + live 帧 "out"（3 字符）→ 续传 cursor 103
    ws.onmessage?.({ data: metaFrame(100) })
    ws.onmessage?.({ data: "out" })
    act(() => {
      ws.onclose?.({ code: 1006 })
    })
    expect(actions.markPtyExited).not.toHaveBeenCalled()
    // 断连标记置位（closeTabInteractive 消费：断连态关 Tab 免确认）
    expect(actions.markPtyDisconnected).toHaveBeenLastCalledWith("pty_1", true)
    expect(runtimeObj.disconnected).toBe(true)
    expect(screen.getByText("重连中")).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(FakeWS.instances.length).toBe(2)
    expect(actions.ptyConnectUrl).toHaveBeenLastCalledWith("pty_1", 103)
    // 重连成功：退避清零（下一次断开仍从 1s 起步）、叠加消失、断连标记清除
    const ws2 = FakeWS.instances[1]!
    ws2.readyState = 1
    act(() => {
      ws2.onopen?.()
    })
    expect(screen.queryByText("重连中")).toBeNull()
    expect(actions.markPtyDisconnected).toHaveBeenLastCalledWith("pty_1", false)
    expect(runtimeObj.disconnected).toBe(false)
    act(() => {
      ws2.onclose?.({ code: 1006 })
    })
    ws2.readyState = 3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(FakeWS.instances.length).toBe(3)
  })

  it("无 cursor 锚点断开 → term.reset 清屏 + 不带 cursor 重连（防全量回放重复）", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    // 未收 meta 控制帧即断开
    ws.onmessage?.({ data: "partial" })
    ws.onclose?.({ code: 1006 })
    expect(resetCount).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(actions.ptyConnectUrl).toHaveBeenLastCalledWith("pty_1", undefined)
    expect(FakeWS.instances.length).toBe(2)
  })

  it("token 404（gone）→ markPtyExited 终态、不建 WS 不再重试", async () => {
    vi.useFakeTimers()
    actions.ptyConnectUrl.mockResolvedValue({ gone: true })
    render(<TerminalView ptyID="pty_1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(screen.getByText("终端已退出")).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeWS.instances.length).toBe(0)
  })

  it("token 瞬态失败（网络）→ 重连中叠加 + 退避后重试成功", async () => {
    vi.useFakeTimers()
    actions.ptyConnectUrl.mockResolvedValueOnce(null)
    render(<TerminalView ptyID="pty_1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(FakeWS.instances.length).toBe(0)
    expect(screen.getByText("重连中")).toBeTruthy()
    expect(actions.markPtyExited).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(FakeWS.instances.length).toBe(1)
  })

  it("focus kick：退避睡眠中窗口 focus 立即重连并重置退避", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    ws.onmessage?.({ data: metaFrame(10) })
    ws.onclose?.({ code: 1006 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(FakeWS.instances.length).toBe(1)
    fireEvent(window, new Event("focus"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(FakeWS.instances.length).toBe(2)
    expect(actions.ptyConnectUrl).toHaveBeenLastCalledWith("pty_1", 10)
  })

  it("退避中卸载：清重连定时器，不再重连", async () => {
    vi.useFakeTimers()
    const { ws, unmount } = await bootLive()
    ws.onclose?.({ code: 1006 })
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeWS.instances.length).toBe(1)
    expect(actions.ptyConnectUrl).toHaveBeenCalledTimes(1)
  })

  it("已退出的 pty 重挂载：不建 WS 直接只读态；有 buffer 缓存则还原（评审 L2）", async () => {
    runtimeObj.exited = true
    runtimeObj.buffer = "CACHED_OUTPUT"
    render(<TerminalView ptyID="pty_1" />)
    expect(await screen.findByText("终端已退出")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 10))
    expect(FakeWS.instances.length).toBe(0)
    expect(writes.join("")).toContain("CACHED_OUTPUT")
  })

  it("卸载：断 WS + dispose", async () => {
    const { unmount } = render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const ws = FakeWS.instances[0]!
    unmount()
    expect(ws.readyState).toBe(3)
  })

  it("卸载时 pty 已退出：serialize 缓存到 store（保切回可读回滚）", async () => {
    runtimeObj.exited = true
    runtimeObj.buffer = "OLD"
    const { unmount } = render(<TerminalView ptyID="pty_1" />)
    await screen.findByText("终端已退出")
    // 等 term.write 回调触发 bufferReady（xterm write 异步）
    await new Promise((r) => setTimeout(r, 10))
    unmount()
    expect(actions.cachePtyBuffer).toHaveBeenCalledWith("pty_1", "SERIALIZED_OUTPUT")
    expect(runtimeObj.buffer).toBe("SERIALIZED_OUTPUT")
  })

  it("卸载时 pty 运行中：不 serialize 缓存（重挂载靠 server 全量回放）", async () => {
    const { unmount } = render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    unmount()
    expect(actions.cachePtyBuffer).not.toHaveBeenCalled()
  })

  // —— 回放幽灵应答闸门（design-terminal-tab §1.2b，2026-09-23）——
  it("回放闸门：meta 前回放帧未排空期间丢弃 xterm 幽灵应答；用户键入照发；排空后 live 应答放行", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    // 回放帧（meta 前的输出帧 = server 回放，夹着 shell 历史 prompt 的查询）
    ws.onmessage?.({ data: "\x1b]11;?\x1b\\" })
    // xterm 解析回放流中历史查询后的自动应答（onData 视角）→ 闸门拦截
    dataHandler!("\x1b[?1;2c")
    dataHandler!("\x1b]11;rgb:1616/1b1b/1616\x1b\\")
    dataHandler!("\x1b[29;1R")
    expect(ws.sent).toEqual([])
    // 用户键入不受影响（完整应答转义模式无法逐键敲出，误杀面≈0）
    dataHandler!("q\r")
    expect(ws.sent).toEqual(["q\r"])
    // meta 帧已到但写队列未排空（xterm write 异步解析）——闸门仍拦截
    ws.onmessage?.({ data: metaFrame(7) })
    dataHandler!("\x1b[?1;2c")
    expect(ws.sent).toEqual(["q\r"])
    // 写回调触发（回放排空）→ 闸门关闭；live 期应答必须放行（fish prompt 握手依赖）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    dataHandler!("\x1b[?1;2c")
    expect(ws.sent).toEqual(["q\r", "\x1b[?1;2c"])
  })

  it("重连续传回放同样受闸门：回放帧未排空前应答丢弃，排空后放行", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    ws.onmessage?.({ data: metaFrame(100) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      ws.onclose?.({ code: 1006 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const ws2 = FakeWS.instances[1]!
    ws2.readyState = 1
    act(() => {
      ws2.onopen?.()
    })
    // 续传连接的 meta 前帧 = server 补发回放 → 闸门开
    ws2.onmessage?.({ data: "resumed-out" })
    dataHandler!("\x1b[?1;2c")
    expect(ws2.sent).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    dataHandler!("\x1b[?1;2c")
    expect(ws2.sent).toEqual(["\x1b[?1;2c"])
  })

  it("右键：弹复制/粘贴菜单；无选区时复制项禁用，粘贴项可用", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const termEl = document.querySelector(".terminal-view") as Element
    fireEvent.contextMenu(termEl, { clientX: 100, clientY: 100 })
    const pasteBtn = (await screen.findByText("粘贴")) as HTMLButtonElement
    expect(pasteBtn.disabled).toBe(false)
    // 无选区（hasSelection mock 默认 false）→ 复制项 disabled
    const copyBtn = (await screen.findByText("复制")) as HTMLButtonElement
    expect(copyBtn.disabled).toBe(true)
    // 浮层计数：菜单存在期间 pushOverlay
    expect(actions.pushOverlay).toHaveBeenCalled()
  })

  it("右键菜单：点粘贴项 → 关闭菜单（popOverlay 回调清理）", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const termEl = document.querySelector(".terminal-view") as Element
    fireEvent.contextMenu(termEl, { clientX: 50, clientY: 50 })
    const pasteItem = await screen.findByText("粘贴")
    fireEvent.click(pasteItem)
    await waitFor(() => expect(screen.queryByText("粘贴")).toBeNull())
  })

  it("右键菜单：Escape 关闭", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const termEl = document.querySelector(".terminal-view") as Element
    fireEvent.contextMenu(termEl, { clientX: 10, clientY: 10 })
    await screen.findByText("粘贴")
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByText("粘贴")).toBeNull())
  })

  it("复制/粘贴快捷键（linux）：Ctrl+Shift+C 复制选区 / Ctrl+Shift+V 粘贴；⌘C 不拦截", async () => {
    vi.useFakeTimers()
    await bootLive()
    expect(keyHandler).toBeTruthy()
    lastTerm!.getSelection = () => "SELECTED"
    const evC = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyC" })
    expect(keyHandler!(evC)).toBe(false)
    expect(evC.defaultPrevented).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith("SELECTED")
    // ⌘C 在非 darwin 平台放行（修饰键判定按 platform 区分；live 态归 xterm）
    const evCmdC = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyC" })
    expect(keyHandler!(evCmdC)).toBe(true)
    expect(evCmdC.defaultPrevented).toBe(false)
    const evV = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyV" })
    expect(keyHandler!(evV)).toBe(false)
    // fake timers 下 waitFor 不推进：flush microtask（clipboard.readText promise）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lastTerm!.paste).toHaveBeenCalledWith("PASTED")
  })

  it("复制/粘贴快捷键（macOS）：⌘C 复制选区 / ⌘V 粘贴；无选区 ⌘C 放行；Ctrl+Shift+C 放行", async () => {
    vi.useFakeTimers()
    platform = "darwin"
    await bootLive()
    // ⌘C 有选区 → 拦截复制
    lastTerm!.getSelection = () => "SELECTED"
    const evCmdC = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyC" })
    expect(keyHandler!(evCmdC)).toBe(false)
    expect(clipboard.writeText).toHaveBeenCalledWith("SELECTED")
    // ⌘C 无选区 → 放行（保留默认处理）
    lastTerm!.getSelection = () => ""
    const evCmdC2 = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyC" })
    expect(keyHandler!(evCmdC2)).toBe(true)
    // ⌘V → 粘贴剪贴板
    const evCmdV = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyV" })
    expect(keyHandler!(evCmdV)).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lastTerm!.paste).toHaveBeenCalledWith("PASTED")
    // mac 下 Ctrl+Shift+C 放行（Control 系组合归终端/PTY）
    lastTerm!.getSelection = () => "SELECTED"
    const evCsC = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyC" })
    expect(keyHandler!(evCsC)).toBe(true)
  })

  it("live 态 Ctrl+W 归 pty、Ctrl+Tab/Ctrl+Shift+Tab 释放给应用切 Tab（2026-09-10 修订，非 mac）；Alt 域四键同归 pty（readline M- 系键位保住）", async () => {
    vi.useFakeTimers()
    await bootLive()
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(true)
    // Tab 系释放：xterm 对 Tab 忽略 ctrl 修饰——Ctrl+Tab 发 \t、Ctrl+Shift+Tab
    // 发 CSI Z，与裸 Tab/Shift+Tab 同字节，无 CLI 绑定 Ctrl+Tab。false =
    // 不消费（不 preventDefault），事件冒泡到 shortcuts.ts 全局分发
    const evTab = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, key: "Tab" })
    expect(keyHandler!(evTab)).toBe(false)
    expect(evTab.defaultPrevented).toBe(false)
    const evTabS = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, key: "Tab" })
    expect(keyHandler!(evTabS)).toBe(false)
    expect(evTabS.defaultPrevented).toBe(false)
    // Ctrl+Alt+Tab 不释放（dispatch Tab 分支 !alt 守卫——不留释放却切不了的空洞）
    const evTabAlt = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, altKey: true, key: "Tab" })
    expect(keyHandler!(evTabAlt)).toBe(true)
    const evAlt = new KeyboardEvent("keydown", { cancelable: true, altKey: true, key: "ArrowDown" })
    expect(keyHandler!(evAlt)).toBe(true)
    // Alt 域（design-keyboard-shortcuts §0.2）：live 终端内 Alt+O/C/N/⌫ 归 pty
    //（ESC 前缀 → readline M-o/M-c/M-n/M-DEL），全局快捷键不生效属预期
    const evAltO = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "KeyO" })
    expect(keyHandler!(evAltO)).toBe(true)
    const evAltC = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "KeyC" })
    expect(keyHandler!(evAltC)).toBe(true)
    const evAltBs = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "Backspace" })
    expect(keyHandler!(evAltBs)).toBe(true)
  })

  it("macOS live 态 Ctrl+Tab 系不释放（mac 无 Ctrl+Tab 系绑定——切 Tab 走 ⌘⌥←/→ 惯例键，释放只丢 Tab 键入无收益）；Ctrl+W 归 pty 不变", async () => {
    vi.useFakeTimers()
    platform = "darwin"
    await bootLive()
    const evTab = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, key: "Tab" })
    expect(keyHandler!(evTab)).toBe(true)
    const evTabS = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, key: "Tab" })
    expect(keyHandler!(evTabS)).toBe(true)
    const evCmdW = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyW" })
    expect(keyHandler!(evCmdW)).toBe(true)
  })

  it("断开态不拦截应用快捷键：已退出（4404 被动终态）后 Ctrl+W/Ctrl+Tab/Ctrl+Shift+Tab 返回 false（不 preventDefault，事件冒泡到全局分发）；无修饰键仍归 xterm", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 4404 })
    })
    expect(screen.getByText("终端已退出")).toBeTruthy()
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(false)
    expect(evW.defaultPrevented).toBe(false)
    const evTab = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, key: "Tab" })
    expect(keyHandler!(evTab)).toBe(false)
    expect(evTab.defaultPrevented).toBe(false)
    // Ctrl+Shift+Tab 带 Shift（linux 下命中 mod 分支）也必须释放——切 Tab 反向
    const evTabS = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, key: "Tab" })
    expect(keyHandler!(evTabS)).toBe(false)
    expect(evTabS.defaultPrevented).toBe(false)
    // ⌘ 系同释放（mac ⌘W）；裸 Alt+↑/↓（非 mac 作用域遍历）与裸 Alt 域四键
    //（项目/worktree 管理，2026-09-06）也释放；无修饰键仍 true（xterm 键盘
    // 滚动等默认行为保留）
    const evCmdW = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyW" })
    expect(keyHandler!(evCmdW)).toBe(false)
    const evAlt = new KeyboardEvent("keydown", { cancelable: true, altKey: true, key: "ArrowDown" })
    expect(keyHandler!(evAlt)).toBe(false)
    expect(evAlt.defaultPrevented).toBe(false)
    const evAltO = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "KeyO" })
    expect(keyHandler!(evAltO)).toBe(false)
    expect(evAltO.defaultPrevented).toBe(false)
    // 裸 Alt+C 同释放（2026-09-06 修订：copy 例外须带 Ctrl/⌘ 修饰——无修饰的
    // KeyC 不再被误吞，Alt 域四键在断开态全数生效）
    const evAltC = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "KeyC" })
    expect(keyHandler!(evAltC)).toBe(false)
    expect(evAltC.defaultPrevented).toBe(false)
    // 复制例外保留：断开态 Ctrl+Shift+C（无选区）仍归 xterm（回滚选区复制路径不破）
    lastTerm!.getSelection = () => ""
    const evCopy = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyC" })
    expect(keyHandler!(evCopy)).toBe(true)
    const evAltBs = new KeyboardEvent("keydown", { cancelable: true, altKey: true, code: "Backspace" })
    expect(keyHandler!(evAltBs)).toBe(false)
    const evPlain = new KeyboardEvent("keydown", { cancelable: true, code: "KeyA" })
    expect(keyHandler!(evPlain)).toBe(true)
  })

  it("重连中（异常断开）同样释放 Ctrl 系快捷键；重连成功恢复拦截", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    ws.onmessage?.({ data: metaFrame(10) })
    act(() => {
      ws.onclose?.({ code: 1006 })
    })
    expect(screen.getByText("重连中")).toBeTruthy()
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const ws2 = FakeWS.instances[1]!
    ws2.readyState = 1
    act(() => {
      ws2.onopen?.()
    })
    const evW2 = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW2)).toBe(true)
  })

  it("断开态复制快捷键不受释放影响：已退出（4404 被动终态）Ctrl+Shift+C 有选区仍拦截复制", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 4404 })
    })
    lastTerm!.getSelection = () => "SELECTED"
    const evC = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, shiftKey: true, code: "KeyC" })
    expect(keyHandler!(evC)).toBe(false)
    expect(evC.defaultPrevented).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith("SELECTED")
  })

  it("已退出 pty 重挂载（不建 WS）即释放 Ctrl 系快捷键", async () => {
    runtimeObj.exited = true
    runtimeObj.buffer = "CACHED"
    render(<TerminalView ptyID="pty_1" />)
    await screen.findByText("终端已退出")
    expect(FakeWS.instances.length).toBe(0)
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(false)
  })
})

describe("isTerminalQueryResponse（回放幽灵应答模式，design-terminal-tab §1.2b）", () => {
  it("匹配 xterm 6.0.0 实测应答集：DA1/DA2/CPR/DECXCPR/DECRPM/DSR/DCS/OSC 颜色报告", () => {
    expect(isTerminalQueryResponse("\x1b[?1;2c")).toBe(true) // DA1（ESC[0c / ESC[c 的应答）
    expect(isTerminalQueryResponse("\x1b[>0;276;0c")).toBe(true) // DA2
    expect(isTerminalQueryResponse("\x1b[29;1R")).toBe(true) // CPR（ESC[6n 的应答）
    expect(isTerminalQueryResponse("\x1b[?1;1R")).toBe(true) // DECXCPR（ESC[?6n 的应答）
    expect(isTerminalQueryResponse("\x1b[?1;2$y")).toBe(true) // DECRPM（DECRQM 的应答）
    expect(isTerminalQueryResponse("\x1b[0n")).toBe(true) // DSR（CSI 5n 的应答）
    expect(isTerminalQueryResponse("\x1bP1$r0m\x1b\\")).toBe(true) // DECRQSS 状态应答（DCS）
    expect(isTerminalQueryResponse("\x1b]11;rgb:1616/1b1b/1616\x1b\\")).toBe(true) // OSC 11 背景报告
    expect(isTerminalQueryResponse("\x1b]10;rgb:c8d0/c8d0/c8d4\x07")).toBe(true) // OSC 10 前景报告（BEL 终止）
    expect(isTerminalQueryResponse("\x1b]4;1;rgb:111/222/333\x1b\\")).toBe(true) // OSC 4 调色板报告
  })

  it("用户键入不误杀：普通键、方向/功能键、粘贴包裹、Alt 组合、裸 ESC", () => {
    expect(isTerminalQueryResponse("q")).toBe(false)
    expect(isTerminalQueryResponse("ls -l\r")).toBe(false)
    expect(isTerminalQueryResponse("\x1b[A")).toBe(false) // 上方向键
    expect(isTerminalQueryResponse("\x1bOA")).toBe(false) // 应用光标键
    expect(isTerminalQueryResponse("\x1bOP")).toBe(false) // F1
    expect(isTerminalQueryResponse("\x1bn")).toBe(false) // Alt+n（readline M-n；n 虽入 CSI 终止类，无 [ 前缀不匹配）
    expect(isTerminalQueryResponse("\x1b[200~pasted\x1b[201~")).toBe(false) // bracketed-paste 包裹
    expect(isTerminalQueryResponse("\x1bx")).toBe(false) // Alt+x（readline M-x）
    expect(isTerminalQueryResponse("\r")).toBe(false)
    expect(isTerminalQueryResponse("\x1b")).toBe(false) // 裸 ESC 键
  })
})
