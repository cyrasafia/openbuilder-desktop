/**
 * 终端组件生命周期（design-terminal-tab §1.2）：mock xterm/FitAddon 与全局
 * WebSocket 假类，验证 connect-token→WS 组装、出帧 write / 控制帧 cursor、
 * onData 直发、close → 已退出叠加态。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalView } from "./terminal-view"
import { ResizeObserverStub } from "./resize-observer-stub"

// xterm mock：记录 write/onData/dispose
const writes: string[] = []
let dataHandler: ((d: string) => void) | null = null
vi.mock("@xterm/xterm", () => {
  // class 而非 vi.fn+箭头 impl：`new Terminal()` 需要可构造体
  class FakeTerminal {
    rows = 24
    cols = 80
    loadAddon = vi.fn()
    open = vi.fn()
    focus = vi.fn()
    write = vi.fn((d: string) => {
      writes.push(d)
    })
    writeln = vi.fn((d: string) => {
      writes.push(d + "\n")
    })
    onData = vi.fn((cb: (d: string) => void) => {
      dataHandler = cb
      return { dispose: vi.fn() }
    })
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

/** 可变 runtime 对象：markPtyExited 模拟 store 原位突变（真实 store 改同一引用） */
const runtimeObj: { exited: boolean; title: string } = { exited: false, title: "bash" }
const actions = {
  ptyConnectUrl: vi.fn(async (): Promise<string | null> => "ws://s/pty/pty_1/connect?ticket=t"),
  reportPtySize: vi.fn(),
  markPtyExited: vi.fn((_id: string) => {
    runtimeObj.exited = true
  }),
  ptyRuntimeFor: vi.fn(() => runtimeObj),
}
let storeStub = actions

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      terminalExited: "终端已退出",
      terminalDisconnected: "终端已断开",
      terminalConnectFailed: "终端连接失败",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

beforeEach(() => {
  ResizeObserverStub.reset()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  writes.length = 0
  dataHandler = null
  FakeWS.instances = []
  for (const fn of Object.values(actions)) fn.mockClear()
  actions.ptyConnectUrl.mockResolvedValue("ws://s/pty/pty_1/connect?ticket=t")
  runtimeObj.exited = false
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = undefined
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined
})

describe("TerminalView", () => {
  it("挂载：connect-token URL 建 WS；文本帧写入终端；建连即上报尺寸", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const ws = FakeWS.instances[0]!
    expect(ws.url).toBe("ws://s/pty/pty_1/connect?ticket=t")
    ws.readyState = 1
    ws.onopen?.()
    expect(actions.reportPtySize).toHaveBeenCalledWith("pty_1", 24, 80)
    ws.onmessage?.({ data: "hello $ " })
    expect(writes).toContain("hello $ ")
  })

  it("二进制 0x00 控制帧跳过不写屏；非 0x00 二进制输出块解码写入", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const ws = FakeWS.instances[0]!
    const enc = new TextEncoder()
    // 控制帧 = 0x00 + JSON{cursor}：不写屏（cursor 消费方不存在，评审 H1）
    const json = enc.encode(JSON.stringify({ cursor: 42 }))
    const ctrl = new Uint8Array(1 + json.length)
    ctrl.set(json, 1)
    const before = writes.length
    ws.onmessage?.({ data: ctrl.buffer })
    expect(writes.length).toBe(before)
    // 非 0x00 首字节的二进制块按输出写入（防御路径）
    const out = new Uint8Array(enc.encode("out"))
    ws.onmessage?.({ data: out.buffer })
    expect(writes).toContain("out")
  })

  it("onData 直发 WS（open 态）；close code 1000 → markPtyExited + 已退出叠加", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(dataHandler).toBeTruthy())
    const ws = FakeWS.instances[0]!
    ws.readyState = 1
    dataHandler!("ls\r")
    expect(ws.sent).toContain("ls\r")
    ws.onclose?.({ code: 1000 })
    expect(actions.markPtyExited).toHaveBeenCalledWith("pty_1")
    expect(await screen.findByText("终端已退出")).toBeTruthy()
  })

  it("异常断开（非 1000）→ 已断开叠加、不 markPtyExited（关闭时仍可 DELETE，评审 M2）", async () => {
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    FakeWS.instances[0]!.onclose?.({ code: 1006 })
    expect(actions.markPtyExited).not.toHaveBeenCalled()
    expect(await screen.findByText("终端已断开")).toBeTruthy()
  })

  it("已退出的 pty 重挂载：不建 WS 直接只读态（评审 L2）", async () => {
    runtimeObj.exited = true
    render(<TerminalView ptyID="pty_1" />)
    expect(await screen.findByText("终端已退出")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 10))
    expect(FakeWS.instances.length).toBe(0)
    expect(writes.join("")).not.toContain("终端连接失败")
  })

  it("connect-token 失败：错误行写入，不建 WS", async () => {
    actions.ptyConnectUrl.mockResolvedValue(null)
    render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(writes.join("")).toContain("终端连接失败"))
    expect(FakeWS.instances.length).toBe(0)
  })

  it("卸载：断 WS + dispose", async () => {
    const { unmount } = render(<TerminalView ptyID="pty_1" />)
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    const ws = FakeWS.instances[0]!
    unmount()
    expect(ws.readyState).toBe(3)
  })
})
