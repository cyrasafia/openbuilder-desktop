import { describe, expect, it } from "vitest"
import {
  buildFormAnswer,
  CUSTOM_OPTION_VALUE,
  externalDirectoryPath,
  formVisibleSteps,
  isDegradedField,
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
          custom: true,
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

  it("form.created 事件：嵌套 form 字段解析，字段类型归一化，hidden/external 保留（T5）", () => {
    const q = normalizeForm(formCreated, "/repo")
    expect(q).toMatchObject({ id: "frm_1", sessionID: "ses_1", title: "选择分支", directory: "/repo" })
    expect(q?.fields.map((f) => [f.key, f.kind])).toEqual([
      ["branch", "select"],
      ["tags", "multiselect"],
      ["force", "boolean"],
      ["reason", "text"],
      ["why", "text"],
      ["count", "number"],
      ["secret", "text"],
      ["ext", "external"],
    ])
    expect(q?.fields.map((f) => f.required)).toEqual([false, false, false, false, true, false, false, false])
    // custom 透出（Form.StringField/MultiselectField.custom；question 工具恒 true）
    expect(q?.fields.map((f) => f.custom)).toEqual([true, false, false, false, false, false, false, false])
    expect(q?.fields[0].options).toEqual([
      { value: "main", label: "main", description: "默认分支" },
      { value: "dev", label: "dev", description: "" },
    ])
    expect(q?.fields[3].placeholder).toBe("可空")
    // hidden 标志透出（T5：模型层保留，不再剔除）
    expect(q?.fields.map((f) => f.hidden)).toEqual([false, false, false, false, false, false, true, false])
  })

  it("hidden/external 字段 default 原始值透出（string/number/boolean/string[]）", () => {
    const q = normalizeForm(
      {
        form: {
          id: "frm_d",
          sessionID: "ses_1",
          title: "t",
          fields: [
            { key: "h1", type: "string", hidden: true, required: true, default: "preset" },
            { key: "h2", type: "integer", hidden: true, required: true, default: 7 },
            { key: "h3", type: "boolean", hidden: true, required: true, default: true },
            { key: "h4", type: "multiselect", hidden: true, required: true, default: ["a", "b"] },
            { key: "h5", type: "number", hidden: true, required: true, default: { bad: 1 } },
          ],
        },
      },
      "/repo",
    )
    const byKey = Object.fromEntries((q?.fields ?? []).map((f) => [f.key, f]))
    expect(byKey.h1.defaultValue).toBe("preset")
    expect(byKey.h2.defaultValue).toBe(7)
    expect(byKey.h3.defaultValue).toBe(true)
    expect(byKey.h4.defaultValue).toEqual(["a", "b"])
    // 不认识的形态丢弃（undefined = 无 default）
    expect(byKey.h5.defaultValue).toBeUndefined()
  })

  it("全 hidden/external 卡不再被整卡丢弃（T5：原剔除致会话永久 pending）", () => {
    const q = normalizeForm(
      {
        form: {
          id: "frm_h",
          sessionID: "ses_1",
          title: "隐藏卡",
          fields: [
            { key: "s", type: "string", hidden: true, default: "x" },
            { key: "e", type: "external", title: "授权" },
          ],
        },
      },
      "/repo",
    )
    expect(q?.id).toBe("frm_h")
    expect(q?.fields.map((f) => [f.key, f.kind])).toEqual([
      ["s", "text"],
      ["e", "external"],
    ])
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
      { key: "branch", question: "q", description: "", kind: "select", options: [], placeholder: "", required: false, custom: true, hidden: false },
      { key: "tags", question: "q", description: "", kind: "multiselect", options: [], placeholder: "", required: false, custom: true, hidden: false },
      { key: "force", question: "q", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false },
      { key: "note", question: "q", description: "", kind: "text", options: [], placeholder: "", required: false, custom: false, hidden: false },
      { key: "n", question: "q", description: "", kind: "number", options: [], placeholder: "", required: false, custom: false, hidden: false },
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

  it("「其他」哨兵：select 以自定义文本为答案、multiselect 追加到数组（T1）", () => {
    const answer = buildFormAnswer(q, {
      0: { selected: [CUSTOM_OPTION_VALUE], customText: "  自由答案  " },
      1: { selected: ["Diff", CUSTOM_OPTION_VALUE], customText: "note" },
    })
    // customText trim 后提交（哨兵剥离、不泄漏进 answer）
    expect(answer).toEqual({ branch: "自由答案", tags: ["Diff", "note"], force: false, note: "", n: 0 })
  })

  it("「其他」哨兵空文本：select 回落空串、multiselect 丢弃哨兵（防御，UI 门控先挡）", () => {
    const answer = buildFormAnswer(q, {
      0: { selected: [CUSTOM_OPTION_VALUE], customText: "   " },
      1: { selected: ["Diff", CUSTOM_OPTION_VALUE], customText: "" },
    })
    expect(answer.branch).toBe("")
    expect(answer.tags).toEqual(["Diff"])
  })

  it("未选「其他」时 customText 忽略（输入框不参与答案）", () => {
    const answer = buildFormAnswer(q, {
      0: { selected: ["main"], customText: "不应出现" },
      1: { selected: ["Diff"], customText: "不应出现" },
    })
    expect(answer.branch).toBe("main")
    expect(answer.tags).toEqual(["Diff"])
  })
})

describe("buildFormAnswer hidden/external 补键（T5，v2.0.26 活体实测矩阵）", () => {
  function mixed(fields: Partial<PendingQuestion["fields"][number]>[]): PendingQuestion {
    const base: PendingQuestion["fields"][number] = {
      key: "",
      question: "q",
      description: "",
      kind: "text",
      options: [],
      placeholder: "",
      required: false,
      custom: false,
      hidden: false,
    }
    return {
      id: "frm_1",
      sessionID: "ses_1",
      title: "t",
      directory: "/r",
      fields: fields.map((f) => ({ ...base, ...f })),
    }
  }

  it("external 恒补 ack true（缺键 400 External form field must be acknowledged，实测 204）", () => {
    const answer = buildFormAnswer(mixed([{ key: "e1", kind: "external" }, { key: "e2", kind: "external" }]), {})
    expect(answer).toEqual({ e1: true, e2: true })
  })

  it("hidden 非 required 不发键（缺键实测 204，可省略）", () => {
    const answer = buildFormAnswer(
      mixed([
        { key: "h", kind: "text", hidden: true },
        { key: "v", kind: "text" },
      ]),
      { 1: { text: "ans" } },
    )
    expect(answer).toEqual({ v: "ans" })
  })

  it("hidden + required 补类型化 default：number 直传/字符串解析、boolean、multiselect 数组、string 原文", () => {
    const answer = buildFormAnswer(
      mixed([
        { key: "a", kind: "number", hidden: true, required: true, defaultValue: 7 },
        { key: "b", kind: "number", hidden: true, required: true, defaultValue: "3.5" },
        { key: "c", kind: "boolean", hidden: true, required: true, defaultValue: "true" },
        { key: "d", kind: "multiselect", hidden: true, required: true, defaultValue: ["x", "y"] },
        { key: "e", kind: "text", hidden: true, required: true, defaultValue: "preset" },
      ]),
      {},
    )
    expect(answer).toEqual({ a: 7, b: 3.5, c: true, d: ["x", "y"], e: "preset" })
  })

  it("hidden + required default 字符串解析失败兜底 0（NaN → 0，同移动端 tryParse ?? 0）", () => {
    const answer = buildFormAnswer(
      mixed([{ key: "a", kind: "number", hidden: true, required: true, defaultValue: "abc" }]),
      {},
    )
    expect(answer).toEqual({ a: 0 })
  })

  it("multiselect default 字符串形态按逗号拆（移动端 join(',') 归一形态兼容）", () => {
    const answer = buildFormAnswer(
      mixed([
        { key: "d", kind: "multiselect", hidden: true, required: true, defaultValue: "x,y" },
        { key: "e", kind: "multiselect", hidden: true, required: true, defaultValue: "" },
      ]),
      {},
    )
    expect(answer).toEqual({ d: ["x", "y"], e: [] })
  })

  it("hidden + required + default 空的降级步按 UI 输入构造（不补空值——空值等同缺失 400）", () => {
    const answer = buildFormAnswer(
      mixed([
        { key: "dg", kind: "text", hidden: true, required: true, defaultValue: "" },
        { key: "dg2", kind: "multiselect", hidden: true, required: true, defaultValue: [] },
      ]),
      { 0: { text: "用户填" }, 1: { selected: ["a"] } },
    )
    expect(answer).toEqual({ dg: "用户填", dg2: ["a"] })
  })

  it("混合卡：可见步输入与补键共存（全字段按实测矩阵构造）", () => {
    const answer = buildFormAnswer(
      mixed([
        { key: "vis", kind: "select", options: [{ value: "m", label: "m", description: "" }] },
        { key: "hid", kind: "text", hidden: true, required: true, defaultValue: "auto" },
        { key: "opt", kind: "boolean", hidden: true },
        { key: "ext", kind: "external" },
      ]),
      { 0: { selected: ["m"] } },
    )
    expect(answer).toEqual({ vis: "m", hid: "auto", ext: true })
  })
})

describe("formVisibleSteps / isDegradedField（T5 UI 层）", () => {
  function fld(overrides: Partial<PendingQuestion["fields"][number]>): PendingQuestion["fields"][number] {
    return {
      key: "k",
      question: "q",
      description: "",
      kind: "text",
      options: [],
      placeholder: "",
      required: false,
      custom: false,
      hidden: false,
      ...overrides,
    }
  }

  it("可见步 = 非 external 且（非 hidden 或降级）；返回字段原下标", () => {
    const q: PendingQuestion = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "t",
      directory: "/r",
      fields: [
        fld({ key: "a", kind: "select", options: [{ value: "1", label: "1", description: "" }] }),
        fld({ key: "h", hidden: true, required: true, defaultValue: "x" }),
        fld({ key: "e", kind: "external" }),
        fld({ key: "dg", hidden: true, required: true }), // 无 default → 降级
        fld({ key: "ho", hidden: true }), // 非 required → 跳过
      ],
    }
    expect(formVisibleSteps(q)).toEqual([0, 3])
  })

  it("全 hidden/external → 空序列（ack-only 卡）", () => {
    const q: PendingQuestion = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "t",
      directory: "/r",
      fields: [fld({ key: "h", hidden: true }), fld({ key: "e", kind: "external" })],
    }
    expect(formVisibleSteps(q)).toEqual([])
  })

  it("isDegradedField：仅 hidden+required+default 空；空串/空数组/undefined 均算空", () => {
    expect(isDegradedField(fld({ hidden: true, required: true }))).toBe(true)
    expect(isDegradedField(fld({ hidden: true, required: true, defaultValue: "" }))).toBe(true)
    expect(isDegradedField(fld({ hidden: true, required: true, defaultValue: [] }))).toBe(true)
    expect(isDegradedField(fld({ hidden: true, required: true, defaultValue: "x" }))).toBe(false)
    expect(isDegradedField(fld({ hidden: true, required: true, defaultValue: 0 }))).toBe(false)
    expect(isDegradedField(fld({ hidden: true }))).toBe(false)
    expect(isDegradedField(fld({ required: true }))).toBe(false)
    expect(isDegradedField(fld({ kind: "external", hidden: true, required: true }))).toBe(false)
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

  it("未读（design-unread-marker）：idle + 未读 → unread；优先级低于 waiting/failed", () => {
    expect(sessionDotState(0, "idle", false, true)).toBe("unread")
    expect(sessionDotState(0, "idle", false, false)).toBe("idle")
    // 待输入 > 未读；报错终局 > 未读
    expect(sessionDotState(1, "idle", false, true)).toBe("waiting")
    expect(sessionDotState(0, "idle", true, true)).toBe("failed")
    // busy/retry 期间未读参数无效（进行中状态优先）
    expect(sessionDotState(0, "busy", false, true)).toBe("running")
    expect(sessionDotState(0, "retry", false, true)).toBe("error")
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
      fields: [{ key: "k", question: "q", description: "", kind: "select", options: [], placeholder: "", required: false, custom: false, hidden: false }],
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
