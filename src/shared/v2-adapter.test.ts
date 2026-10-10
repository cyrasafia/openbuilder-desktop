/**
 * v2-adapter 消息域测试（M4a）：typed union → MessageWithParts；
 * contentText/errorMessage 纯函数。
 */
import { describe, expect, it } from "vitest"
import {
  contentText,
  errorMessage,
  inboxItemToUserMessage,
  toInternalMessages,
  toInternalSession,
} from "./v2-adapter"

const U = { id: "msg_u1", time: { created: 100 }, type: "user", text: "看下这些", files: [], agents: [], skills: [] }
const A = {
  id: "msg_a1",
  time: { created: 200, completed: 260 },
  type: "assistant",
  agent: "build",
  model: { id: "glm-5.3", providerID: "zai" },
  finish: "stop",
  content: [
    { type: "reasoning", text: "想想" },
    { type: "text", text: "答案" },
    {
      type: "tool",
      id: "tool_1",
      name: "read",
      executed: true,
      state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "file body" }] },
      time: { created: 210, completed: 220 },
    },
    {
      type: "tool",
      id: "tool_2",
      name: "bash",
      state: { status: "error", input: {}, error: { name: "ExitError", message: "exit 1" } },
      time: { created: 230 },
    },
    {
      type: "tool",
      id: "tool_3",
      name: "bash",
      // v2.0.18 活体：打断未结算工具持久化为 error + {type:"aborted"}
      state: { status: "error", input: {}, error: { type: "aborted", message: "Tool execution interrupted: bash" } },
      time: { created: 240 },
    },
  ],
}

describe("toInternalMessages", () => {
  it("user → role:user + text part；assistant → info 透传 + content 部件化", () => {
    const [u, a] = toInternalMessages("ses_1", [U, A])
    expect(u.info).toMatchObject({ id: "msg_u1", role: "user", time: { created: 100 } })
    expect(u.parts).toHaveLength(1)
    expect(u.parts[0]).toMatchObject({ type: "text", text: "看下这些" })

    expect(a.info).toMatchObject({ id: "msg_a1", role: "assistant", finish: "stop", agent: "build" })
    const kinds = a.parts.map((p) => p.type)
    expect(kinds).toEqual(["reasoning", "text", "tool", "tool", "tool"])
    // text/reasoning 铸稳定 id（与流式翻译层同规则）；tool 用自身 id
    expect(a.parts[0]).toMatchObject({ id: "msg_a1:c:0", text: "想想" })
    expect(a.parts[1]).toMatchObject({ id: "msg_a1:c:1", text: "答案" })
    expect(a.parts[2]).toMatchObject({ id: "tool_1", tool: "read", callID: "tool_1" })
  })

  it("ToolState 映射：completed 展平 content 为 output + title=name；error 取 message；中止 error 置 aborted 标记", () => {
    const out = toInternalMessages("ses_1", [A])
    expect(out).toHaveLength(1)
    const a = out[0]!
    expect(a.parts).toHaveLength(5)
    const done = a.parts[2] as unknown as { state: { status: string; output: string; title: string } }
    expect(done.state).toMatchObject({ status: "completed", output: "file body", title: "read" })
    const failed = a.parts[3] as unknown as { state: { status: string; error: string; aborted?: boolean } }
    expect(failed.state).toMatchObject({ status: "error", error: "exit 1" })
    expect(failed.state.aborted).toBeUndefined()
    // 打断未结算工具（design-error-message §3.1 修订）：error 文案保留忠实 +
    // aborted 标记驱动渲染层「已停止」中性呈现
    const aborted = a.parts[4] as unknown as { state: { status: string; error: string; aborted?: boolean } }
    expect(aborted.state).toMatchObject({
      status: "error",
      error: "Tool execution interrupted: bash",
      aborted: true,
    })
  })

  it("synthetic → user + synthetic:true text part（渲染层既有过滤规则生效）；无对应类型跳过", () => {
    const synth = { id: "msg_s1", time: { created: 50 }, type: "synthetic", text: "Background" }
    const sys = { id: "msg_x", time: { created: 60 }, type: "system", text: "sys" }
    const idle = { id: "msg_i", time: { created: 70 }, type: "idle" }
    const out = toInternalMessages("ses_1", [synth, sys, idle])
    expect(out).toHaveLength(1)
    expect(out[0].parts[0]).toMatchObject({ synthetic: true, text: "Background" })
  })
})

describe("contentText / errorMessage", () => {
  it("contentText 拼接 text 型；非文本省略", () => {
    expect(contentText([{ type: "text", text: "a" }, { type: "image", data: "..." }, { type: "text", text: "b" }])).toBe("a\nb")
    expect(contentText(undefined)).toBe("")
  })
  it("errorMessage：message > name > 兜底", () => {
    expect(errorMessage({ message: "boom" })).toBe("boom")
    expect(errorMessage({ name: "ExitError" })).toBe("ExitError")
    expect(errorMessage(undefined)).toBe("error")
  })
})

