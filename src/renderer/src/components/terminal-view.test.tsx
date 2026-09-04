/**
 * 终端组件生命周期（design-terminal-tab §1.2/§1.2a）：mock xterm/FitAddon 与
 * 全局 WebSocket 假类，验证 connect-token→WS 组装、出帧 write / 控制帧 cursor
 * 锚点、onData 直发、close code 终态区分（1000/4404 已退出）、异常断开的
 * 退避自动重连（cursor 续传 / 无锚点 reset 全量 / focus kick / 终态不重试）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalView } from "./terminal-view"
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
  pushOverlay: vi.fn(),
  popOverlay: vi.fn(),
}
let storeStub = actions

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

  it("onData 直发 WS（open 态）；close code 1000 → markPtyExited + 已退出叠加", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    expect(dataHandler).toBeTruthy()
    dataHandler!("ls\r")
    expect(ws.sent).toContain("ls\r")
    act(() => {
      ws.onclose?.({ code: 1000 })
    })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(screen.getByText("终端已退出")).toBeTruthy()
  })

  it("close 4404（session 不在 server：legacy not-found/exited 同码）→ markPtyExited 终态、不重连", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 4404 })
    })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(screen.getByText("终端已退出")).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeWS.instances.length).toBe(1)
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

  it("live 态 Ctrl 系组合仍归 xterm（Ctrl+W 归 pty、Ctrl+Tab 归 pty，事件被 xterm 消费）", async () => {
    vi.useFakeTimers()
    await bootLive()
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(true)
    const evTab = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, key: "Tab" })
    expect(keyHandler!(evTab)).toBe(true)
  })

  it("断开态不拦截应用快捷键：已退出后 Ctrl+W/Ctrl+Tab 返回 false（不 preventDefault，事件冒泡到全局分发）；无修饰键仍归 xterm", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 1000 })
    })
    expect(screen.getByText("终端已退出")).toBeTruthy()
    const evW = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "KeyW" })
    expect(keyHandler!(evW)).toBe(false)
    expect(evW.defaultPrevented).toBe(false)
    const evTab = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, key: "Tab" })
    expect(keyHandler!(evTab)).toBe(false)
    expect(evTab.defaultPrevented).toBe(false)
    // ⌘ 系同释放（mac ⌘W）；无修饰键仍 true（xterm 键盘滚动等默认行为保留）
    const evCmdW = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, code: "KeyW" })
    expect(keyHandler!(evCmdW)).toBe(false)
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

  it("断开态复制快捷键不受释放影响：Ctrl+Shift+C 有选区仍拦截复制", async () => {
    vi.useFakeTimers()
    const { ws } = await bootLive()
    act(() => {
      ws.onclose?.({ code: 1000 })
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
