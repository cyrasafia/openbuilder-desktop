import { describe, expect, it } from "vitest"
import {
  buildFormAnswer,
  externalDirectoryPath,
  mergePendingSnapshot,
  normalizeForm,
  normalizePermission,
  permissionCommand,
  sessionDotState,
  type PendingPermission,
  type PendingQuestion,
} from "./pending-requests"

describe("normalizePermission", () => {
  it("v1 事件：permission/patterns 字段", () => {
    const p = normalizePermission(
      {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git status"],
        metadata: { command: "git status" },
        always: ["git status"],
      },
      "/repo",
    )
    expect(p).toMatchObject({
      id: "per_1",
      sessionID: "ses_1",
      type: "bash",
      patterns: ["git status"],
      directory: "/repo",
      always: ["git status"],
    })
  })

  it("v2 事件：action/resources/save 字段映射", () => {
    const p = normalizePermission(
      { id: "per_2", sessionID: "ses_1", action: "edit", resources: ["/repo/a.ts"], save: ["/repo/a.ts"] },
      "/repo",
    )
    expect(p?.type).toBe("edit")
    expect(p?.patterns).toEqual(["/repo/a.ts"])
    expect(p?.always).toEqual(["/repo/a.ts"])
  })

  it("缺 id/sessionID 丢弃", () => {
    expect(normalizePermission({ permission: "bash" }, "/repo")).toBeNull()
    expect(normalizePermission({ id: "per_3" }, "/repo")).toBeNull()
    expect(normalizePermission(undefined, "/repo")).toBeNull()
  })
})

describe("normalizeForm（v2 form 体系，M6a）", () => {
  const formCreated = {
    form: {
      id: "frm_1",
      sessionID: "ses_1",
      title: "选择分支",
      fields: [
        {
          key: "branch",
          type: "string",
          title: "用哪个分支？",
          description: "合并目标",
          options: [
            { value: "main", label: "main", description: "默认分支" },
            { value: "dev", label: "dev" },
          ],
        },
        { key: "tags", type: "multiselect", title: "附加标签", options: [{ value: "a", label: "A" }] },
        { key: "force", type: "boolean", title: "强制执行？" },
        { key: "reason", type: "string", title: "说明", placeholder: "可空" },
        { key: "why", type: "string", title: "必填说明", required: true },
        { key: "count", type: "integer", title: "重试次数" },
        { key: "secret", type: "string", title: "隐藏项", hidden: true },
        { key: "ext", type: "external", title: "外部授权", url: "https://x" },
      ],
    },
  }

  it("form.created 事件：嵌套 form 字段解析，字段类型归一化，hidden/external 剔除", () => {
    const q = normalizeForm(formCreated, "/repo")
    expect(q).toMatchObject({ id: "frm_1", sessionID: "ses_1", title: "选择分支", directory: "/repo" })
    expect(q?.fields.map((f) => [f.key, f.kind])).toEqual([
      ["branch", "select"],
      ["tags", "multiselect"],
      ["force", "boolean"],
      ["reason", "text"],
      ["why", "text"],
      ["count", "number"],
    ])
    expect(q?.fields.map((f) => f.required)).toEqual([false, false, false, false, true, false])
    expect(q?.fields[0].options).toEqual([
      { value: "main", label: "main", description: "默认分支" },
      { value: "dev", label: "dev", description: "" },
    ])
    expect(q?.fields[3].placeholder).toBe("可空")
  })

  it("回填条目（Form.Info 本体，无 form 嵌套）同样解析", () => {
    const q = normalizeForm(
      { id: "frm_2", sessionID: "ses_1", title: "t", fields: [{ key: "k", type: "boolean" }] },
      "/repo",
    )
    expect(q?.id).toBe("frm_2")
    expect(q?.fields[0].kind).toBe("boolean")
  })

  it("title 缺失回落 field.key；缺 id/sessionID 或无有效字段丢弃", () => {
    expect(normalizeForm({ form: { id: "f", sessionID: "s", title: "t", fields: [] } }, "/r")).toBeNull()
    expect(normalizeForm({ form: { id: "f", fields: [{ key: "k", type: "string" }] } }, "/r")).toBeNull()
    expect(normalizeForm(undefined, "/r")).toBeNull()
  })
})

describe("buildFormAnswer（M6a）", () => {
  const q: PendingQuestion = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "t",
    directory: "/r",
    fields: [
      { key: "branch", question: "q", description: "", kind: "select", options: [], placeholder: "", required: false },
      { key: "tags", question: "q", description: "", kind: "multiselect", options: [], placeholder: "", required: false },
      { key: "force", question: "q", description: "", kind: "boolean", options: [], placeholder: "", required: false },
      { key: "note", question: "q", description: "", kind: "text", options: [], placeholder: "", required: false },
      { key: "n", question: "q", description: "", kind: "number", options: [], placeholder: "", required: false },
    ],
  }

  it("按字段类型构造：单选取首值/多选保序/布尔还原/文本直传/数值解析", () => {
    const answer = buildFormAnswer(q, {
      0: { selected: ["main"] },
      1: { selected: ["b", "a"] },
      2: { selected: ["true"] },
      3: { text: "hello" },
      4: { text: "3.5" },
    })
    expect(answer).toEqual({ branch: "main", tags: ["b", "a"], force: true, note: "hello", n: 3.5 })
  })

  it("未作答字段兜底：select 空串/多选空数组/布尔 false/文本空/数值 0（同移动端）", () => {
    const answer = buildFormAnswer(q, { 2: { selected: ["false"] } })
    expect(answer).toEqual({ branch: "", tags: [], force: false, note: "", n: 0 })
  })

  it("非数值输入兜底 0（tryParse ?? 0，同移动端）", () => {
    const answer = buildFormAnswer(q, { 4: { text: "abc" } })
    expect(answer.n).toBe(0)
  })
})

