/**
 * AppStore 切换链路测试（design-tab-memory §6/§16 先切换后加载 + 死会话收敛；
 * design-agent-model-switch 隐式默认模型链路）：只测 store 纯状态机——注入 fake client
 * 与项目/会话/记忆夹具，SSE 不启动（activeProfileId 为空时 startSse 直接返回），
 * 快照落点用手动 deferred 控制。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppStore, diffTabKey, FILE_WATCH_DEBOUNCE_MS } from "./app-store"
import { ApiError } from "@shared/rest-client"
import { SseSubscriber } from "@shared/sse-subscriber"
import type { ModelCatalog } from "@shared/model-catalog"
import type { MessageWithParts, ModelRef, Project, Session } from "@shared/api-types"

const ROOT = "/repo"
const WT1 = "/repo/.git/opencode-worktrees/wt1"
const WT2 = "/repo/.git/opencode-worktrees/wt2"

vi.spyOn(SseSubscriber.prototype, "start").mockImplementation(() => {})
vi.spyOn(SseSubscriber.prototype, "stop").mockImplementation(() => {})

function project(): Project {
  return { id: "proj1", worktree: ROOT, time: { created: 0, updated: 0 }, sandboxes: [WT1, WT2] }
}

function session(id: string, directory: string, time: Session["time"]): Session {
  return { id, projectID: "proj1", directory, title: id, time }
}

/** 手动决断的快照：deferred.resolve 前在途，resolve 后 refresh 链放行 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function sessionsOf(...list: Session[]): Map<string, Session> {
  return new Map(list.map((s) => [s.id, s]))
}

let store: AppStore
let snapshots: Map<string, Promise<Session[]> | Session[]>

beforeEach(() => {
  ;(window as unknown as { desktop: unknown }).desktop = {
    storeGet: async () => null,
    storeSet: async () => {},
  }
  snapshots = new Map()
  store = new AppStore()
  ;(store as unknown as { client: unknown }).client = {
    listSessions: async (dir: string) => {
      const v = snapshots.get(dir)
      return v === undefined ? [] : await v
    },
    listSessionStatus: async () => ({}),
    listProjects: async () => [project()],
    listPendingPermissions: async () => [],
    listPendingQuestions: async () => [],
  }
  store.projects = [project()]
  store.projectStates = {
    default: { opened: ["proj1"], currentProjectId: "proj1", currentWorkspaceId: null },
  }
})

describe("先切换后加载：setCurrentWorkspace", () => {
  it("同步段立即生效：作用域/文件树/记忆 Tab 即时切换，快照在途不阻塞", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s1, s2))
    store.tabMemory = {
      default: {
        [ROOT]: { projectId: "proj1", tabs: ["s1"], active: "s1" },
        [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" },
      },
    }
    store.fileTreeNodes.set(".", [])
    const d1 = deferred<Session[]>()
    snapshots.set(ROOT, [s1])
    snapshots.set(WT1, d1.promise)
    snapshots.set(WT2, [])

    const p = store.setCurrentWorkspace(WT1)
    // 同步段（未 await）：作用域已切换、文件树已重置、记忆 Tab 已恢复激活
    expect(store.currentWorkspace?.directory).toBe(WT1)
    expect(store.projectStates.default.currentWorkspaceId).toBe(WT1)
    expect(store.fileTreeNodes.size).toBe(0)
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s2"])
    expect(store.activeTabKey).toBe("chat:s2")

    d1.resolve([s2])
    await p
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s2"])
  })

  it("首次全量打开只在快照落地后（immediate 段不写记忆不开 Tab）", async () => {
    const s3 = session("s3", WT2, { created: 3, updated: 3 })
    const d2 = deferred<Session[]>()
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, d2.promise)

    const p = store.setCurrentWorkspace(WT2)
    expect(store.currentWorkspace?.directory).toBe(WT2)
    expect(store.tabs).toHaveLength(0)
    expect(store.tabMemory.default?.[WT2]).toBeUndefined()

    d2.resolve([s3])
    await p
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s3"])
    expect(store.activeTabKey).toBe("chat:s3")
    expect(store.tabMemory.default?.[WT2]).toEqual({ projectId: "proj1", tabs: ["s3"], active: "s3" })
  })

  it("异步段过期闸门：快照在途时已切走，旧作用域不恢复不写记忆", async () => {
    const s3 = session("s3", WT2, { created: 3, updated: 3 })
    const d2 = deferred<Session[]>()
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, d2.promise)

    const p2switch = store.setCurrentWorkspace(WT2)
    // WT2 快照在途时切回主工作区（root 快照立即返回）
    snapshots.set(ROOT, [])
    const pRoot = store.setCurrentWorkspace(null)
    d2.resolve([s3])
    await Promise.all([p2switch, pRoot])

    expect(store.currentWorkspace).toBeNull()
    expect(store.tabs.filter((t) => t.directory === WT2)).toHaveLength(0)
    expect(store.tabMemory.default?.[WT2]).toBeUndefined()
  })

  it("记忆外可见会话补开（§17，kind-engine 场景）：切走期间他端新建，切回即补开、active 保持", async () => {
    const s1 = session("s1", WT1, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 20 }) // 切走期间他端新建
    // SSE session.created 已达本地（sessionsByProject 有记录），但不开 Tab 不写记忆
    store.sessionsByProject.set("proj1", sessionsOf(s1, s2))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s1"], active: "s1" } } }
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s1, s2])
    snapshots.set(WT2, [])

    const p = store.setCurrentWorkspace(WT1)
    // 同步段即补开（本地已有新会话）：记忆序在前、新会话 created 升序靠右
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s2"])
    expect(store.activeTabKey).toBe("chat:s1")
    await p
    expect(store.tabMemory.default?.[WT1]).toEqual({
      projectId: "proj1",
      tabs: ["s1", "s2"],
      active: "s1",
    })
  })

  it("快照滞后补开：同步段本地无记录（防御闸门不动作），完整恢复落地后补齐", async () => {
    const s1 = session("s1", WT1, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s1"], active: "s1" } } }
    const d1 = deferred<Session[]>()
    snapshots.set(ROOT, [])
    snapshots.set(WT1, d1.promise)
    snapshots.set(WT2, [])

    const p = store.setCurrentWorkspace(WT1)
    // 同步段：本地快照全空 → isSnapshotMissing 闸门触发，不开不收缩
    expect(store.tabs).toHaveLength(0)
    d1.resolve([s1, s2])
    await p
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s2"])
    expect(store.activeTabKey).toBe("chat:s1")
    expect(store.tabMemory.default?.[WT1]).toEqual({
      projectId: "proj1",
      tabs: ["s1", "s2"],
      active: "s1",
    })
  })

  it("零 Tab 哨兵作用域的他端新会话：切回补开（唯一可达入口）", async () => {
    const s5 = session("s5", WT2, { created: 5, updated: 5 })
    store.tabMemory = { default: { [WT2]: { projectId: "proj1", tabs: [], active: null } } }
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [s5])

    await store.setCurrentWorkspace(WT2)
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s5"])
    expect(store.activeTabKey).toBe("chat:s5") // §7 末位回退
    expect(store.tabMemory.default?.[WT2]).toEqual({ projectId: "proj1", tabs: ["s5"], active: "s5" })
  })

  it("死会话 Tab 收敛：快照证实已归档的记忆 Tab 关闭；记忆外可见会话补开并入记忆", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    const s4 = session("s4", WT1, { created: 4, updated: 4 })
    store.sessionsByProject.set("proj1", sessionsOf(s2, s4))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" } } }
    const s2Archived = session("s2", WT1, { created: 2, updated: 5, archived: 5 })
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s2Archived, s4])
    snapshots.set(WT2, [])

    await store.setCurrentWorkspace(WT1)
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s4"])
    expect(store.activeTabKey).toBe("chat:s4")
    expect(store.tabMemory.default?.[WT1]).toEqual({ projectId: "proj1", tabs: ["s4"], active: "s4" })
  })

  it("幻影 directory 防御：不在 sandboxes 内的目录视为主工作区", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s1, s2))
    store.tabMemory = {
      default: {
        [ROOT]: { projectId: "proj1", tabs: ["s1"], active: "s1" },
        [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" },
      },
    }
    snapshots.set(ROOT, [s1])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])
    await store.setCurrentWorkspace(WT1)
    expect(store.projectStates.default.currentWorkspaceId).toBe(WT1)

    // 在有效 worktree 上传入幻影目录：落回主工作区（非同值早退，防御分支真实执行）
    await store.setCurrentWorkspace("/ghost")
    expect(store.currentWorkspace).toBeNull()
    expect(store.projectStates.default.currentWorkspaceId).toBeNull()
    expect(store.scopeQuery.directory).toBe(ROOT)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("整目录被他端清空：空快照清除本地死会话，Tab 随之收敛", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s2))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" } } }
    snapshots.set(ROOT, [])
    // WT1 会话已被他端全部删除：成功快照返回空（merge 层 <2 条无开区间，靠 store 清空）
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])

    await store.setCurrentWorkspace(WT1)
    expect(store.tabs).toHaveLength(0)
    expect(store.activeTabKey).toBeNull()
    expect(store.tabMemory.default?.[WT1]).toEqual({ projectId: "proj1", tabs: [], active: null })
  })
})

describe("非聊天 Tab 作用域化（design-tab-memory §18）", () => {
  it("file Tab 激活时切 worktree：激活随新作用域走；file Tab 不关闭（隐藏），切回恢复可见", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s1, s2))
    store.tabMemory = {
      default: {
        [ROOT]: { projectId: "proj1", tabs: ["s1"], active: "s1" },
        [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" },
      },
    }
    snapshots.set(ROOT, [s1])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])

    store.openFileTab("/repo/README.md")
    expect(store.activeTabKey).toBe("file:/repo/README.md")
    expect(store.tabs.find((t) => t.key === "file:/repo/README.md")?.directory).toBe(ROOT)

    // 切到 WT1：激活随作用域走（WT1 记忆 chat Tab）；file Tab 保留、directory 仍为 ROOT
    await store.setCurrentWorkspace(WT1)
    expect(store.activeTabKey).toBe("chat:s2")
    expect(store.tabs.find((t) => t.key === "file:/repo/README.md")?.directory).toBe(ROOT)

    // 切回主工作区：file Tab 恢复可见（切换不关不归档），激活回退记忆 chat Tab
    await store.setCurrentWorkspace(null)
    expect(store.tabs.some((t) => t.key === "file:/repo/README.md")).toBe(true)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("切到无记忆作用域：闸门激活清算覆盖 file Tab（不再跨作用域保留激活）", async () => {
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])
    store.openFileTab("/repo/a.md")
    expect(store.activeTabKey).toBe("file:/repo/a.md")

    await store.setCurrentWorkspace(WT1)
    expect(store.activeTabKey).toBeNull()
    expect(store.tabs.some((t) => t.key === "file:/repo/a.md")).toBe(true)
  })

  it("关 file Tab：激活回退限同作用域（不落到先开的其他作用域 Tab）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s1, s2))
    store.tabMemory = {
      default: {
        [ROOT]: { projectId: "proj1", tabs: ["s1"], active: "s1" },
        [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" },
      },
    }
    snapshots.set(ROOT, [s1])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])

    await store.setCurrentWorkspace(WT1) // WT1 先开：全局 Tab 序 chat:s2 在前
    await store.setCurrentWorkspace(null)
    store.openFileTab(ROOT + "/a.md")
    expect(store.activeTabKey).toBe(`file:${ROOT}/a.md`)

    store.closeTab(`file:${ROOT}/a.md`)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("关 Tab 激活回退取相邻（左邻优先），而非恒落候选取样首位", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.tabMemory = { default: { [ROOT]: { projectId: "proj1", tabs: ["s1"], active: "s1" } } }
    snapshots.set(ROOT, [s1])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])

    await store.setCurrentWorkspace(WT1) // 先切走再切回，触发 restoreScopeTabs 开 chat:s1
    await store.setCurrentWorkspace(null)
    store.openFileTab(ROOT + "/a.md")
    store.openFileTab(ROOT + "/b.md")
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", `file:${ROOT}/a.md`, `file:${ROOT}/b.md`])

    // 关中间的 a.md：左邻 = chat:s1（不取右邻 b.md）
    store.setActiveTab(`file:${ROOT}/a.md`)
    store.closeTab(`file:${ROOT}/a.md`)
    expect(store.activeTabKey).toBe("chat:s1")

    // 关最左 chat:s1：右邻 = file b.md（pos=0 分支取右邻）
    store.setActiveTab("chat:s1")
    store.closeTab("chat:s1")
    expect(store.activeTabKey).toBe(`file:${ROOT}/b.md`)
  })

  it("closeProject 随项目目录关闭 file Tab（其他项目 file Tab 不受影响）", async () => {
    const p2: Project = { id: "proj2", worktree: "/other", time: { created: 0, updated: 0 }, sandboxes: [] }
    store.projects = [project(), p2]
    store.projectStates.default.opened = ["proj1", "proj2"]
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])
    snapshots.set("/other", [])

    store.openFileTab(ROOT + "/README.md")
    expect(store.tabs.find((t) => t.kind === "file")?.directory).toBe(ROOT)
    await store.openProject("proj2")
    store.openFileTab("/other/x.md")
    expect(store.tabs.filter((t) => t.kind === "file")).toHaveLength(2)

    await store.closeProject("proj1")
    expect(store.tabs.map((t) => t.key)).toEqual(["file:/other/x.md"])
    expect(store.activeTabKey).toBe("file:/other/x.md")
  })

  it("removeWorkspace 随 worktree 关闭 file Tab（无事件兜底的 kind 不残留孤儿）", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s2))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" } } }
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.removeWorktree = async () => {}
    client.listProjects = async () => [{ ...project(), sandboxes: [WT2] }]

    await store.setCurrentWorkspace(WT1)
    store.openFileTab(WT1 + "/a.md")
    expect(store.tabs.some((t) => t.key === `file:${WT1}/a.md`)).toBe(true)

    const res = await store.removeWorkspace(WT1)
    expect(res.ok).toBe(true)
    expect(store.tabs.some((t) => t.directory === WT1)).toBe(false)
  })
})

describe("先切换后加载：openProject 直达工作区", () => {
  it("跨项目直达 worktree 单次切换；幻影 worktree 落回主工作区", async () => {
    const p2: Project = {
      id: "proj2",
      worktree: "/other",
      time: { created: 0, updated: 0 },
      sandboxes: ["/other/wt9"],
    }
    store.projects = [project(), p2]
    snapshots.set("/other", [])
    snapshots.set("/other/wt9", [])

    await store.openProject("proj2", "/other/wt9")
    expect(store.currentProject?.id).toBe("proj2")
    expect(store.projectStates.default.currentWorkspaceId).toBe("/other/wt9")
    expect(store.scopeQuery.directory).toBe("/other/wt9")

    await store.openProject("proj2", "/phantom")
    expect(store.projectStates.default.currentWorkspaceId).toBeNull()
    expect(store.scopeQuery.directory).toBe("/other")
  })
})

describe("busy 补充发送（design-supplement-send）", () => {
  /** 直驱 handleEvent（SSE 已 mock off）：事件信封 { type, properties } */
  function dispatch(ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, ev)
  }

  /** 经真实事件路径置 busy（session.status 信封目录 = ROOT） */
  function setBusy() {
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
  }

  /** 经真实事件路径置 retry（带退避提示，补充发送不得覆写） */
  function setRetry() {
    dispatch({
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 2, message: "rate limited" },
      },
    })
  }

  it("busy 中 sendPrompt：乐观补充追加不误清既有消息，状态保持 busy；真实 user 事件到达即清乐观", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.promptAsync = async () => {}
    // 会话 busy + 已有活跃流式 assistant（created 200，completed 空）
    setBusy()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_a1", sessionID: "s1", role: "assistant", time: { created: 200 } },
      },
    })
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
      },
    })

    const res = await store.sendPrompt("s1", "补充：顺带统计词数")
    expect(res.ok).toBe(true)
    expect(store.statusOf("s1").type).toBe("busy")
    // 排序：流式 assistant 之下追加乐观补充（锚定 maxCreated+1）
    const entries = store.chatEntries("s1")
    expect(entries.map((e) => (e.kind === "optimistic" ? "opt" : e.data.info.id))).toEqual([
      "msg_u1",
      "msg_a1",
      "opt",
    ])

    // 真实补充 user 消息（created 晚于流式 assistant）经 SSE 到达：乐观清空、消息入列
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u2", sessionID: "s1", role: "user", time: { created: 300 } },
      },
    })
    const after = store.chatEntries("s1")
    expect(after.map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual([
      "msg_u1",
      "msg_a1",
      "msg_u2",
    ])
  })

  it("多条乐观并存：首条真实到达清全部（移动端同语义，短暂闪烁可接受）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.promptAsync = async () => {}
    setBusy()

    await store.sendPrompt("s1", "补充一")
    await store.sendPrompt("s1", "补充二")
    expect(store.chatEntries("s1").filter((e) => e.kind === "optimistic")).toHaveLength(2)
    expect(store.chatEntries("s1").map((e) => (e.kind === "optimistic" ? e.data.text : null))).toEqual([
      "补充一",
      "补充二",
    ])

    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
      },
    })
    expect(store.chatEntries("s1").every((e) => e.kind === "message")).toBe(true)
  })

  it("retry 中补充发送：乐观 busy 不覆写 retry（退避提示保持整个 backoff 窗口）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.promptAsync = async () => {}
    setRetry()

    const res = await store.sendPrompt("s1", "补充")
    expect(res.ok).toBe(true)
    expect(store.statusOf("s1")).toEqual({ type: "retry", attempt: 2, message: "rate limited" })
  })
})

