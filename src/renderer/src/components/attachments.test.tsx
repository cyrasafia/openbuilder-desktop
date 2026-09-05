/**
 * 附件组件测试（design-session-attachments §7）：chips 渲染删除/气泡缩略图
 * 点击放大/userImageParts 分流/粘贴入口。mock ../app 与 window.desktop。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AttachmentChips, AttachmentThumb, useAttachmentInput, userImageParts } from "./attachments"
import type { Attachment } from "@shared/attachment-pipeline"
import type { Part } from "@shared/api-types"

const addAttachments = vi.fn()
const removeAttachment = vi.fn()

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      fileRefRemove: "删除",
      attachPick: "添加附件",
      attachProcessing: "处理附件中…",
      attachTooLarge: "附件超过 4MB 上限（base64 后）：{names}",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    attachmentsFor: () => currentAttachments,
    addAttachments,
    removeAttachment,
  }),
}))

let currentAttachments: Attachment[] = []

beforeEach(() => {
  addAttachments.mockClear()
  removeAttachment.mockClear()
  currentAttachments = []
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ openFilesPicker: async () => [] }),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const imgAtt: Attachment = {
  id: "att_1",
  mime: "image/jpeg",
  filename: "cam.jpg",
  dataUrl: "data:image/jpeg;base64,AA==",
  isImage: true,
}
const fileAtt: Attachment = {
  id: "att_2",
  mime: "application/pdf",
  filename: "doc.pdf",
  dataUrl: "data:application/pdf;base64,AA==",
  isImage: false,
}

describe("AttachmentChips", () => {
  it("图片缩略图 + 非图片文件 chip；删除回调带 id", () => {
    const onRemove = vi.fn()
    const { container } = render(<AttachmentChips items={[imgAtt, fileAtt]} onRemove={onRemove} />)
    expect(container.querySelector("img")?.getAttribute("src")).toBe(imgAtt.dataUrl)
    expect(screen.getByText("doc.pdf")).toBeTruthy()
    fireEvent.click(screen.getAllByLabelText("删除")[1]!)
    expect(onRemove).toHaveBeenCalledWith("att_2")
  })
  it("空列表不渲染", () => {
    const { container } = render(<AttachmentChips items={[]} onRemove={() => {}} />)
    expect(container.querySelector(".attach-chips")).toBeNull()
  })
})

describe("AttachmentThumb", () => {
  it("点击放大遮罩出现；点击遮罩关闭", () => {
    render(<AttachmentThumb url={imgAtt.dataUrl} filename="cam.jpg" />)
    const btn = document.querySelector(".attach-bubble-thumb") as HTMLButtonElement
    fireEvent.click(btn)
    expect(document.querySelector(".image-zoom")).toBeTruthy()
    fireEvent.click(document.querySelector(".image-zoom")!)
    expect(document.querySelector(".image-zoom")).toBeNull()
  })
})

describe("userImageParts", () => {
  const filePart = (over: Record<string, unknown>): Part =>
    ({ id: "p1", sessionID: "s", messageID: "m", type: "file", ...over }) as Part
  it("无 source + data: + image mime → 命中；svg/引用型/http 排除", () => {
    const parts = [
      filePart({ mime: "image/png", url: "data:image/png;base64,AA==", filename: "a.png" }),
      filePart({ mime: "image/svg+xml", url: "data:image/svg+xml;base64,AA==" }),
      filePart({ mime: "image/png", url: "http://x/a.png" }),
      filePart({
        mime: "text/plain",
        url: "file:///repo/a.txt",
        source: { type: "file", path: "a.txt" },
      }),
    ]
    const out = userImageParts(parts)
    expect(out).toHaveLength(1)
    expect(out[0]?.url.startsWith("data:image/png")).toBe(true)
  })
})

describe("useAttachmentInput（粘贴入口）", () => {
  let hook: ReturnType<typeof useAttachmentInput> | null = null
  function Probe() {
    hook = useAttachmentInput("s1")
    return <div>{hook!.chips}</div>
  }

  /** 合成 paste 事件（jsdom 无 DataTransfer 构造器——直接驱动 handler） */
  function firePaste(files: File[]): boolean {
    let prevented = false
    const fake = {
      clipboardData: { files },
      preventDefault: () => {
        prevented = true
      },
    }
    hook!.pasteProps.onPaste(fake as unknown as React.ClipboardEvent<HTMLTextAreaElement>)
    return prevented
  }

  it("粘贴图片文件 → preventDefault + 管线入库（addAttachments）", async () => {
    render(<Probe />)
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })
    // jsdom 无 createImageBitmap——decodeSize 返回 null → 图片按非图片透传
    const prevented = firePaste([file])
    expect(prevented).toBe(true)
    await waitFor(() => expect(addAttachments).toHaveBeenCalled())
    const list = addAttachments.mock.calls[0]![1] as Attachment[]
    expect(list[0]?.filename).toBe("shot.png")
    expect(list[0]?.isImage).toBe(true) // mime 保持 image/png（未压缩透传——jsdom 无解码）
  })

  it("纯文本粘贴不拦截（无 files）", () => {
    render(<Probe />)
    expect(firePaste([])).toBe(false)
    expect(addAttachments).not.toHaveBeenCalled()
  })
})