describe("title 派生辅助", () => {
  it("externalDirectoryPath：parentDir > filepath > pattern 去尾 /*", () => {
    const base = { id: "p", sessionID: "s", type: "external_directory", directory: "/r", always: [] }
    expect(
      externalDirectoryPath({ ...base, metadata: { parentDir: "/x" }, patterns: ["/y/*"] } as PendingPermission),
    ).toBe("/x")
    expect(
      externalDirectoryPath({ ...base, metadata: { filepath: "/f" }, patterns: ["/y/*"] } as PendingPermission),
    ).toBe("/f")
    expect(externalDirectoryPath({ ...base, metadata: null, patterns: ["/y/*"] } as PendingPermission)).toBe("/y")
    expect(externalDirectoryPath({ ...base, metadata: null, patterns: [] } as PendingPermission)).toBeNull()
  })

  it("permissionCommand：metadata.command", () => {
    const p = { id: "p", sessionID: "s", type: "bash", patterns: [], metadata: { command: "rm -rf /" }, always: [], directory: "/r" } as PendingPermission
    expect(permissionCommand(p)).toBe("rm -rf /")
    expect(permissionCommand({ ...p, metadata: null })).toBeNull()
  })
})

describe("sessionDotState", () => {
  it("waiting 优先于 error/running/failed；idle 兜底", () => {
    expect(sessionDotState(2, "retry")).toBe("waiting")
    expect(sessionDotState(1, "idle", true)).toBe("waiting")
    expect(sessionDotState(0, "busy", true)).toBe("running")
    expect(sessionDotState(0, "idle")).toBe("idle")
  })

  it("retry 退避重试投影为 error（红）——不再与 busy 混同 running", () => {
    expect(sessionDotState(0, "retry")).toBe("error")
  })

  it("idle + 报错终局投影为 failed（静态红）；非 idle 终局参数无效", () => {
    expect(sessionDotState(0, "idle", true)).toBe("failed")
    expect(sessionDotState(0, "retry", true)).toBe("error")
  })
})

describe("mergePendingSnapshot", () => {
  const dir = "/repo"

  function perm(id: string, sessionID: string, directory = dir): PendingPermission {
    return { id, sessionID, type: "bash", patterns: [], metadata: null, always: [], directory }
  }
  function form(id: string, sessionID: string, directory = dir): PendingQuestion {
    return {
      id,
      sessionID,
      title: "t",
      directory,
      fields: [{ key: "k", question: "q", description: "", kind: "select", options: [], placeholder: "", required: false }],
    }
  }

  it("成功目录权威覆盖：他端已回复的条目被移除", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([
      ["frm_1", form("frm_1", "ses_1")],
      ["frm_2", form("frm_2", "ses_2")],
    ])
    const changed = mergePendingSnapshot(permissions, questions, dir, [], [form("frm_1", "ses_1")])
    expect(changed).toBe(true)
    expect(permissions.size).toBe(0)
    expect([...questions.keys()]).toEqual(["frm_1"])
  })

  it("失败类别（null）保留本地——不得误清 SSE 已送达条目", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["frm_1", form("frm_1", "ses_1")]])
    const changed = mergePendingSnapshot(permissions, questions, dir, null, [])
    expect(changed).toBe(true) // questions 类别成功且有删减
    expect(permissions.size).toBe(1) // permissions 类别失败：原样保留
  })

  it("同数量换血（id 替换）也报告变化——仅比 size 会漏检不刷新卡片", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["frm_1", form("frm_1", "ses_1")]])
    const changed = mergePendingSnapshot(
      permissions,
      questions,
      dir,
      // per_1 已在他端应答、同会话来了新的 per_2：数量不变、内容变了
      [{ id: "per_2", sessionID: "ses_1", permission: "bash", patterns: [], metadata: {}, always: [] }],
      // frm_1 换成 frm_2
      [form("frm_2", "ses_1")],
    )
    expect(changed).toBe(true)
    expect(permissions.get("ses_1")?.id).toBe("per_2")
    expect([...questions.keys()]).toEqual(["frm_2"])
  })

  it("无变化（快照与本地一致）不报告变化", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["frm_1", form("frm_1", "ses_1")]])
    const changed = mergePendingSnapshot(
      permissions,
      questions,
      dir,
      [{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [], metadata: null, always: [] }],
      [form("frm_1", "ses_1")],
    )
    expect(changed).toBe(false)
  })

  it("只影响同目录条目：其他目录不被审判（跨目录误删回归）", () => {
    const other = "/other"
    const permissions = new Map([
      ["ses_1", perm("per_1", "ses_1", other)],
    ])
    const questions = new Map([["frm_1", form("frm_1", "ses_1", other)]])
    mergePendingSnapshot(permissions, questions, dir, [], [])
    expect(permissions.get("ses_1")?.directory).toBe(other)
    expect(questions.has("frm_1")).toBe(true)
  })
})