// 回滚暂存映射（design-sse-event-surface 层 3）：快照整条替换不得抹 staged 态
describe("toInternalSession revert 映射", () => {
  const base = {
    id: "ses_1",
    projectID: "proj1",
    time: { created: 1, updated: 2 },
    location: { directory: "/repo" },
  }

  it("wire revert 透传（含 files），null/缺省归一 undefined", () => {
    const s = toInternalSession({
      ...base,
      revert: { messageID: "msg_u2", snapshot: "sha", files: [{ file: "a.ts" }] },
    } as Parameters<typeof toInternalSession>[0])
    expect(s.revert).toEqual({ messageID: "msg_u2", snapshot: "sha", files: [{ file: "a.ts" }] })

    expect(toInternalSession({ ...base } as Parameters<typeof toInternalSession>[0]).revert).toBeUndefined()
    // wire 契约 revert 为可选字段（无 null 形态）；?? undefined 防御性归一
    expect(
      toInternalSession({ ...base, revert: undefined } as Parameters<typeof toInternalSession>[0]).revert,
    ).toBeUndefined()
  })
})

describe("inboxItemToUserMessage（design-inbox-admission §3.2，准入即物化）", () => {
  it("text part 铸造 + info 形状（inboxID 即消息 id，created 由信封传入）", () => {
    const m = inboxItemToUserMessage(
      "ses_1",
      "msg_u1",
      { type: "user", payload: { text: "补充：统计词数" }, delivery: "steer" },
      250,
    )
    expect(m?.info).toEqual({ id: "msg_u1", sessionID: "ses_1", role: "user", time: { created: 250 } })
    expect(m?.parts).toHaveLength(1)
    expect(m?.parts[0]).toMatchObject({ id: "msg_u1:text", type: "text", text: "补充：统计词数" })
  })

  it("bridge：refs 铸引用回灌型（source.type=file 可点 chip）、attachments 铸 data: 附件", () => {
    const m = inboxItemToUserMessage(
      "ses_1",
      "msg_u1",
      { type: "user", payload: { text: "看下这个", files: [{ uri: "file:///x", name: "x" }] }, delivery: "steer" },
      250,
      {
        refs: [{ path: "src/a.ts", absolute: "/repo/src/a.ts", filename: "a.ts", isDir: false }],
        attachments: [{ id: "att_1", mime: "image/png", filename: "shot.png", dataUrl: "data:image/png;base64,AAAA", isImage: true }],
      },
    )
    // bridge 在场时跳过 payload files 兜底（防同源重复 chip）
    expect(m?.parts).toHaveLength(3)
    const refPart = m!.parts[1] as { type: string; source?: { type?: string; path?: string }; url?: string }
    expect(refPart.type).toBe("file")
    expect(refPart.source?.type).toBe("file")
    expect(refPart.source?.path).toBe("src/a.ts")
    expect(refPart.url).toBe("file:///repo/src/a.ts")
    const attachPart = m!.parts[2] as { type: string; url?: string; mime?: string; source?: unknown; filename?: string }
    expect(attachPart.type).toBe("file")
    expect(attachPart.url).toBe("data:image/png;base64,AAAA")
    expect(attachPart.mime).toBe("image/png")
    expect(attachPart.source).toBeUndefined()
    expect(attachPart.filename).toBe("shot.png")
  })

  it("payload files 兜底：live 2.0.24 形状（data/mime/source.uri/name）+ 2.0.18 形状（uri/name）", () => {
    const m = inboxItemToUserMessage(
      "ses_1",
      "msg_u1",
      {
        type: "user",
        payload: {
          text: "看文件",
          files: [
            // source.uri 在场：uri 优先（原始文件引用）；data 无 url 落点时才重组
            { data: "QUFB", mime: "image/png", source: { type: "uri", uri: "file:///repo/pic.png" }, name: "pic.png" },
            { uri: "file:///repo/b.ts", name: "b.ts" },
            // 仅 data + mime（server 剥离了 uri）：重组 data: url（图片缩略图路径）
            { data: "QkI", mime: "image/jpeg", name: "inline.jpg" },
          ],
        },
        delivery: "steer",
      },
      250,
    )
    const files = m?.parts.filter((p) => p.type === "file") as Array<{
      url?: string
      mime?: string
      filename?: string
      source?: { type?: string; uri?: string }
    }>
    expect(files).toHaveLength(3)
    expect(files[0]).toMatchObject({ url: "file:///repo/pic.png", mime: "image/png", filename: "pic.png" })
    expect(files[0].source?.type).toBe("uri")
    // 2.0.18 形状：uri 直用
    expect(files[1]).toMatchObject({ url: "file:///repo/b.ts", filename: "b.ts" })
    // 无 uri：data + mime → 重组 data: url
    expect(files[2]).toMatchObject({ url: "data:image/jpeg;base64,QkI", mime: "image/jpeg", filename: "inline.jpg" })
  })

  it("防御：payload 缺失/非对象 → null（malformed 事件走旧重取路径）", () => {
    expect(inboxItemToUserMessage("ses_1", "msg_u1", undefined, 250)).toBeNull()
    expect(inboxItemToUserMessage("ses_1", "msg_u1", { type: "user" }, 250)).toBeNull()
    expect(inboxItemToUserMessage("ses_1", "msg_u1", { type: "user", payload: {} }, 250)?.parts).toHaveLength(0)
  })
})