describe("斜杠命令发送（design-slash-command SC-4：同步端点无限等待）", () => {
  function dispatch(ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, ev)
  }

  it("长时执行在途：乐观保留不误判失败，完成后 ok:true；真实 user 事件到达即清乐观", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    const run = deferred<void>()
    const sent: unknown[] = []
    client.sendCommand = (...args: unknown[]) => {
      sent.push(...args)
      return run.promise
    }

    const p = store.sendCommand("s1", "review", "--help")
    await Promise.resolve()
    const entries = store.chatEntries("s1")
    expect(entries.map((e) => (e.kind === "optimistic" ? e.data.text : null))).toEqual([
      "/review --help",
    ])

    run.resolve()
    const res = await p
    expect(res.ok).toBe(true)
    expect(sent).toEqual(["s1", ROOT, "review", "--help"])

    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
        parts: [{ id: "prt_1", type: "subtask", command: "review", prompt: "展开正文" }],
      },
    })
    expect(store.chatEntries("s1").every((e) => e.kind === "message")).toBe(true)
  })

  it("真实失败（秒回的 400 类错误）：撤回乐观 + ok:false，由调用方回填草稿", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.sendCommand = async () => {
      throw new ApiError(400, "unknown", "HTTP 400")
    }

    const res = await store.sendCommand("s1", "no-such", "")
    expect(res.ok).toBe(false)
    expect(store.chatEntries("s1")).toHaveLength(0)
  })
})

