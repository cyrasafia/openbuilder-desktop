/**
 * v2-adapter 消息域测试（M4a）：typed union → MessageWithParts；
 * contentText/errorMessage 纯函数。
 */
import { describe, expect, it } from "vitest"
import { contentText, errorMessage, toInternalMessages, toInternalSession } from "./v2-adapter"

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
    expect(kinds).toEqual(["reasoning", "text", "tool", "tool"])
    // text/reasoning 铸稳定 id（与流式翻译层同规则）；tool 用自身 id
    expect(a.parts[0]).toMatchObject({ id: "msg_a1:c:0", text: "想想" })
    expect(a.parts[1]).toMatchObject({ id: "msg_a1:c:1", text: "答案" })
    expect(a.parts[2]).toMatchObject({ id: "tool_1", tool: "read", callID: "tool_1" })
  })

  it("ToolState 映射：completed 展平 content 为 output + title=name；error 取 message", () => {
    const out = toInternalMessages("ses_1", [A])
    expect(out).toHaveLength(1)
    const a = out[0]!
    const done = a.parts[2] as unknown as { state: { status: string; output: string; title: string } }
    expect(done.state).toMatchObject({ status: "completed", output: "file body", title: "read" })
    const failed = a.parts[3] as unknown as { state: { status: string; error: string } }
    expect(failed.state).toMatchObject({ status: "error", error: "exit 1" })
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
