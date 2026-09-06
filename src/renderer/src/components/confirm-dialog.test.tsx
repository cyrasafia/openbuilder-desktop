/**
 * 确认弹窗键测试（design-keyboard-shortcuts §4.1，2026-09-06）：
 * Enter 确认 / Esc 取消；loading 中两键无效；Enter 拦截聚焦钮（取消）的原生
 * 激活改道确认；onConfirm Promise 完成后 onClose 收尾。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfirmDialog } from "./confirm-dialog"

afterEach(cleanup)

const store = {
  pushOverlay: vi.fn(),
  popOverlay: vi.fn(),
}

vi.mock("../app", () => ({
  useI18n: () => ({ t: { deletingWorkspace: "删除中…" } }),
  useStore: () => store,
}))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function mount(onConfirm: () => void | Promise<void>, onClose: () => void) {
  return render(
    <ConfirmDialog
      title="删除工作区"
      message="确认删除？"
      confirmLabel="删除"
      cancelLabel="取消"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  )
}

function pressKey(key: string, repeat = false) {
  // 焦点在取消钮（focus-on-mount），keydown 冒泡到 dialog 容器 onKeyDown
  fireEvent.keyDown(screen.getByText("取消"), { key, repeat })
}

const onConfirm = vi.fn(() => {})
const onClose = vi.fn(() => {})

beforeEach(() => {
  store.pushOverlay.mockClear()
  store.popOverlay.mockClear()
  onConfirm.mockClear()
  onClose.mockClear()
})

describe("ConfirmDialog 键盘操作", () => {
  it("Enter = 确认（拦截聚焦取消钮的原生激活），同步 onConfirm 完成后 onClose 收尾", async () => {
    mount(onConfirm, onClose)
    pressKey("Enter")
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // 同步 onConfirm：完成后 onClose 收尾（弹窗即关，进度由调用方承载）
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("Esc 直接取消，不触发确认", () => {
    mount(onConfirm, onClose)
    pressKey("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("loading（onConfirm Promise 在途）中 Enter/Esc 均无效，防重复提交/误关", async () => {
    const d = deferred<void>()
    mount(
      () =>
        new Promise<void>((resolve) => {
          onConfirm()
          void d.promise.then(resolve)
        }),
      onClose,
    )
    pressKey("Enter")
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // loading 中：Enter 不重复提交、Esc 不关
    pressKey("Enter", true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    pressKey("Escape")
    expect(onClose).not.toHaveBeenCalled()
    d.resolve()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("Enter repeat（按住连发）不重复提交", async () => {
    mount(onConfirm, onClose)
    pressKey("Enter")
    pressKey("Enter", true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("overlay 计数：挂载 push、卸载 pop", async () => {
    const { unmount } = mount(onConfirm, onClose)
    expect(store.pushOverlay).toHaveBeenCalledTimes(1)
    unmount()
    expect(store.popOverlay).toHaveBeenCalledTimes(1)
    await act(async () => {})
  })
})