describe("消息历史上滚翻页（design-message-history-pagination）", () => {
  function msg(id: string, created: number) {
    return { info: { id, sessionID: "s1", role: "user", time: { created } }, parts: [] }
  }

  /** 顺序页夹具：每次 listMessagesPage 调用按序消费；耗尽后复用最后一页 */
  function seedPageClient(pages: Array<{ entries: ReturnType<typeof msg>[]; nextCursor: string | null }>) {
    const calls: Array<{ limit?: number; before?: string }> = []
    return {
      calls,
      client: {
        listMessagesPage: async (
          _sid: string,
          _dir: string,
          opts: { limit?: number; before?: string } = {},
        ) => {
          calls.push(opts)
          return pages[Math.min(calls.length - 1, pages.length - 1)]
        },
      },
    }
  }

  function seedSession() {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    return s1
  }

  it("窗口加载种子 cursor；上滚分页 before 推进；无 cursor 头判穷尽后不再请求", async () => {
    seedSession()
    const { client, calls } = seedPageClient([
      { entries: [msg("m8", 8), msg("m9", 9), msg("m10", 10)], nextCursor: "c8" },
      { entries: [msg("m5", 5), msg("m6", 6), msg("m7", 7)], nextCursor: "c5" },
      { entries: [msg("m1", 1)], nextCursor: null },
      { entries: [], nextCursor: null },
    ])
    ;(store as unknown as { client: unknown }).client = client

    await store.loadSessionMessages("s1", ROOT)
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: "c8",
      exhausted: false,
      loading: false,
      error: false,
    })

    await store.loadEarlierMessages("s1")
    expect(calls[1]).toEqual({ limit: 100, before: "c8" })
    expect(store.sessionPages.get("s1")?.nextCursor).toBe("c5")
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual([
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "m10",
    ])

    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")?.exhausted).toBe(true)
    expect(store.sessionPages.get("s1")?.nextCursor).toBeNull()
    expect(store.chatEntries("s1")).toHaveLength(7)

    // 穷尽后 no-op：不产生新请求
    await store.loadEarlierMessages("s1")
    expect(calls).toHaveLength(3)
  })

  it("无状态种子路径：loadEarlierMessages 先窗口加载种子再分页；种子失败置 error 可重试", async () => {
    seedSession()
    let fail = false
    const calls: Array<{ limit?: number; before?: string }> = []
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async (
        _sid: string,
        _dir: string,
        opts: { limit: number; before?: string },
      ) => {
        calls.push(opts)
        if (fail) throw new Error("boom")
        if (opts.before) return { entries: [msg("m1", 1)], nextCursor: null }
        return { entries: [msg("m8", 8)], nextCursor: "c8" }
      },
    }

    // 种子失败（模拟挂载窗口加载失败后的上滚重试）
    fail = true
    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: null,
      exhausted: false,
      loading: false,
      error: true,
    })

    // 重试：种子成功 → 同一调用继续分页（before 落地）
    fail = false
    await store.loadEarlierMessages("s1")
    expect(calls).toEqual([
      { limit: 100 }, // 失败的种子
      { limit: 100 }, // 重试种子
      { limit: 100, before: "c8" }, // 同调用内继续分页
    ])
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: null,
      exhausted: true,
      loading: false,
      error: false,
    })
    expect(store.chatEntries("s1")).toHaveLength(2)
  })

  it("挂载窗口加载失败置 error 种子：空会话的 error 行可达（无滚动也可重试）", async () => {
    seedSession()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async () => {
        throw new Error("boom")
      },
    }
    await store.loadSessionMessages("s1", ROOT)
    // 失败种子：cursor null + 未穷尽 = 可重试态
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: null,
      exhausted: false,
      loading: false,
      error: true,
    })

    // 网络恢复后点 error 行（= loadEarlierMessages 种子重试）：成功后正常分页
    const d = deferred<{ entries: ReturnType<typeof msg>[]; nextCursor: string | null }>()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async (_sid: string, _dir: string, opts: { before?: string }) => {
        if (opts.before) return d.promise
        return { entries: [msg("m8", 8)], nextCursor: "c8" }
      },
    }
    const p = store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")?.loading).toBe(true)
    d.resolve({ entries: [msg("m1", 1)], nextCursor: null })
    await p
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: null,
      exhausted: true,
      loading: false,
      error: false,
    })
    expect(store.chatEntries("s1")).toHaveLength(2)
  })

  it("error 种子不残留：重激活成功覆盖（review R3-P2 路径 A）", async () => {
    seedSession()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async () => {
        throw new Error("boom")
      },
    }
    await store.loadSessionMessages("s1", ROOT)
    expect(store.sessionPages.get("s1")?.error).toBe(true)

    // 切回 Tab 重挂载重拉成功 → error 种子被覆盖为正常种子（不残留失败行）
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async () => ({ entries: [msg("m8", 8)], nextCursor: "c8" }),
    }
    await store.loadSessionMessages("s1", ROOT)
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: "c8",
      exhausted: false,
      loading: false,
      error: false,
    })
  })

  it("error 种子不残留：对账回填清除（review R3-P2 路径 B）", async () => {
    seedSession()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async () => {
        throw new Error("boom")
      },
    }
    await store.loadSessionMessages("s1", ROOT)
    expect(store.sessionPages.get("s1")?.error).toBe(true)

    // SSE 重连对账回填（直驱 mountReconciler 的真实 onMessagesSnapshot 挂点）
    store.mountReconciler()
    const deps = (
      (store as unknown as { reconciler: { d: unknown } }).reconciler as {
        d: { onMessagesSnapshot: (sid: string, msgs: ReturnType<typeof msg>[]) => void }
      }
    ).d
    deps.onMessagesSnapshot("s1", [msg("m8", 8)])
    expect(store.sessionPages.has("s1")).toBe(false)
    expect(store.chatEntries("s1")).toHaveLength(1)
  })

  it("分页失败置 error 不穷尽；重试成功清 error 并推进", async () => {
    seedSession()
    let fail = false
    const calls: Array<{ limit?: number; before?: string }> = []
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async (
        _sid: string,
        _dir: string,
        opts: { limit: number; before?: string },
      ) => {
        calls.push(opts)
        if (fail) throw new Error("boom")
        if (opts.before) return { entries: [msg("m1", 1)], nextCursor: null }
        return { entries: [msg("m8", 8)], nextCursor: "c8" }
      },
    }

    await store.loadSessionMessages("s1", ROOT)
    fail = true
    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: "c8",
      exhausted: false,
      loading: false,
      error: true,
    })
    expect(store.canLoadEarlier("s1")).toBe(false)

    fail = false
    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")).toEqual({
      nextCursor: null,
      exhausted: true,
      loading: false,
      error: false,
    })
    expect(store.chatEntries("s1")).toHaveLength(2)
  })

  it("in-flight 去重：分页在途时再次触发不重复请求", async () => {
    seedSession()
    const calls: Array<{ limit?: number; before?: string }> = []
    const d = deferred<{ entries: ReturnType<typeof msg>[]; nextCursor: string | null }>()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async (
        _sid: string,
        _dir: string,
        opts: { limit: number; before?: string },
      ) => {
        calls.push(opts)
        if (opts.before) return d.promise
        return { entries: [msg("m8", 8)], nextCursor: "c8" }
      },
    }

    await store.loadSessionMessages("s1", ROOT)
    const p1 = store.loadEarlierMessages("s1")
    const p2 = store.loadEarlierMessages("s1")
    await p2
    expect(calls).toHaveLength(2) // 窗口 1 次 + before 1 次（第二次触发被 loading 守卫挡下）
    d.resolve({ entries: [msg("m5", 5)], nextCursor: null })
    await p1
    expect(calls).toHaveLength(2)
  })

  it("在途竞态：关 Tab 清状态后重开（新状态对象），旧页落地整体丢弃", async () => {
    seedSession()
    const calls: Array<{ limit?: number; before?: string }> = []
    const d = deferred<{ entries: ReturnType<typeof msg>[]; nextCursor: string | null }>()
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async (
        _sid: string,
        _dir: string,
        opts: { limit: number; before?: string },
      ) => {
        calls.push(opts)
        if (opts.before) return d.promise
        return { entries: [msg("m8", 8)], nextCursor: "c8" }
      },
    }

    await store.loadSessionMessages("s1", ROOT)
    const p = store.loadEarlierMessages("s1")
    // 在途期间关 Tab + 重开（挂载窗口加载重建状态）
    ;(store as unknown as { cleanupSessionState: (id: string) => void }).cleanupSessionState("s1")
    await store.loadSessionMessages("s1", ROOT)
    const freshState = store.sessionPages.get("s1")
    expect(freshState?.nextCursor).toBe("c8")
    expect(freshState?.loading).toBe(false)

    d.resolve({ entries: [msg("m5", 5)], nextCursor: "c5" })
    await p
    // 旧页被身份守卫丢弃：新状态未推进、无 loading 残留；消息未合并
    expect(store.sessionPages.get("s1")).toBe(freshState)
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual([
      "m8",
    ])
    expect(calls).toHaveLength(3)
  })

  it("违约 server 防御：空页/全重复页 + 非 null cursor → 零新增判穷尽停链", async () => {
    seedSession()
    const { client } = seedPageClient([
      { entries: [msg("m8", 8)], nextCursor: "c8" },
      // 全重复页（本地已有 m8）+ cursor 仍在：链式条件若只看 cursor 会死循环
      { entries: [msg("m8", 8)], nextCursor: "c8" },
      { entries: [], nextCursor: null },
    ])
    ;(store as unknown as { client: unknown }).client = client

    await store.loadSessionMessages("s1", ROOT)
    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")?.exhausted).toBe(true)
    expect(store.sessionPages.get("s1")?.nextCursor).toBeNull()
  })

  it("重激活窗口重拉不回退已深入的 cursor；更早消息不被窗口区间删除", async () => {
    seedSession()
    const { client, calls } = seedPageClient([
      { entries: [msg("m8", 8), msg("m9", 9), msg("m10", 10)], nextCursor: "c8" },
      { entries: [msg("m5", 5), msg("m6", 6), msg("m7", 7)], nextCursor: "c5" },
      // 重激活的窗口响应（服务端可能又长了）：cursor 锚点更新（c9），但不得覆盖 c5
      { entries: [msg("m9", 9), msg("m10", 10), msg("m11", 11)], nextCursor: "c9" },
    ])
    ;(store as unknown as { client: unknown }).client = client

    await store.loadSessionMessages("s1", ROOT)
    await store.loadEarlierMessages("s1")
    expect(store.sessionPages.get("s1")?.nextCursor).toBe("c5")

    await store.loadSessionMessages("s1", ROOT)
    expect(calls[2]).toEqual({ limit: 100 })
    expect(store.sessionPages.get("s1")?.nextCursor).toBe("c5")
    // 更早累积消息（m5..m7）在窗口删除区间 (9, 11) 之外，全部保留
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual([
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "m10",
      "m11",
    ])
  })

  it("关 Tab 清理分页状态（cleanupSessionState）", async () => {
    seedSession()
    const { client } = seedPageClient([
      { entries: [msg("m8", 8)], nextCursor: "c8" },
    ])
    ;(store as unknown as { client: unknown }).client = client
    await store.loadSessionMessages("s1", ROOT)
    expect(store.sessionPages.has("s1")).toBe(true)
    ;(store as unknown as { cleanupSessionState: (id: string) => void }).cleanupSessionState("s1")
    expect(store.sessionPages.has("s1")).toBe(false)
  })
})

