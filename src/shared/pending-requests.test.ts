import { describe, expect, it } from "vitest"
import {
  externalDirectoryPath,
  mergePendingSnapshot,
  normalizePermission,
  normalizeQuestion,
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

  it("v2 事件：action/resources 字段映射", () => {
    const p = normalizePermission(
      { id: "per_2", sessionID: "ses_1", action: "edit", resources: ["/repo/a.ts"] },
      "/repo",
    )
    expect(p?.type).toBe("edit")
    expect(p?.patterns).toEqual(["/repo/a.ts"])
  })

  it("缺 id/sessionID 丢弃", () => {
    expect(normalizePermission({ permission: "bash" }, "/repo")).toBeNull()
    expect(normalizePermission({ id: "per_3" }, "/repo")).toBeNull()
    expect(normalizePermission(undefined, "/repo")).toBeNull()
  })
})

describe("normalizeQuestion", () => {
  it("解析子问题与选项，缺 questions 丢弃", () => {
    const q = normalizeQuestion(
      {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "用哪个分支？",
            header: "分支",
            options: [
              { label: "main", description: "默认分支" },
              { label: "dev", description: "" },
            ],
            multiple: false,
          },
        ],
      },
      "/repo",
    )
    expect(q).toMatchObject({
      id: "que_1",
      sessionID: "ses_1",
      directory: "/repo",
      questions: [
        {
          question: "用哪个分支？",
          header: "分支",
          multiple: false,
          custom: false,
          options: [
            { label: "main", description: "默认分支" },
            { label: "dev", description: "" },
          ],
        },
      ],
    })
    expect(normalizeQuestion({ id: "que_2", sessionID: "ses_1", questions: [] }, "/repo")).toBeNull()
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
  it("waiting 优先于 running；idle 兜底", () => {
    expect(sessionDotState(2, true)).toBe("waiting")
    expect(sessionDotState(1, false)).toBe("waiting")
    expect(sessionDotState(0, true)).toBe("running")
    expect(sessionDotState(0, false)).toBe("idle")
  })
})

describe("mergePendingSnapshot", () => {
  const dir = "/repo"

  function perm(id: string, sessionID: string, directory = dir): PendingPermission {
    return { id, sessionID, type: "bash", patterns: [], metadata: null, always: [], directory }
  }
  function que(id: string, sessionID: string, directory = dir): PendingQuestion {
    return {
      id,
      sessionID,
      directory,
      questions: [{ question: "q", header: "h", options: [], multiple: false, custom: false }],
    }
  }

  it("成功目录权威覆盖：他端已回复的条目被移除", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([
      ["que_1", que("que_1", "ses_1")],
      ["que_2", que("que_2", "ses_2")],
    ])
    const changed = mergePendingSnapshot(
      permissions,
      questions,
      dir,
      [], // per_1 已不在 server pending 列表
      [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "q", header: "h", options: [] }] }],
    )
    expect(changed).toBe(true)
    expect(permissions.size).toBe(0)
    expect([...questions.keys()]).toEqual(["que_1"])
  })

  it("失败类别（null）保留本地——不得误清 SSE 已送达条目", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["que_1", que("que_1", "ses_1")]])
    const changed = mergePendingSnapshot(permissions, questions, dir, null, [])
    expect(changed).toBe(true) // questions 类别成功且有删减
    expect(permissions.size).toBe(1) // permissions 类别失败：原样保留
  })

  it("同数量换血（id 替换）也报告变化——仅比 size 会漏检不刷新卡片", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["que_1", que("que_1", "ses_1")]])
    const changed = mergePendingSnapshot(
      permissions,
      questions,
      dir,
      // per_1 已在他端应答、同会话来了新的 per_2：数量不变、内容变了
      [{ id: "per_2", sessionID: "ses_1", permission: "bash", patterns: [], metadata: {}, always: [] }],
      // que_1 换成 que_2
      [{ id: "que_2", sessionID: "ses_1", questions: [{ question: "q", header: "h", options: [] }] }],
    )
    expect(changed).toBe(true)
    expect(permissions.get("ses_1")?.id).toBe("per_2")
    expect([...questions.keys()]).toEqual(["que_2"])
  })

  it("无变化（快照与本地一致）不报告变化", () => {
    const permissions = new Map([["ses_1", perm("per_1", "ses_1")]])
    const questions = new Map([["que_1", que("que_1", "ses_1")]])
    const changed = mergePendingSnapshot(
      permissions,
      questions,
      dir,
      [{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [], metadata: null, always: [] }],
      [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "q", header: "h", options: [] }] }],
    )
    expect(changed).toBe(false)
  })

  it("只影响同目录条目：其他目录不被审判（跨目录误删回归）", () => {
    const other = "/other"
    const permissions = new Map([
      ["ses_1", perm("per_1", "ses_1", other)],
    ])
    const questions = new Map([["que_1", que("que_1", "ses_1", other)]])
    mergePendingSnapshot(permissions, questions, dir, [], [])
    expect(permissions.get("ses_1")?.directory).toBe(other)
    expect(questions.has("que_1")).toBe(true)
  })
})
