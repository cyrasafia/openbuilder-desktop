/** 附件管线单测（design-session-attachments §7）：纯函数 + 注入 ImageOps 桩 */
import { describe, expect, it } from "vitest"
import {
  MAX_BASE64_BYTES,
  base64Length,
  guessMime,
  isDisplayableImage,
  resolveFiles,
  resolveOne,
  shrinkPlan,
  toDataUrl,
  type ImageOps,
} from "./attachment-pipeline"

const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

describe("guessMime", () => {
  it("declared 优先；扩展名兜底；未知 octet-stream", () => {
    expect(guessMime("a.bin", "image/png")).toBe("image/png")
    expect(guessMime("a.PNG", null)).toBe("image/png")
    expect(guessMime("photo.jpeg", "")).toBe("image/jpeg")
    expect(guessMime("noext", null)).toBe("application/octet-stream")
    expect(guessMime("x.md", null)).toBe("text/markdown")
  })
})

describe("isDisplayableImage", () => {
  it("image/* 除 svg", () => {
    expect(isDisplayableImage("image/png")).toBe(true)
    expect(isDisplayableImage("image/svg+xml")).toBe(false)
    expect(isDisplayableImage("application/pdf")).toBe(false)
  })
})

describe("toDataUrl / base64Length", () => {
  it("data URL 前缀与 base64 体一致；长度 ≈ 4/3", () => {
    const url = toDataUrl("image/png", tinyPng)
    expect(url.startsWith("data:image/png;base64,")).toBe(true)
    const b64 = url.split(",")[1]!
    expect(atob(b64).length).toBe(tinyPng.length)
    expect(base64Length(tinyPng)).toBeGreaterThanOrEqual(b64.length)
  })
})

describe("shrinkPlan", () => {
  it("先降质后缩宽（AT-3 循环计划）", () => {
    const plan = shrinkPlan()
    expect(plan.map((s) => s.quality)).toEqual([0.85, 0.65, 0.45, 0.3, 0.5, 0.5])
    expect(plan[4]?.maxEdge).toBe(1024)
    expect(plan[5]?.maxEdge).toBe(512)
  })
})

/** ImageOps 桩：reencode 恒返回固定大小输出（模拟压缩到位） */
function opsReturning(bytes: Uint8Array): ImageOps {
  return {
    decodeSize: async () => ({ width: 4000, height: 3000 }),
    reencode: async () => bytes,
  }
}

describe("resolveOne", () => {
  it("非图片小文件：原样 data URL 透传", async () => {
    const r = await resolveOne("note.txt", new TextEncoder().encode("hello"), "text/plain", opsReturning(tinyPng))
    expect("reason" in r).toBe(false)
    if (!("reason" in r)) {
      expect(r.mime).toBe("text/plain")
      expect(r.isImage).toBe(false)
      expect(r.dataUrl.startsWith("data:text/plain;base64,")).toBe(true)
    }
  })

  it("非图片超 4MB base64：拒绝（reason too_large）", async () => {
    const big = new Uint8Array(Math.ceil((MAX_BASE64_BYTES * 3) / 4) + 100)
    const r = await resolveOne("big.bin", big, null, opsReturning(tinyPng))
    expect(r).toEqual({ name: "big.bin", reason: "too_large" })
  })

  it("图片：压缩循环至 base64 上限内、输出 image/jpeg", async () => {
    // 首次 reencode 返回仍超限的大块，第二次返回小字节 → 走两步计划
    let calls = 0
    const ops: ImageOps = {
      decodeSize: async () => ({ width: 100, height: 100 }),
      reencode: async () => {
        calls++
        return calls === 1 ? new Uint8Array(MAX_BASE64_BYTES) : tinyPng
      },
    }
    const r = await resolveOne("cam.png", tinyPng, "image/png", ops)
    expect("reason" in r).toBe(false)
    if (!("reason" in r)) {
      expect(r.mime).toBe("image/jpeg")
      expect(r.isImage).toBe(true)
      expect(calls).toBe(2)
    }
  })

  it("图片解码失败（HEIC 等）：按非图片透传原字节", async () => {
    const ops: ImageOps = {
      decodeSize: async () => null,
      reencode: async () => {
        throw new Error("should not reencode")
      },
    }
    const r = await resolveOne("photo.heic", tinyPng, null, ops)
    expect("reason" in r).toBe(false)
    if (!("reason" in r)) {
      expect(r.mime).toBe("application/octet-stream")
      expect(r.isImage).toBe(false)
    }
  })
})

describe("resolveFiles", () => {
  it("聚合 accepted/rejected", async () => {
    const ops = opsReturning(tinyPng)
    const big = new Uint8Array(Math.ceil((MAX_BASE64_BYTES * 3) / 4) + 100)
    const r = await resolveFiles(
      [
        { name: "ok.txt", type: "text/plain", bytes: new TextEncoder().encode("x") },
        { name: "big.bin", type: null, bytes: big },
      ],
      ops,
    )
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]?.filename).toBe("ok.txt")
    expect(r.rejected).toEqual([{ name: "big.bin", reason: "too_large" }])
  })
})