describe("隐式默认模型（D-AM-4 修订）", () => {
  const catalog: ModelCatalog = {
    agents: [],
    models: [
      { id: "glm-5.3", providerID: "zai", name: "GLM 5.3", variants: ["low", "high", "max"] },
      { id: "glm-4", providerID: "zai", name: "GLM 4", variants: ["low", "high"] },
      { id: "glm-air", providerID: "zai", name: "GLM Air", variants: [] },
    ],
  }

  function seedSwitchClient(
    posted: ModelRef[],
    fail = false,
  ): { switchModel: (id: string, model: ModelRef) => Promise<void> } {
    return {
      switchModel: async (_id, model) => {
        if (fail) throw new Error("boom")
        posted.push(model)
      },
    }
  }

  it("会话内切模型成功 → 全局默认隐式写入（含携带 variant）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    s1.model = { id: "glm-5.3", providerID: "zai", variant: "high" }
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.modelCatalogs.set(ROOT, catalog)
    const posted: ModelRef[] = []
    ;(store as unknown as { client: unknown }).client = seedSwitchClient(posted)

    expect(await store.switchSessionModel("s1", "zai", "glm-4")).toBe(true)
    expect(posted).toEqual([{ id: "glm-4", providerID: "zai", variant: "high" }])
    // 最后一次手动选择 = 全局默认（per-profile 持久化通道）
    expect(store.defaultsFor().model).toEqual({ id: "glm-4", providerID: "zai", variant: "high" })
  })

  it("新模型无同名 variant → 默认值省略 variant（携带规则）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    s1.model = { id: "glm-5.3", providerID: "zai", variant: "high" }
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.modelCatalogs.set(ROOT, catalog)
    ;(store as unknown as { client: unknown }).client = seedSwitchClient([])

    await store.switchSessionModel("s1", "zai", "glm-air")
    expect(store.defaultsFor().model).toEqual({ id: "glm-air", providerID: "zai" })
  })

  it("切模型失败 → 默认值不写", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.modelCatalogs.set(ROOT, catalog)
    ;(store as unknown as { client: unknown }).client = seedSwitchClient([], true)

    expect(await store.switchSessionModel("s1", "zai", "glm-4")).toBe(false)
    expect(store.defaultsFor().model).toBeUndefined()
  })

  it("切思考强度成功 → 默认值同步 variant（undefined = 清除）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    s1.model = { id: "glm-5.3", providerID: "zai" }
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.modelCatalogs.set(ROOT, catalog)
    ;(store as unknown as { client: unknown }).client = seedSwitchClient([])

    await store.switchSessionVariant("s1", "zai", "glm-5.3", "max")
    expect(store.defaultsFor().model).toEqual({ id: "glm-5.3", providerID: "zai", variant: "max" })

    await store.switchSessionVariant("s1", "zai", "glm-5.3", undefined)
    expect(store.defaultsFor().model).toEqual({ id: "glm-5.3", providerID: "zai" })
  })

  it("无显式默认且目录已加载 → 新会话应用列表首项", async () => {
    store.modelCatalogs.set(ROOT, catalog)
    let body: { agent?: string; model?: ModelRef } = {}
    ;(store as unknown as { client: unknown }).client = {
      createSession: async (
        _d: string,
        _w: unknown,
        _t: unknown,
        opts: { agent?: string; model?: ModelRef } = {},
      ) => {
        body = opts
        return session("new1", ROOT, { created: 9, updated: 9 })
      },
    }

    await store.createSession()
    expect(body.model).toEqual({ id: "glm-5.3", providerID: "zai" })
  })

  it("显式默认有效 → 新会话按原值应用；失效 variant 只丢 variant；失效模型回退首项", async () => {
    store.modelCatalogs.set(ROOT, catalog)
    const bodies: Array<{ agent?: string; model?: ModelRef }> = []
    ;(store as unknown as { client: unknown }).client = {
      createSession: async (
        _d: string,
        _w: unknown,
        _t: unknown,
        opts: { agent?: string; model?: ModelRef } = {},
      ) => {
        bodies.push(opts)
        return session(`new${bodies.length}`, ROOT, { created: 9, updated: 9 })
      },
    }

    store.defaults = {
      default: { model: { id: "glm-4", providerID: "zai", variant: "high" } },
    }
    await store.createSession({ openTab: false })
    store.defaults = {
      default: { model: { id: "glm-4", providerID: "zai", variant: "gone" } },
    }
    await store.createSession({ openTab: false })
    store.defaults = { default: { model: { id: "gone", providerID: "zai" } } }
    await store.createSession({ openTab: false })

    expect(bodies[0].model).toEqual({ id: "glm-4", providerID: "zai", variant: "high" })
    expect(bodies[1].model).toEqual({ id: "glm-4", providerID: "zai" })
    expect(bodies[2].model).toEqual({ id: "glm-5.3", providerID: "zai" })
  })

  it("目录未加载且无显式默认 → 不带 model（服务器默认）", async () => {
    let body: { agent?: string; model?: ModelRef } = {}
    ;(store as unknown as { client: unknown }).client = {
      createSession: async (
        _d: string,
        _w: unknown,
        _t: unknown,
        opts: { agent?: string; model?: ModelRef } = {},
      ) => {
        body = opts
        return session("new1", ROOT, { created: 9, updated: 9 })
      },
    }

    await store.createSession({ openTab: false })
    expect(body.model).toBeUndefined()
  })
})

describe("diff Tab：每作用域单 Tab + segment 切换（design-diff-view §2/§3）", () => {
  /** 在既有 fake client 上挂 listVcsDiff spy */
  function vcsClient() {
    const listVcsDiff = vi.fn(async (_dir: string, _mode: "git" | "branch") => [])
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.listVcsDiff = listVcsDiff
    return listVcsDiff
  }

  it("openDiffTab 开单 Tab：缺省选中 uncommitted 并按其加载", async () => {
    const listVcsDiff = vcsClient()
    store.openDiffTab()
    expect(store.tabs.map((t) => t.key)).toEqual([diffTabKey(ROOT)])
    expect(store.diffTypeFor(diffTabKey(ROOT))).toBe("uncommitted")
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledWith(ROOT, "git"))
  })

  it("重复点击缺省选中不重拉（守卫比对有效选中，含兜底值）", async () => {
    const listVcsDiff = vcsClient()
    store.openDiffTab()
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(1))
    store.switchDiffType(diffTabKey(ROOT), "uncommitted")
    expect(listVcsDiff).toHaveBeenCalledTimes(1)
  })

  it("切换 segment：更新选中并加载该来源；再点当前选中不重拉", async () => {
    const listVcsDiff = vcsClient()
    store.openDiffTab()
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(1))
    store.switchDiffType(diffTabKey(ROOT), "branch")
    expect(store.diffTypeFor(diffTabKey(ROOT))).toBe("branch")
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(2))
    expect(listVcsDiff).toHaveBeenLastCalledWith(ROOT, "branch")
    store.switchDiffType(diffTabKey(ROOT), "branch")
    expect(listVcsDiff).toHaveBeenCalledTimes(2)
  })

  it("关闭 Tab 卸载三来源缓存与选中：重开回到缺省", async () => {
    const listVcsDiff = vcsClient()
    const key = diffTabKey(ROOT)
    store.openDiffTab()
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(1))
    store.switchDiffType(key, "branch")
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(2))
    store.closeTab(key)
    expect(store.tabs).toHaveLength(0)
    expect(store.diffSelectedTypes.has(key)).toBe(false)
    expect(store.diffData.size).toBe(0)
    // 重开：选中回缺省并重新加载（不复用旧缓存）
    store.openDiffTab()
    expect(store.diffTypeFor(key)).toBe("uncommitted")
    await vi.waitFor(() => expect(listVcsDiff).toHaveBeenCalledTimes(3))
  })
})

describe("文件监听（design-file-watcher）", () => {
  function dispatch(dir: string, ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (d: string, e: unknown) => void }).handleEvent(dir, ev)
  }

  function watcherEvent(dir: string, file: string, event: string) {
    dispatch(dir, { type: "file.watcher.updated", properties: { file, event } })
  }

  /** file Tab 夹具：直接入列（避免 openFileTab 的首拉副作用），缓存置 v1 */
  function fileTab(path: string, directory = ROOT) {
    store.tabs.push({
      kind: "file",
      key: `file:${path}`,
      projectId: "proj1",
      title: path.split("/").pop() ?? path,
      directory,
    })
    store.fileContents.set(path, { content: "v1" })
  }

  function clientRef(): Record<string, unknown> {
    return (store as unknown as { client: Record<string, unknown> }).client
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("change 已打开文件 Tab：去抖后按 Tab 作用域重拉刷新内容", async () => {
    fileTab(ROOT + "/src/a.ts")
    const readFileContent = vi.fn(async () => "v2")
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/src/a.ts", "change")
    expect(readFileContent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).toHaveBeenCalledWith(ROOT, ROOT + "/src/a.ts")
    expect(store.fileContents.get(ROOT + "/src/a.ts")).toEqual({ content: "v2" })
  })

  it("去抖窗口内多次事件合并为一次重拉", async () => {
    fileTab(ROOT + "/a.ts")
    const readFileContent = vi.fn(async () => "v2")
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS - 1)
    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).toHaveBeenCalledTimes(1)
  })

  it("在途期间落地的后续修改不丢：singleflight + dirty 再武装", async () => {
    fileTab(ROOT + "/a.ts")
    let resolveFirst!: (v: string) => void
    const first = new Promise<string>((r) => {
      resolveFirst = r
    })
    const readFileContent = vi.fn().mockReturnValueOnce(first).mockResolvedValue("v3")
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS) // 首次 fetch 在途
    expect(readFileContent).toHaveBeenCalledTimes(1)
    watcherEvent(ROOT, ROOT + "/a.ts", "change") // 在途 → 只置 dirty 不并发
    resolveFirst("v2")
    await vi.advanceTimersByTimeAsync(0) // 首次落地 + dirty 再武装
    expect(store.fileContents.get(ROOT + "/a.ts")).toEqual({ content: "v2" })
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS) // 补排的重拉
    expect(readFileContent).toHaveBeenCalledTimes(2)
    expect(store.fileContents.get(ROOT + "/a.ts")).toEqual({ content: "v3" })
  })

  it("无 Tab 的文件不重拉（缓存不可见，重开必重拉）", async () => {
    const readFileContent = vi.fn(async () => "v2")
    clientRef().readFileContent = readFileContent
    watcherEvent(ROOT, ROOT + "/ghost.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).not.toHaveBeenCalled()
  })

  it("unlink 走同一重拉路径：读取失败落 error 条目（FileView 错误态）", async () => {
    fileTab(ROOT + "/gone.ts")
    clientRef().readFileContent = vi.fn(async () => {
      throw new ApiError(404, "not-found", "file not found")
    })
    watcherEvent(ROOT, ROOT + "/gone.ts", "unlink")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(store.fileContents.get(ROOT + "/gone.ts")?.error).toBeTruthy()
  })

  it("worktree 物理位于 .git/ 之下不误杀：相对化判定只滤信封目录内的 .git", async () => {
    store.projectStates.default.currentWorkspaceId = WT1 // 作用域 = WT1
    fileTab(WT1 + "/a.ts", WT1)
    const readFileContent = vi.fn(async () => "v2")
    clientRef().readFileContent = readFileContent

    // .git 内事件（相对作用域以 .git/ 开头）仍被滤
    watcherEvent(WT1, WT1 + "/.git/index", "change")
    // worktree 内正常文件（绝对路径含 /.git/ 但相对化后不在 .git 内）放行
    watcherEvent(WT1, WT1 + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).toHaveBeenCalledTimes(1)
    expect(readFileContent).toHaveBeenCalledWith(WT1, WT1 + "/a.ts")
  })

  it("file 不在信封目录内（git 元数据帧）丢弃", async () => {
    store.fileTreeNodes.set(".", [])
    const listFiles = vi.fn(async () => [])
    clientRef().listFiles = listFiles
    watcherEvent(WT1, ROOT + "/.git/worktrees/wt1/index.lock", "add")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(listFiles).not.toHaveBeenCalled()
  })

  it("add/unlink 重列已加载父目录；未加载父目录不触发", async () => {
    store.fileTreeNodes.set(".", [])
    store.fileTreeNodes.set("src/", [])
    const listFiles = vi.fn(async () => [])
    clientRef().listFiles = listFiles

    watcherEvent(ROOT, ROOT + "/src/new.ts", "add")
    watcherEvent(ROOT, ROOT + "/deep/new.ts", "add") // deep/ 未加载
    watcherEvent(ROOT, ROOT + "/top.ts", "unlink") // 父 = 根（"."）
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(listFiles).toHaveBeenCalledTimes(2)
    expect(listFiles).toHaveBeenCalledWith(ROOT, "src/", undefined)
    expect(listFiles).toHaveBeenCalledWith(ROOT, ".", undefined)
  })

  it("change 已加载目录节点重列自身；文件 change 不触发树刷新", async () => {
    store.fileTreeNodes.set(".", [])
    store.fileTreeNodes.set("src/", [])
    const listFiles = vi.fn(async () => [])
    clientRef().listFiles = listFiles

    watcherEvent(ROOT, ROOT + "/src", "change")
    watcherEvent(ROOT, ROOT + "/src/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listFiles).toHaveBeenCalledWith(ROOT, "src/", undefined)
  })

  it("树重置（切作用域）作废挂起的树刷新：定时器不打进新作用域", async () => {
    store.fileTreeNodes.set(".", [])
    store.fileTreeNodes.set("src/", [])
    const listFiles = vi.fn(async () => [])
    clientRef().listFiles = listFiles
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])

    watcherEvent(ROOT, ROOT + "/src/new.ts", "add")
    await store.setCurrentWorkspace(WT1) // resetFileTree 清树 + 挂起树刷新
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(listFiles).not.toHaveBeenCalled()
    expect(store.fileTreeNodes.size).toBe(0)
  })

  it("事件信封目录 ≠ 当前作用域：树不刷新（内容重拉不受影响，见上）", async () => {
    store.fileTreeNodes.set(".", [])
    const listFiles = vi.fn(async () => [])
    clientRef().listFiles = listFiles

    watcherEvent(WT1, WT1 + "/x.ts", "add") // 当前作用域 = ROOT
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(listFiles).not.toHaveBeenCalled()
  })
})
