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
import { globalEntryKey } from "@shared/project-entries"
import type { ModelCatalog } from "@shared/model-catalog"
import type { MessageWithParts, ModelRef, Part, Project, Session } from "@shared/api-types"

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
const browserCalls: string[] = []

beforeEach(() => {
  ;(window as unknown as { desktop: unknown }).desktop = {
    storeGet: async () => null,
    storeSet: async () => {},
    browserViewCreate: vi.fn(async () => 1),
    browserViewBounds: vi.fn(),
    browserViewShow: vi.fn(),
    browserViewHide: vi.fn(),
    browserViewDispose: vi.fn(),
    browserNavigate: vi.fn(),
    browserGoBack: vi.fn(),
    browserGoForward: vi.fn(),
    browserReload: vi.fn(),
    browserStop: vi.fn(),
    onBrowserViewState: () => () => {},
  }
  browserCalls.length = 0
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
  it("file Tab 激活时切 worktree：激活随新作用域走；file Tab 不关闭（隐藏），切回恢复可见并恢复激活（规则 1.5）", async () => {
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

    // 切回主工作区：file Tab 恢复可见（切换不关不归档）且恢复激活——运行期最后
    // 选中态任意 kind（规则 1.5，design-tab-state-memory §2.1；2026-08-26 修订，
    // 原"回退记忆 chat Tab"见 design-tab-memory §7）
    await store.setCurrentWorkspace(null)
    expect(store.tabs.some((t) => t.key === "file:/repo/README.md")).toBe(true)
    expect(store.activeTabKey).toBe("file:/repo/README.md")
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
    client.deleteSession = async () => {}
    client.listProjects = async () => [{ ...project(), sandboxes: [WT2] }]

    await store.setCurrentWorkspace(WT1)
    store.openFileTab(WT1 + "/a.md")
    expect(store.tabs.some((t) => t.key === `file:${WT1}/a.md`)).toBe(true)

    const res = await store.removeWorkspace(WT1)
    expect(res.ok).toBe(true)
    expect(store.tabs.some((t) => t.directory === WT1)).toBe(false)
  })

  it("removeWorkspace 非阻塞删除态：在途 isWorkspaceDeleting 置位（左栏行禁用/loading），成功后复位、行随 sandboxes 消失", async () => {
    const client = (store as unknown as { client: Record<string, unknown> }).client
    snapshots.set(ROOT, [])
    snapshots.set(WT2, [])
    let resolveRemove!: () => void
    client.removeWorktree = () => new Promise<void>((r) => (resolveRemove = r))
    client.deleteSession = async () => {}
    client.listProjects = async () => [{ ...project(), sandboxes: [WT2] }]
    store.projectStates.default.currentWorkspaceId = WT1

    const pending = store.removeWorkspace(WT1)
    // 同步段（未 await）：删除态已置位、重入被拒；删当前 worktree 作用域立即跳回项目根
    // （先切换后加载，不等服务端清理完成）
    expect(store.isWorkspaceDeleting("proj1", WT1)).toBe(true)
    expect(await store.removeWorkspace(WT1)).toEqual({ ok: false, error: "deleting" })
    expect(store.isWorkspaceDeleting("proj1", WT1)).toBe(true)
    expect(store.projectStates.default.currentWorkspaceId).toBeNull()
    expect(store.scopeQuery.directory).toBe(ROOT)

    resolveRemove()
    const res = await pending
    expect(res.ok).toBe(true)
    expect(store.isWorkspaceDeleting("proj1", WT1)).toBe(false)
    expect(store.workspacesOfProject("proj1").some((w) => w.directory === WT1)).toBe(false)
    expect(store.projectStates.default.currentWorkspaceId).toBeNull()
  })

  it("removeWorkspace 删除失败：删除态复位（行恢复可点），worktree 仍在列表", async () => {
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.removeWorktree = async () => {
      throw new Error("git worktree remove failed")
    }
    client.deleteSession = async () => {}

    const res = await store.removeWorkspace(WT1)
    expect(res.ok).toBe(false)
    expect(store.isWorkspaceDeleting("proj1", WT1)).toBe(false)
    expect(store.workspacesOfProject("proj1").some((w) => w.directory === WT1)).toBe(true)
  })

  it("openFileTab revealLine：携带时设置，无锚点调用时清除残留", () => {
    snapshots.set(ROOT, [])
    store.openFileTab(ROOT + "/a.md", 42)
    const tab = store.tabs.find((t) => t.key === `file:${ROOT}/a.md`)!
    expect(tab.revealLine).toBe(42)

    // 复用已开 Tab 且不传 revealLine → 清除残留（防过时行号强制源码模式）
    store.openFileTab(ROOT + "/a.md")
    expect(store.tabs.find((t) => t.key === `file:${ROOT}/a.md`)?.revealLine).toBeUndefined()
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

describe("合成 text part 过滤（design-file-reference §5，引用回显只画用户文本 + 文件 chip）", () => {
  function dispatch(ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, ev)
  }

  function userUpdated(id: string, created: number) {
    dispatch({
      type: "message.updated",
      properties: { sessionID: "s1", info: { id, sessionID: "s1", role: "user", time: { created } } },
    })
  }

  function partUpdated(part: Record<string, unknown>) {
    dispatch({ type: "message.part.updated", properties: { sessionID: "s1", part } })
  }

  beforeEach(() => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
  })

  it("SSE：synthetic text part（Read 回显/文件内容）不入 parts，用户文本与引用 file part 正常入", () => {
    userUpdated("msg_u1", 100)
    partUpdated({ id: "prt_u", sessionID: "s1", messageID: "msg_u1", type: "text", text: "看下这个文件" })
    partUpdated({
      id: "prt_s1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "text",
      text: 'Called the Read tool with the following input: {"filePath":"/repo/a.ts"}',
      synthetic: true,
    })
    partUpdated({
      id: "prt_s2",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "text",
      text: "<path>/repo/a.ts</path>\n<content>…文件内容…</content>",
      synthetic: true,
    })
    partUpdated({
      id: "prt_f1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "file",
      mime: "text/plain",
      url: "file:///repo/a.ts",
      filename: "a.ts",
      source: { type: "file", path: "a.ts", text: { value: "", start: 0, end: 0 } },
    })
    const entries = store.chatEntries("s1")
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe("message")
    const parts = (entries[0] as { data: MessageWithParts }).data.parts
    expect(parts.map((p) => p.id)).toEqual(["prt_u", "prt_f1"])
  })

  it("part 先于 message.updated 到达：pendingParts 缓存同样过滤，回放不含合成 part", () => {
    partUpdated({ id: "prt_s1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "内容", synthetic: true })
    partUpdated({ id: "prt_u", sessionID: "s1", messageID: "msg_u1", type: "text", text: "正文" })
    userUpdated("msg_u1", 100)
    const entries = store.chatEntries("s1")
    const parts = (entries[0] as { data: MessageWithParts }).data.parts
    expect(parts.map((p) => p.id)).toEqual(["prt_u"])
  })

  it("纯合成 user 消息（真实载荷：单合成 text part，无 tool part）不进渲染列表", () => {
    // server injectBackgroundResult（tool/task.ts）：user 消息仅一个 synthetic
    // text part（"Background task completed: …"）——滤空后 parts:[]，守卫须隐藏
    userUpdated("msg_u1", 100)
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual(["msg_u1"])
    partUpdated({
      id: "prt_s1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "text",
      text: "Background task completed: build docs",
      synthetic: true,
    })
    expect(store.chatEntries("s1")).toHaveLength(0)
  })

  it("compaction 续跑消息（单合成 text part）同样隐藏", () => {
    userUpdated("msg_u1", 100)
    partUpdated({
      id: "prt_s1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "text",
      text: "Continue if you have next steps…",
      synthetic: true,
    })
    expect(store.chatEntries("s1")).toHaveLength(0)
  })

  it("真实 parts 后到（在途窗口）：合成 part 到达前 parts:[] 保留显示", () => {
    // 正常发送流：message.updated 先到（parts:[]，无合成登记）→ 保留；
    // 随后用户文本 part 到达 → 持续可见
    userUpdated("msg_u1", 100)
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual(["msg_u1"])
    partUpdated({ id: "prt_u", sessionID: "s1", messageID: "msg_u1", type: "text", text: "正文" })
    expect(store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))).toEqual(["msg_u1"])
  })

  it("快照路径（loadSessionMessages）：全合成消息登记并隐藏，混合消息正常", async () => {
    ;(store as unknown as { client: unknown }).client = {
      listMessagesPage: async () => ({
        entries: [
          {
            info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
            parts: [
              { id: "prt_s1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "Background task completed", synthetic: true },
            ],
          },
          {
            info: { id: "msg_u2", sessionID: "s1", role: "user", time: { created: 200 } },
            parts: [
              { id: "prt_u2", sessionID: "s1", messageID: "msg_u2", type: "text", text: "看下这个文件" },
              { id: "prt_s2", sessionID: "s1", messageID: "msg_u2", type: "text", text: "<content>…</content>", synthetic: true },
              {
                id: "prt_f2",
                sessionID: "s1",
                messageID: "msg_u2",
                type: "file",
                mime: "text/plain",
                url: "file:///repo/a.ts",
                filename: "a.ts",
                source: { type: "file", path: "a.ts", text: { value: "", start: 0, end: 0 } },
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    }
    await store.loadSessionMessages("s1", ROOT)
    const ids = store.chatEntries("s1").map((e) => (e.kind === "message" ? e.data.info.id : e.kind))
    expect(ids).toEqual(["msg_u2"])
    const parts = (store.chatEntries("s1")[0] as { data: MessageWithParts }).data.parts
    expect(parts.map((p) => p.id)).toEqual(["prt_u2", "prt_f2"])
  })

  it("纯引用发送（无用户文本）：file part 保持可渲染，消息不剔除", () => {
    userUpdated("msg_u1", 100)
    partUpdated({
      id: "prt_s1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "text",
      text: "Called the Read tool...",
      synthetic: true,
    })
    partUpdated({
      id: "prt_f1",
      sessionID: "s1",
      messageID: "msg_u1",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AA==",
      filename: "logo.png",
      synthetic: true,
    })
    const entries = store.chatEntries("s1")
    expect(entries).toHaveLength(1)
    expect((entries[0] as { data: MessageWithParts }).data.parts.map((p) => p.id)).toEqual(["prt_f1"])
  })
})

describe("会话任务列表（design-task-list）", () => {
  function dispatch(dir: string, ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(dir, ev)
  }

  it("todo.updated 全量替换（非合并）+ 空表 = server 侧清空", () => {
    dispatch(ROOT, {
      type: "todo.updated",
      properties: { sessionID: "s1", todos: [{ content: "a", status: "in_progress", priority: "high" }] },
    })
    expect(store.todosForSession("s1")).toEqual([
      { content: "a", status: "in_progress", priority: "high" },
    ])
    dispatch(ROOT, {
      type: "todo.updated",
      properties: { sessionID: "s1", todos: [{ content: "b", status: "pending", priority: "low" }] },
    })
    expect(store.todosForSession("s1")).toEqual([{ content: "b", status: "pending", priority: "low" }])
    dispatch(ROOT, { type: "todo.updated", properties: { sessionID: "s1", todos: [] } })
    expect(store.todosForSession("s1")).toEqual([])
  })

  it("畸形载荷（todos 缺失/非数组）忽略保留本地，显式 [] 才权威清空（review #2）", () => {
    dispatch(ROOT, {
      type: "todo.updated",
      properties: { sessionID: "s1", todos: [{ content: "a", status: "pending", priority: "low" }] },
    })
    dispatch(ROOT, { type: "todo.updated", properties: { sessionID: "s1" } })
    dispatch(ROOT, { type: "todo.updated", properties: { sessionID: "s1", todos: "oops" } })
    expect(store.todosForSession("s1")).toEqual([{ content: "a", status: "pending", priority: "low" }])
    dispatch(ROOT, { type: "todo.updated", properties: { sessionID: "s1", todos: [] } })
    expect(store.todosForSession("s1")).toEqual([])
  })

  it("事件闸门：关闭项目目录的事件被丢弃", () => {
    dispatch("/other", {
      type: "todo.updated",
      properties: { sessionID: "s1", todos: [{ content: "a", status: "pending", priority: "low" }] },
    })
    expect(store.sessionTodos.has("s1")).toBe(false)
  })

  it("loadSessionTodos：成功整表覆盖、失败保留本地、空数组权威清空", async () => {
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.listSessionTodos = async () => [{ content: "r", status: "pending", priority: "medium" }]
    await store.loadSessionTodos("s1", ROOT)
    expect(store.todosForSession("s1")).toEqual([{ content: "r", status: "pending", priority: "medium" }])
    client.listSessionTodos = async () => {
      throw new Error("boom")
    }
    await store.loadSessionTodos("s1", ROOT)
    expect(store.todosForSession("s1")).toEqual([{ content: "r", status: "pending", priority: "medium" }])
    client.listSessionTodos = async () => []
    await store.loadSessionTodos("s1", ROOT)
    expect(store.todosForSession("s1")).toEqual([])
  })

  it("会话删除事件清理任务列表（cleanupSessionState 挂点）", () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    dispatch(ROOT, {
      type: "todo.updated",
      properties: { sessionID: "s1", todos: [{ content: "a", status: "pending", priority: "low" }] },
    })
    dispatch(ROOT, { type: "session.deleted", properties: { sessionID: "s1", info: s1 } })
    expect(store.sessionTodos.has("s1")).toBe(false)
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
    // 第 5 参 = 引用 file parts（无引用时 undefined，design-file-reference §4）
    expect(sent).toEqual(["s1", ROOT, "review", "--help", undefined])

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

  /** readFileContent mock 返回值：FileContentData 文本条目 */
  function fc(content: string) {
    return { type: "text" as const, content }
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
    const readFileContent = vi.fn(async () => fc("v2"))
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/src/a.ts", "change")
    expect(readFileContent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).toHaveBeenCalledWith(ROOT, ROOT + "/src/a.ts")
    expect(store.fileContents.get(ROOT + "/src/a.ts")).toEqual({ content: "v2" })
  })

  it("二进制图片重拉：缓存条目保留 binary/mimeType（图片预览分发依据）", async () => {
    fileTab(ROOT + "/a.png")
    clientRef().readFileContent = vi.fn(async () => ({
      type: "binary" as const,
      content: "QUJD",
      encoding: "base64" as const,
      mimeType: "image/png",
    }))
    watcherEvent(ROOT, ROOT + "/a.png", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(store.fileContents.get(ROOT + "/a.png")).toEqual({
      content: "QUJD",
      binary: true,
      mimeType: "image/png",
    })
  })

  it("去抖窗口内多次事件合并为一次重拉", async () => {
    fileTab(ROOT + "/a.ts")
    const readFileContent = vi.fn(async () => fc("v2"))
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS - 1)
    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS)
    expect(readFileContent).toHaveBeenCalledTimes(1)
  })

  it("在途期间落地的后续修改不丢：singleflight + dirty 再武装", async () => {
    fileTab(ROOT + "/a.ts")
    let resolveFirst!: (v: ReturnType<typeof fc>) => void
    const first = new Promise<ReturnType<typeof fc>>((r) => {
      resolveFirst = r
    })
    const readFileContent = vi.fn().mockReturnValueOnce(first).mockResolvedValue(fc("v3"))
    clientRef().readFileContent = readFileContent

    watcherEvent(ROOT, ROOT + "/a.ts", "change")
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS) // 首次 fetch 在途
    expect(readFileContent).toHaveBeenCalledTimes(1)
    watcherEvent(ROOT, ROOT + "/a.ts", "change") // 在途 → 只置 dirty 不并发
    resolveFirst(fc("v2"))
    await vi.advanceTimersByTimeAsync(0) // 首次落地 + dirty 再武装
    expect(store.fileContents.get(ROOT + "/a.ts")).toEqual({ content: "v2" })
    await vi.advanceTimersByTimeAsync(FILE_WATCH_DEBOUNCE_MS) // 补排的重拉
    expect(readFileContent).toHaveBeenCalledTimes(2)
    expect(store.fileContents.get(ROOT + "/a.ts")).toEqual({ content: "v3" })
  })

  it("无 Tab 的文件不重拉（缓存不可见，重开必重拉）", async () => {
    const readFileContent = vi.fn(async () => fc("v2"))
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
    const readFileContent = vi.fn(async () => fc("v2"))
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

// 回滚到指定消息（design-message-revert §3.3）：暂存合并 + 草稿回填 + 撤销；
// busy 先 abort 再回滚（官方 halt→stage）；409 经 connectionError 呈现
describe("回滚到指定消息（design-message-revert）", () => {
  function seedSession(): Session {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    return s1
  }

  /** 注入已加载的 user 消息（text part），供草稿回填取值 */
  function seedUserMessage(text: string) {
    const parts: Part[] = [
      { id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "text", text } as Part,
    ]
    store.messagesBySession.set(
      "s1",
      new Map([
        [
          "msg_u1",
          {
            info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 1 } },
            parts,
          },
        ],
      ]),
    )
  }

  it("revertToMessage：合并返回 Session 的 revert 字段 + 回填草稿", async () => {
    seedSession()
    seedUserMessage("帮我写个函数")
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.revertMessage = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 2 }),
      revert: { messageID: "msg_u1" },
    })

    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(true)
    expect(store.findSession("s1")?.revert?.messageID).toBe("msg_u1")
    // 草稿回填：回滚点 user 消息文本；take 即清，二次取空
    expect(store.takeRevertDraft("s1")).toBe("帮我写个函数")
    expect(store.takeRevertDraft("s1")).toBeNull()
  })

  it("revertToMessage 无 text part（subtask 命令回显）：不回填草稿", async () => {
    seedSession()
    store.messagesBySession.set(
      "s1",
      new Map([
        [
          "msg_u1",
          {
            info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 1 } },
            parts: [
              { id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "subtask", command: "init" } as Part,
            ],
          },
        ],
      ]),
    )
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.revertMessage = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 2 }),
      revert: { messageID: "msg_u1" },
    })

    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(true)
    expect(store.takeRevertDraft("s1")).toBeNull()
  })

  it("revertToMessage text 展开型命令回显（sendCommand 标记）：不回填草稿", async () => {
    seedSession()
    const client = (store as unknown as { client: Record<string, unknown> }).client
    // 同步端点：回显（SSE message.updated）在 POST await 期间到达
    const run = deferred<void>()
    client.sendCommand = () => run.promise

    const p = store.sendCommand("s1", "init", "--foo")
    // part 先于 message.info 到达（pendingParts 回放路径，同真实 SSE 顺序）
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, {
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: { id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "展开的模板全文" },
      },
    })
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, {
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
        // skill/非 subtask 命令展开为 text part（展开模板，非用户原文）
        parts: [{ id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "展开的模板全文" }],
      },
    })
    run.resolve()
    expect(await p).toEqual({ ok: true })
    // 回显已加载且有 text（排除「消息未加载导致空回填」的假阳性）
    expect(store.chatEntries("s1")).toEqual([
      {
        kind: "message",
        data: expect.objectContaining({
          info: expect.objectContaining({ id: "msg_u1", role: "user" }),
          parts: [expect.objectContaining({ type: "text", text: "展开的模板全文" })],
        }),
      },
    ])

    client.revertMessage = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 2 }),
      revert: { messageID: "msg_u1" },
    })
    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(true)
    expect(store.takeRevertDraft("s1")).toBeNull()
  })

  it("sendCommand 失败：回显标记清除，后续普通消息回滚仍回填", async () => {
    seedSession()
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.sendCommand = async () => {
      throw new ApiError(400, "unknown", "HTTP 400")
    }
    const res = await store.sendCommand("s1", "no-such", "")
    expect(res.ok).toBe(false)

    // 失败后用户手输的普通消息不得被残留标记误判为命令回显
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, {
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: { id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "手输的普通消息" },
      },
    })
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, {
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 100 } },
        parts: [{ id: "prt_1", sessionID: "s1", messageID: "msg_u1", type: "text", text: "手输的普通消息" }],
      },
    })
    client.revertMessage = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 2 }),
      revert: { messageID: "msg_u1" },
    })
    await store.revertToMessage("s1", "msg_u1")
    expect(store.takeRevertDraft("s1")).toBe("手输的普通消息")
  })

  it("busy 中 revertToMessage：先 abort 再 revert（官方 halt→stage）", async () => {
    seedSession()
    const calls: string[] = []
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.abortSession = async () => {
      calls.push("abort")
    }
    client.revertMessage = async () => {
      calls.push("revert")
      return { ...session("s1", ROOT, { created: 1, updated: 2 }), revert: { messageID: "msg_u1" } }
    }
    // 经真实事件路径置 busy
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, {
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })

    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(true)
    expect(calls).toEqual(["abort", "revert"])
  })

  it("revertToMessage 409：ok:false 且 connectionError 记录", async () => {
    seedSession()
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.revertMessage = async () => {
      throw new ApiError(409, "unknown", "HTTP 409")
    }
    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(false)
    expect(store.connectionError).toBeTruthy()
  })

  it("unrevertSession：合并返回 Session（revert 清空）+ 已回填会话空种子清空输入框", async () => {
    const s1 = seedSession()
    store.sessionsByProject.set("proj1", sessionsOf({ ...s1, revert: { messageID: "msg_u1" } }))
    // 回填种子已被 ChatView 消费（输入框正承载回填文本）
    ;(store as unknown as { revertDrafts: Map<string, string> }).revertDrafts.set("s1", "回滚回填的草稿")
    expect(store.takeRevertDraft("s1")).toBe("回滚回填的草稿")
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.unrevertSession = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 3 }),
      revert: null,
    })

    const res = await store.unrevertSession("s1")
    expect(res.ok).toBe(true)
    expect(store.findSession("s1")?.revert).toBeNull()
    // 空种子 = 清输入框（官方 restore→promptSession.reset 语义）
    expect(store.takeRevertDraft("s1")).toBe("")
  })

  it("unrevertSession 跨客户端暂存（本端未回填）：不清空用户自输内容", async () => {
    const s1 = seedSession()
    store.sessionsByProject.set("proj1", sessionsOf({ ...s1, revert: { messageID: "msg_u1" } }))
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.unrevertSession = async () => ({
      ...session("s1", ROOT, { created: 1, updated: 3 }),
      revert: null,
    })

    const res = await store.unrevertSession("s1")
    expect(res.ok).toBe(true)
    expect(store.takeRevertDraft("s1")).toBeNull()
  })

  it("unrevertSession 无暂存回滚：不置种子（不误清用户输入）", async () => {
    seedSession()
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.unrevertSession = async () => session("s1", ROOT, { created: 1, updated: 3 })

    const res = await store.unrevertSession("s1")
    expect(res.ok).toBe(true)
    expect(store.takeRevertDraft("s1")).toBeNull()
  })

  it("revertToMessage server 未暂存（消息已不存在）：ok:false 且不回填", async () => {
    seedSession()
    seedUserMessage("帮我写个函数")
    const client = (store as unknown as { client: Record<string, unknown> }).client
    // server 侧消息不存在 → revert.ts no-op，返回无 revert 字段的原会话
    client.revertMessage = async () => session("s1", ROOT, { created: 1, updated: 1 })

    const res = await store.revertToMessage("s1", "msg_u1")
    expect(res.ok).toBe(false)
    expect(store.connectionError).toBeTruthy()
    expect(store.findSession("s1")?.revert).toBeUndefined()
    expect(store.takeRevertDraft("s1")).toBeNull()
  })
})

describe("输入草稿（design-compose-draft）", () => {
  it("chat 草稿：写读往返，空文本 = 删条目（发送成功即清语义）", () => {
    store.setChatDraft("s1", "未发送内容")
    expect(store.chatDraftFor("s1")).toBe("未发送内容")
    store.setChatDraft("s1", "")
    expect(store.chatDraftFor("s1")).toBe("")
    expect((store as unknown as { chatDrafts: Map<string, string> }).chatDrafts.size).toBe(0)
  })

  it("引导页草稿：按作用域目录写读往返，互不串用", () => {
    store.setGuideDraft(ROOT, "主工作区草稿")
    expect(store.guideDraftFor(ROOT)).toBe("主工作区草稿")
    expect(store.guideDraftFor(WT1)).toBe("")
    store.setGuideDraft(ROOT, "")
    expect(store.guideDraftFor(ROOT)).toBe("")
  })

  it("关 chat Tab 清该会话草稿（关 = 归档决断，重开不复活旧草稿）", () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.openChatTab(s1)
    store.setChatDraft("s1", "未发送内容")
    store.closeTab("chat:s1")
    expect(store.chatDraftFor("s1")).toBe("")
  })

  it("会话已不存在时 closeChatTab：视为成功关闭且草稿随运行时卸载", async () => {
    store.setChatDraft("gone", "未发送内容")
    const ok = await store.closeChatTab("gone", { streaming: false })
    expect(ok).toBe(true)
    expect(store.chatDraftFor("gone")).toBe("")
  })

  it("closeProject 清该项目各目录作用域的引导页草稿", async () => {
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])
    store.setGuideDraft(ROOT, "主工作区草稿")
    store.setGuideDraft(WT1, "工作树草稿")
    await store.closeProject("proj1")
    expect(store.guideDraftFor(ROOT)).toBe("")
    expect(store.guideDraftFor(WT1)).toBe("")
  })

  it("拆连接清空全部草稿（切 profile 不串，移动端 CD-24/30：丢远轻于串）", async () => {
    store.setChatDraft("s1", "未发送内容")
    store.setGuideDraft(ROOT, "引导页草稿")
    await store.disconnect()
    expect(store.chatDraftFor("s1")).toBe("")
    expect(store.guideDraftFor(ROOT)).toBe("")
  })
})

describe("Tab 状态记忆（design-tab-state-memory）", () => {
  /** 两作用域夹具：ROOT=chat:s1、WT1=chat:s2，记忆就绪 */
  function seedTwoScopes() {
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
    return { s1, s2 }
  }

  it("最后选中 file Tab：切走再切回恢复激活（规则 1.5，任意 kind）", async () => {
    seedTwoScopes()
    // 初始作用域即 ROOT（同值早退不开 Tab）：先切走再切回触发恢复
    await store.setCurrentWorkspace(WT1)
    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBe("chat:s1")
    store.openFileTab(ROOT + "/a.md")
    expect(store.activeTabKey).toBe(`file:${ROOT}/a.md`)

    await store.setCurrentWorkspace(WT1)
    expect(store.activeTabKey).toBe("chat:s2")

    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBe(`file:${ROOT}/a.md`)
    // chat 顺序不受影响（live tabs 保序）
    expect(store.tabs.filter((t) => t.directory === ROOT).map((t) => t.key)).toEqual([
      "chat:s1",
      `file:${ROOT}/a.md`,
    ])
  })

  it("引导页也是最后选中态：停留引导页切走再切回仍落引导页（null 哨兵）", async () => {
    seedTwoScopes()
    await store.setCurrentWorkspace(WT1)
    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBe("chat:s1")
    store.showGuidePage()
    expect(store.activeTabKey).toBeNull()

    await store.setCurrentWorkspace(WT1)
    expect(store.activeTabKey).toBe("chat:s2")

    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBeNull()
  })

  it("最后激活记录失效（Tab 已不在）：回退 §7 记忆 chat 激活", async () => {
    seedTwoScopes()
    await store.setCurrentWorkspace(WT1)
    await store.setCurrentWorkspace(null)
    // 直接注入失效记录（Tab 已关/死会话收敛后的残留形态）
    ;(store as unknown as { scopeActiveKeys: Map<string, string | null> }).scopeActiveKeys.set(
      ROOT,
      "file:/gone.md",
    )
    await store.setCurrentWorkspace(WT1)
    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("文件视图状态：写读往返；关文件 Tab 清条目（重开回默认）", () => {
    store.setFileViewState(ROOT + "/a.md", { mode: "source", top: 120 })
    expect(store.fileViewStateFor(ROOT + "/a.md")).toEqual({ mode: "source", top: 120 })
    store.tabs.push({
      kind: "file",
      key: `file:${ROOT}/a.md`,
      projectId: "proj1",
      title: "a.md",
      directory: ROOT,
    })
    store.closeTab(`file:${ROOT}/a.md`)
    expect(store.fileViewStateFor(ROOT + "/a.md")).toBeNull()
  })

  it("TOC 状态：写读往返（显隐与折叠互相合并不覆盖）；关文件 Tab 清条目", () => {
    store.setTocFolded(ROOT + "/a.md", ["甲章"])
    expect(store.tocStateFor(ROOT + "/a.md")).toEqual({ folded: ["甲章"] })
    store.setTocVisible(ROOT + "/a.md", false)
    expect(store.tocStateFor(ROOT + "/a.md")).toEqual({ visible: false, folded: ["甲章"] })
    store.setTocFolded(ROOT + "/a.md", [])
    expect(store.tocStateFor(ROOT + "/a.md")).toEqual({ visible: false, folded: [] })

    store.tabs.push({
      kind: "file",
      key: `file:${ROOT}/a.md`,
      projectId: "proj1",
      title: "a.md",
      directory: ROOT,
    })
    store.closeTab(`file:${ROOT}/a.md`)
    expect(store.tocStateFor(ROOT + "/a.md")).toBeNull()
  })

  it("消息流滚动位置：写读往返；关 chat Tab 与删会话清条目", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    store.setChatScroll("s1", { top: 320, headId: "msg_head" })
    expect(store.chatScrollFor("s1")).toEqual({ top: 320, headId: "msg_head" })

    store.openChatTab(s1)
    store.closeTab("chat:s1")
    expect(store.chatScrollFor("s1")).toBeNull()

    // 无 Tab 的会话删除（cleanupSessionState 兜底）
    store.setChatScroll("gone", { top: 10, headId: null })
    await store.closeChatTab("gone", { streaming: false })
    expect(store.chatScrollFor("gone")).toBeNull()
  })

  it("激活态关项目再重开：落规则 2 激活 chat（回退钩子重建的记录已被最终清除，不误落引导页）", async () => {
    seedTwoScopes()
    await store.setCurrentWorkspace(WT1)
    await store.setCurrentWorkspace(null)
    expect(store.activeTabKey).toBe("chat:s1")

    // 关正在看的项目：关 Tab 回退链最后一个无邻可退会 recordScopeActive(dir, null)，
    // 清除必须发生在关 Tab 之后才不被写回（回归用例）
    await store.closeProject("proj1")
    expect(
      (store as unknown as { scopeActiveKeys: Map<string, string | null> }).scopeActiveKeys.has(ROOT),
    ).toBe(false)

    await store.openProject("proj1")
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("closeProject / 拆连接清空视图状态记忆（跨作用域不残留）", async () => {
    store.setFileViewState(ROOT + "/a.md", { mode: "source", top: 40 })
    store.setChatScroll("s1", { top: 100, headId: "h" })
    ;(store as unknown as { scopeActiveKeys: Map<string, string | null> }).scopeActiveKeys.set(
      ROOT,
      `file:${ROOT}/a.md`,
    )
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [])
    snapshots.set(WT2, [])
    await store.closeProject("proj1")
    expect((store as unknown as { scopeActiveKeys: Map<string, string | null> }).scopeActiveKeys.has(ROOT)).toBe(false)

    store.setFileViewState(WT1 + "/b.md", { mode: "preview", top: 8 })
    store.setChatScroll("s2", { top: 50, headId: "h2" })
    await store.disconnect()
    expect(store.fileViewStateFor(WT1 + "/b.md")).toBeNull()
    expect(store.chatScrollFor("s2")).toBeNull()
  })
})

describe("报错消息与重试状态（design-error-message）", () => {
  /** 直驱 handleEvent（SSE 已 mock off）：事件信封 { type, properties } */
  function dispatch(ev: { type: string; properties: unknown }) {
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(ROOT, ev)
  }

  function seedSession() {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject.set("proj1", sessionsOf(s1))
    return s1
  }

  it("retry part：error 传播到所属消息 info.error，part 不入渲染部件列表", () => {
    seedSession()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_a1", sessionID: "s1", role: "assistant", time: { created: 100 } },
      },
    })
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: {
          id: "prt_r1",
          sessionID: "s1",
          messageID: "msg_a1",
          type: "retry",
          attempt: 1,
          error: { name: "APIError", data: { message: "rate limited", statusCode: 429 } },
          time: { created: 101 },
        },
      },
    })

    const entry = store.chatEntries("s1").find((e) => e.kind === "message")
    expect(entry && entry.kind === "message" ? entry.data.info.error : null).toEqual({
      name: "APIError",
      data: { message: "rate limited", statusCode: 429 },
    })
    // part 被消费（隐藏），不进入 parts
    expect(
      entry && entry.kind === "message"
        ? entry.data.parts.map((p) => p.type)
        : [],
    ).toEqual([])
  })

  it("retry part 不覆写既有错误；消息未知（info 未到）静默丢弃不建容器", () => {
    seedSession()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 100 },
          error: { name: "UnknownError", data: { message: "cert" } },
        },
      },
    })
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: {
          id: "prt_r2",
          sessionID: "s1",
          messageID: "msg_a1",
          type: "retry",
          attempt: 2,
          error: { name: "APIError", data: { message: "later" } },
          time: { created: 101 },
        },
      },
    })
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s2",
        part: {
          id: "prt_r3",
          sessionID: "s2",
          messageID: "msg_x",
          type: "retry",
          attempt: 1,
          error: { name: "APIError", data: { message: "orphan" } },
          time: { created: 1 },
        },
      },
    })

    const entry = store.chatEntries("s1").find((e) => e.kind === "message")
    expect(entry && entry.kind === "message" ? entry.data.info.error : null).toEqual({
      name: "UnknownError",
      data: { message: "cert" },
    })
    expect(store.chatEntries("s2")).toHaveLength(0)
  })

  it("权威 message.updated 到达（重试成功后继续流式/完成）：传播的临时错误被清除", () => {
    seedSession()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_a1", sessionID: "s1", role: "assistant", time: { created: 100 } },
      },
    })
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: {
          id: "prt_r1",
          sessionID: "s1",
          messageID: "msg_a1",
          type: "retry",
          attempt: 1,
          error: { name: "APIError", data: { message: "rate limited" } },
          time: { created: 101 },
        },
      },
    })
    // 重试成功 → server 权威 info（无 error）随 message.updated 到达
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 100, completed: 200 },
          finish: "stop",
        },
      },
    })
    const entry = store.chatEntries("s1").find((e) => e.kind === "message")
    expect(entry && entry.kind === "message" ? entry.data.info.error : "sentinel").toBeUndefined()
  })

  it("状态点投影：retry 退避 = error（红），busy = running，idle 兜底", () => {
    seedSession()
    expect(store.dotStateFor("s1")).toBe("idle")
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "rate limited" } },
    })
    expect(store.dotStateFor("s1")).toBe("error")
    // retry 仍视为进行中（停止按钮/关 Tab 确认）
    expect(store.isSessionActive("s1")).toBe(true)
    // idle 终态解除保持后，busy 正常显示
    dispatch({ type: "session.idle", properties: { sessionID: "s1" } })
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
    expect(store.dotStateFor("s1")).toBe("running")
  })

  it("retry 保持锁存（§3.6）：退避后新一轮尝试的 busy 事件被扣住，红点不闪绿", () => {
    seedSession()
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "rate limited" } },
    })
    // server 每轮尝试起点发 busy（往往零点几秒内失败回 retry）——锁存扣住
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
    expect(store.statusOf("s1").type).toBe("retry")
    expect(store.dotStateFor("s1")).toBe("error")
    // 后续 retry 事件（attempt 递增）正常更新
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 2, message: "rate limited" } },
    })
    expect(store.statusOf("s1")).toMatchObject({ type: "retry", attempt: 2 })
  })

  it("真实流式进展解除保持：内容 part（text/tool）恢复 busy；step-start 尝试起点不解除", () => {
    seedSession()
    // 消息容器就绪（part 事件需要 message.info 先到或入 pending——解除逻辑不依赖容器）
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_a1", sessionID: "s1", role: "assistant", time: { created: 100 } },
      },
    })
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "rate limited" } },
    })
    // step-start：每轮尝试起点都发，不构成进展——保持不解除
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: { id: "prt_ss1", sessionID: "s1", messageID: "msg_a1", type: "step-start" },
      },
    })
    expect(store.dotStateFor("s1")).toBe("error")
    // text 内容 part：模型真实产出——解除保持，恢复 busy（绿）
    dispatch({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: { id: "prt_t1", sessionID: "s1", messageID: "msg_a1", type: "text", text: "好的" },
      },
    })
    expect(store.statusOf("s1").type).toBe("busy")
    expect(store.dotStateFor("s1")).toBe("running")
    // 解除后再来的 busy 正常写（幂等）
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
    expect(store.dotStateFor("s1")).toBe("running")
  })

  it("REST 状态快照撞上保持：busy 改写为本地 retry（不触发 covered⇒idle 误清）；idle/缺席解除", () => {
    seedSession()
    const apply = (fresh: Record<string, { type: string }>) =>
      (store as unknown as { applyStatusSnapshot: (dir: string, f: Record<string, { type: string }>) => void }).applyStatusSnapshot(
        ROOT,
        fresh,
      )
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "rate limited" } },
    })
    // 快照在在途尝试窗口抓到 busy——保持 retry
    apply({ s1: { type: "busy" } })
    expect(store.statusOf("s1").type).toBe("retry")
    // 快照报 idle（server 已完成）——解除保持
    apply({ s1: { type: "idle" } })
    expect(store.statusOf("s1").type).toBe("idle")
    expect(store.dotStateFor("s1")).toBe("idle")
    // 再入 retry 后，快照缺席（covered⇒idle 删除）——同样解除
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "rate limited" } },
    })
    apply({})
    expect(store.statusOf("s1").type).toBe("idle")
  })

  it("快照发现的 retry 补建锁存：重连对账落在退避窗口内，后续 busy 事件不闪绿", () => {
    seedSession()
    const apply = (fresh: Record<string, { type: string }>) =>
      (store as unknown as { applyStatusSnapshot: (dir: string, f: Record<string, { type: string }>) => void }).applyStatusSnapshot(
        ROOT,
        fresh,
      )
    // 重连对账：快照报 retry（本地此前无任何状态——SSE 断线期间进入退避）
    apply({ s1: { type: "retry" } })
    expect(store.statusOf("s1").type).toBe("retry")
    // server 下一轮尝试起点的 busy——锁存已由快照路径补建，不覆写
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
    expect(store.statusOf("s1").type).toBe("retry")
    expect(store.dotStateFor("s1")).toBe("error")
  })

  it("报错终局（§3.4）：末条 assistant 非中止错误 → failed 静态红；中止与新 run 不算", () => {
    seedSession()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_u1",
          sessionID: "s1",
          role: "user",
          time: { created: 100 },
        },
      },
    })
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 200, completed: 300 },
          finish: "stop",
          error: { name: "APIError", data: { message: "quota exhausted" } },
        },
      },
    })
    expect(store.dotStateFor("s1")).toBe("failed")
    // 会话非 idle（状态事件驱动）时终局投影不生效（busy/retry 优先）
    dispatch({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    })
    expect(store.dotStateFor("s1")).toBe("running")
    dispatch({ type: "session.idle", properties: { sessionID: "s1" } })
    expect(store.dotStateFor("s1")).toBe("failed")
  })

  it("报错终局：中止（MessageAbortedError）不投影 failed；新 run 添加新末条消息后自愈", () => {
    seedSession()
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 100, completed: 200 },
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      },
    })
    expect(store.dotStateFor("s1")).toBe("idle")

    // 真错误 → failed（静态红）
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "msg_a2",
          sessionID: "s1",
          role: "assistant",
          time: { created: 300, completed: 400 },
          error: { name: "UnknownError", data: { message: "cert" } },
        },
      },
    })
    expect(store.dotStateFor("s1")).toBe("failed")
    // 新 run：user 消息成为新末条（真实时序——prompt 先落 user 消息）→ 终局不再成立
    dispatch({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id: "msg_u1", sessionID: "s1", role: "user", time: { created: 500 } },
      },
    })
    expect(store.dotStateFor("s1")).toBe("idle")
  })
})

describe("布局状态（design-layout-collapse）", () => {
  let saved: Array<{ key: string; value: unknown }>
  beforeEach(() => {
    saved = []
    ;(window as unknown as { desktop: unknown }).desktop = {
      storeGet: async (key: string) =>
        key === "layout.state"
          ? { leftWidth: 300, rightWidth: 400, leftCollapsed: true, rightCollapsed: false }
          : null,
      storeSet: async (key: string, value: unknown) => {
        saved.push({ key, value })
      },
    }
  })

  it("init 读入持久化布局", async () => {
    const s = new AppStore()
    await s.init()
    expect(s.layoutLeftCollapsed).toBe(true)
    expect(s.layoutRightCollapsed).toBe(false)
    expect(s.layoutLeftWidth).toBe(300)
    expect(s.layoutRightWidth).toBe(400)
  })

  it("越界宽度 clamp 回区间，非法值回退默认宽", async () => {
    ;(window as unknown as { desktop: unknown }).desktop = {
      storeGet: async (key: string) =>
        key === "layout.state"
          ? { leftWidth: 9999, rightWidth: 10, leftCollapsed: false, rightCollapsed: false }
          : null,
      storeSet: async () => {},
    }
    const s = new AppStore()
    await s.init()
    expect(s.layoutLeftWidth).toBe(360)
    expect(s.layoutRightWidth).toBe(240)
    s.setPanelWidth("left", Number.NaN)
    expect(s.layoutLeftWidth).toBe(260)
  })

  it("toggle 翻转并落盘 layout.state", () => {
    store.toggleLeftPanel()
    expect(store.layoutLeftCollapsed).toBe(true)
    expect(saved.at(-1)?.value).toMatchObject({ leftCollapsed: true, leftWidth: 260 })
    store.toggleRightPanel()
    expect(store.layoutRightCollapsed).toBe(true)
    expect(saved.at(-1)?.value).toMatchObject({ rightCollapsed: true })
  })

  it("setPanelWidth 逐帧 clamp 不落盘，persistLayout 显式落盘", () => {
    store.setPanelWidth("left", 50)
    expect(store.layoutLeftWidth).toBe(200)
    store.setPanelWidth("right", 9999)
    expect(store.layoutRightWidth).toBe(480)
    expect(saved).toHaveLength(0)
    store.persistLayout()
    expect(saved.at(-1)?.value).toMatchObject({ leftWidth: 200, rightWidth: 480 })
  })
})

describe("快捷键支撑（design-keyboard-shortcuts）", () => {
  /** 最小可跑 client：updateSession 返回带 archived 的会话副本 */
  function withSessionClient(sessions: Session[]) {
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => [project()],
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
      updateSession: async (id: string, _dir: string, patch: { title?: string; time?: { archived?: number } }) => {
        const s = sessions.find((x) => x.id === id)!
        return { ...s, ...(patch.title != null ? { title: patch.title } : {}), time: { ...s.time, ...(patch.time ?? {}) } }
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(...sessions)]])
  }

  it("非 chat 用户关闭入栈；恢复重开 file Tab 并激活", () => {
    withSessionClient([])
    store.tabs = [
      { kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT },
      { kind: "file", key: `file:${ROOT}/a.md`, projectId: "proj1", title: "a.md", directory: ROOT },
    ]
    store.activeTabKey = `file:${ROOT}/a.md`
    store.closeTab(`file:${ROOT}/a.md`, { pushClosed: true })
    expect(store.tabs.length).toBe(1)
    expect(store.closedTabs.length).toBe(1)
    store.activeTabKey = "chat:s1"
    store.restoreClosedTab()
    expect(store.tabs.some((t) => t.key === `file:${ROOT}/a.md`)).toBe(true)
    expect(store.activeTabKey).toBe(`file:${ROOT}/a.md`)
    expect(store.closedTabs.length).toBe(0)
  })

  it("卸载路径（closeProject）不入关闭栈", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    withSessionClient([s1])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    store.activeTabKey = "chat:s1"
    await store.closeProject("proj1")
    expect(store.tabs.length).toBe(0)
    expect(store.closedTabs.length).toBe(0)
  })

  it("closeChatTab 成功入栈；恢复 = 重开（含取消归档路径）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    withSessionClient([s1])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    store.activeTabKey = "chat:s1"
    const ok = await store.closeChatTab("s1", { streaming: false })
    expect(ok).toBe(true)
    expect(store.tabs.length).toBe(0)
    expect(store.closedTabs.length).toBe(1)
    store.restoreClosedTab()
    expect(store.tabs.some((t) => t.key === "chat:s1")).toBe(true)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("已删除会话的栈项被跳过，恢复下一个", () => {
    store.tabs = []
    // 栈顶（数组尾）在先：chat:gone 弹出后会话不存在 → 跳过 → 恢复更早的 file 项
    store.closedTabs = [
      { kind: "file", key: `file:${ROOT}/b.md`, projectId: "proj1", directory: ROOT, title: "b.md" },
      { kind: "chat", key: "chat:gone", projectId: "proj1", directory: ROOT, title: "gone" },
    ]
    store.activeTabKey = null
    store.restoreClosedTab()
    expect(store.tabs.some((t) => t.key === `file:${ROOT}/b.md`)).toBe(true)
    expect(store.closedTabs.length).toBe(0)
  })

  it("关闭栈上限 20：满则弃最旧", () => {
    for (let i = 0; i < 25; i++) {
      store.tabs = [{ kind: "file", key: `file:${ROOT}/f${i}.md`, projectId: "proj1", title: `f${i}`, directory: ROOT }]
      store.closeTab(`file:${ROOT}/f${i}.md`, { pushClosed: true })
    }
    expect(store.closedTabs.length).toBe(20)
    expect(store.closedTabs[0]!.key).toBe(`file:${ROOT}/f5.md`)
  })

  it("cycleTab 作用域内循环：末位 +1 回到首位；引导页态取首个", () => {
    store.tabs = [
      { kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT },
      { kind: "file", key: `file:${ROOT}/a.md`, projectId: "proj1", title: "a.md", directory: ROOT },
      { kind: "chat", key: "chat:other", projectId: "proj1", title: "other", directory: WT1 },
    ]
    store.activeTabKey = `file:${ROOT}/a.md`
    store.cycleTab(1)
    expect(store.activeTabKey).toBe("chat:s1")
    store.activeTabKey = null
    store.cycleTab(-1)
    expect(store.activeTabKey).toBe(`file:${ROOT}/a.md`)
  })

  it("cycleScopeEntry：项目行 → 工作区行逐行 → 跨项目 → 循环回首个 entry", async () => {
    const proj2 = { ...project(), id: "proj2", worktree: "/other", sandboxes: ["/other/wt9"] }
    store.projects = [project(), proj2]
    store.projectStates = {
      default: { opened: ["proj1", "proj2"], currentProjectId: "proj1", currentWorkspaceId: null },
    }
    store.sessionsByProject = new Map()
    // 行序：entry:proj1 → ws:WT1 → ws:WT2 → entry:proj2 → ws:/other/wt9（循环）
    store.cycleScopeEntry(1)
    await vi.waitFor(() => expect(store.scopeQuery.directory).toBe(WT1))
    store.cycleScopeEntry(1)
    await vi.waitFor(() => expect(store.scopeQuery.directory).toBe(WT2))
    store.cycleScopeEntry(1)
    await vi.waitFor(() => expect(store.currentProject?.id).toBe("proj2"))
    expect(store.scopeQuery.directory).toBe("/other")
    store.cycleScopeEntry(1)
    await vi.waitFor(() => expect(store.scopeQuery.directory).toBe("/other/wt9"))
    // wt9 之后循环回 proj1 entry（主工作区）
    store.cycleScopeEntry(1)
    await vi.waitFor(() => {
      expect(store.currentProject?.id).toBe("proj1")
      expect(store.scopeQuery.directory).toBe(ROOT)
    })
  })

  it("restoreClosedTab 跨作用域：diff 栈项先切回所属作用域再开 Tab", async () => {
    store.tabs = []
    store.closedTabs = [
      { kind: "diff", key: diffTabKey(WT1), projectId: "proj1", directory: WT1, title: "diff" },
    ]
    // 当前作用域 = 项目根（≠WT1）
    store.projectStates = {
      default: { opened: ["proj1"], currentProjectId: "proj1", currentWorkspaceId: null },
    }
    store.restoreClosedTab()
    await vi.waitFor(() => expect(store.scopeQuery.directory).toBe(WT1))
    expect(store.tabs.some((t) => t.key === diffTabKey(WT1))).toBe(true)
  })
})

describe("关闭栈跨作用域恢复（design-keyboard-shortcuts §2.1 修订）", () => {
  it("H1：跨项目 worktree 一步直达——diff 栈项恢复落在目标 worktree 而非项目根", () => {
    const proj2 = { ...project(), id: "proj2", worktree: "/other", sandboxes: ["/other/wt9"] }
    store.projects = [project(), proj2]
    store.projectStates = {
      default: { opened: ["proj1", "proj2"], currentProjectId: "proj1", currentWorkspaceId: null },
    }
    store.tabs = []
    store.closedTabs = [
      { kind: "diff", key: diffTabKey("/other/wt9"), projectId: "proj2", directory: "/other/wt9", title: "diff" },
    ]
    store.restoreClosedTab()
    // 同步段即落位：作用域 = wt9，diff Tab 的 directory 也是 wt9（不是项目根）
    expect(store.scopeQuery.directory).toBe("/other/wt9")
    const tab = store.tabs.find((t) => t.kind === "diff")
    expect(tab).toBeTruthy()
    expect(tab!.directory).toBe("/other/wt9")
    expect(tab!.key).toBe(diffTabKey("/other/wt9"))
  })

  it("M1：global 跨目录恢复走 entry 分支（不误判不可达）", () => {
    const gx = session("gx", "/tmp/x", { created: 1, updated: 1 })
    const gy = session("gy", "/tmp/y", { created: 1, updated: 2 })
    gx.projectID = "global"
    gy.projectID = "global"
    store.projects = [
      project(),
      { id: "global", worktree: "/", time: { created: 0, updated: 0 }, sandboxes: [] },
    ]
    store.sessionsByProject = new Map([
      ["proj1", new Map()],
      ["global", sessionsOf(gx, gy)],
    ])
    store.projectStates = {
      default: {
        opened: ["proj1", "global\u0000/tmp/x", "global\u0000/tmp/y"],
        currentProjectId: "global",
        currentWorkspaceId: "/tmp/y",
      },
    }
    store.tabs = []
    store.closedTabs = [
      { kind: "file", key: "file:/tmp/x/a.txt", projectId: "global", directory: "/tmp/x", title: "a.txt" },
    ]
    store.restoreClosedTab()
    expect(store.scopeQuery.directory).toBe("/tmp/x")
    expect(store.tabs.some((t) => t.key === "file:/tmp/x/a.txt" && t.directory === "/tmp/x")).toBe(true)
  })

  it("M2：chat 跨作用域恢复先切作用域——激活 Tab 不落在外作用域", async () => {
    const s1 = session("s1", WT1, { created: 1, updated: 1 })
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => [project()],
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
      updateSession: async (id: string, _dir: string, patch: { time?: { archived?: number } }) => ({
        ...s1,
        time: { ...s1.time, ...(patch.time ?? {}) },
      }),
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.projectStates = {
      default: { opened: ["proj1"], currentProjectId: "proj1", currentWorkspaceId: null },
    }
    store.tabs = []
    store.closedTabs = [
      { kind: "chat", key: "chat:s1", projectId: "proj1", directory: WT1, title: "s1" },
    ]
    store.activeTabKey = null
    store.restoreClosedTab()
    expect(store.scopeQuery.directory).toBe(WT1)
    expect(store.tabs.some((t) => t.key === "chat:s1" && t.directory === WT1)).toBe(true)
    expect(store.activeTabKey).toBe("chat:s1")
  })

  it("所属项目已关：栈项跳过不入激活", () => {
    store.projectStates = {
      default: { opened: ["proj1"], currentProjectId: "proj1", currentWorkspaceId: null },
    }
    store.tabs = []
    store.closedTabs = [
      { kind: "file", key: "file:/closed-proj/a.md", projectId: "projX", directory: "/closed-proj", title: "a.md" },
    ]
    store.restoreClosedTab()
    expect(store.tabs.length).toBe(0)
    expect(store.activeTabKey).toBeNull()
    expect(store.scopeQuery.directory).toBe(ROOT)
  })
})

describe("Tab 拖拽重排与重命名（design-tab-drag-rename）", () => {
  it("applyTabOrder 按预览 DOM 序整体重排（所见即所得）", () => {
    store.tabs = [
      { kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT },
      { kind: "chat", key: "chat:s2", projectId: "proj1", title: "s2", directory: ROOT },
      { kind: "file", key: `file:${ROOT}/a.md`, projectId: "proj1", title: "a.md", directory: ROOT },
    ]
    store.applyTabOrder(["chat:s2", `file:${ROOT}/a.md`, "chat:s1"])
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s2", `file:${ROOT}/a.md`, "chat:s1"])
  })

  it("applyTabOrder chat 顺序经记忆派生落盘；跨作用域 Tab 槽位与相对顺序不受扰", () => {
    store.tabs = [
      { kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT },
      { kind: "chat", key: "chat:wt", projectId: "proj1", title: "wt", directory: WT1 },
      { kind: "chat", key: "chat:s2", projectId: "proj1", title: "s2", directory: ROOT },
    ]
    store.activeTabKey = "chat:s1"
    // keys 仅覆盖 ROOT 作用域可见 Tab（松手时 Tab 条 DOM 序）
    store.applyTabOrder(["chat:s2", "chat:s1"])
    // 逐槽回填：wt 槽位不动，ROOT 作用域投影 = [s2, s1]
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s2", "chat:wt", "chat:s1"])
    // ROOT 作用域记忆 = [s2, s1]（wt 不参与）
    const mem = store.tabMemory.default?.[ROOT]
    expect(mem?.tabs).toEqual(["s2", "s1"])
  })

  it("renameSession：成功合并会话 + Tab 标题即时同步", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => [project()],
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
      updateSession: async (id: string, _dir: string, patch: { title?: string }) => ({
        ...s1,
        title: patch.title,
      }),
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    const ok = await store.renameSession("s1", "新标题")
    expect(ok).toBe(true)
    expect(store.findSession("s1")?.title).toBe("新标题")
    expect(store.tabs[0]!.title).toBe("新标题")
  })

  it("renameSession 失败：connectionError 可见、标题不变", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    ;(store as unknown as { client: unknown }).client = {
      updateSession: async () => {
        throw new Error("boom")
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    const ok = await store.renameSession("s1", "x")
    expect(ok).toBe(false)
    expect(store.connectionError).toContain("boom")
    expect(store.tabs[0]!.title).toBe("s1")
  })

  it("forkSession：成功合并新会话 + 开 Tab 激活（design-session-tab-context-menu）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    const forked = session("s9", ROOT, { created: 9, updated: 9 })
    let calledDir = ""
    ;(store as unknown as { client: unknown }).client = {
      forkSession: async (id: string, dir: string) => {
        expect(id).toBe("s1")
        calledDir = dir
        return forked
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    const res = await store.forkSession("s1")
    expect(res?.id).toBe("s9")
    expect(calledDir).toBe(ROOT)
    expect(store.findSession("s9")?.id).toBe("s9")
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s9"])
    expect(store.activeTabKey).toBe("chat:s9")
  })

  it("forkSession：directory 直传优先——本地无源会话记录（僵尸 Tab）也能发起", async () => {
    const forked = session("s9", WT1, { created: 9, updated: 9 })
    let calledDir = ""
    ;(store as unknown as { client: unknown }).client = {
      forkSession: async (_id: string, dir: string) => {
        calledDir = dir
        return forked
      },
    }
    // sessionsByProject 无 s1（快照间隙/他端已删本地未同步）
    store.sessionsByProject = new Map([["proj1", sessionsOf()]])
    const res = await store.forkSession("s1", { directory: WT1 })
    expect(res?.id).toBe("s9")
    expect(calledDir).toBe(WT1)
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s9"])
  })

  it("forkSession 失败：connectionError 可见、不开 Tab", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    ;(store as unknown as { client: unknown }).client = {
      forkSession: async () => {
        throw new Error("fork failed")
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    const res = await store.forkSession("s1")
    expect(res).toBeNull()
    expect(store.connectionError).toContain("fork failed")
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1"])
  })

  it("forkSession：directory 与本地会话记录双双缺失时不发请求", async () => {
    let called = 0
    ;(store as unknown as { client: unknown }).client = {
      forkSession: async () => {
        called++
        return session("s9", ROOT, { created: 9, updated: 9 })
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf()]])
    const res = await store.forkSession("ghost")
    expect(res).toBeNull()
    expect(called).toBe(0)
  })

  it("fork 提前开 Tab：SSE session.created（fork 标题）在 REST 响应前命中即开，REST 到达幂等收敛", async () => {
    const s1 = { ...session("s1", WT1, { created: 1, updated: 1 }), title: "Add fork (fork #1)" }
    const forked = { ...session("s9", WT1, { created: 9, updated: 9 }), title: "Add fork (fork #2)" }
    let resolveRest!: (v: Session) => void
    ;(store as unknown as { client: unknown }).client = {
      forkSession: () => new Promise<Session>((r) => (resolveRest = r)),
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: s1.title, directory: WT1 }]

    const p = store.forkSession("s1")
    // REST 未决期间，server 建壳即发的 session.created 到达（源标题已是 fork #1 → 新会话 fork #2）
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(WT1, {
      type: "session.created",
      properties: { info: forked },
    })
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s9"])
    expect(store.activeTabKey).toBe("chat:s9")

    resolveRest(forked)
    await expect(p).resolves.toMatchObject({ id: "s9" })
    // 幂等收敛：不重复开 Tab，激活保持
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s9"])
    expect(store.activeTabKey).toBe("chat:s9")
    expect(store.findSession("s9")?.title).toBe("Add fork (fork #2)")
  })

  it("fork 提前开 Tab：pending 窗口内不匹配的他端新建会话不误开", async () => {
    const s1 = { ...session("s1", WT1, { created: 1, updated: 1 }), title: "我的会话" }
    const other = { ...session("s8", WT1, { created: 8, updated: 8 }), title: "他端的新会话" }
    const forked = { ...session("s9", WT1, { created: 9, updated: 9 }), title: "我的会话 (fork #1)" }
    let resolveRest!: (v: Session) => void
    ;(store as unknown as { client: unknown }).client = {
      forkSession: () => new Promise<Session>((r) => (resolveRest = r)),
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: s1.title, directory: WT1 }]

    const p = store.forkSession("s1")
    // 他端普通新建（标题不匹配 fork 模式）：合并进 map 但不开 Tab（§17 语义）
    ;(store as unknown as { handleEvent: (dir: string, ev: unknown) => void }).handleEvent(WT1, {
      type: "session.created",
      properties: { info: other },
    })
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1"])

    resolveRest(forked)
    await p
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s1", "chat:s9"])
    expect(store.activeTabKey).toBe("chat:s9")
  })

  it("forkTitlePattern：剥既有后缀匹配新编号；正则元字符转义", async () => {
    const { forkTitlePattern } = await import("./app-store")
    const p1 = forkTitlePattern("普通标题")!
    expect(p1.test("普通标题 (fork #1)")).toBe(true)
    expect(p1.test("普通标题 (fork #12)")).toBe(true)
    expect(p1.test("其他标题 (fork #1)")).toBe(false)
    const p2 = forkTitlePattern("X (fork #1)")!
    expect(p2.test("X (fork #2)")).toBe(true)
    // 同 base 任意编号均匹配（并发 fork 时 server 全局编号会偏移，不收紧到 N+1）
    expect(p2.test("X (fork #1)")).toBe(true)
    expect(p2.test("Y (fork #2)")).toBe(false)
    const p3 = forkTitlePattern("a.b*c [v1]")!
    expect(p3.test("a.b*c [v1] (fork #1)")).toBe(true)
    expect(forkTitlePattern(undefined)).toBeNull()
    expect(forkTitlePattern("")).toBeNull()
  })
})

describe("applyTabOrder 防御（design-tab-drag-rename §1 修订）", () => {
  it("未知键忽略 + 重复键去重：其余键仍按预览序重排（拖拽中列表变化的防御）", () => {
    store.tabs = [
      { kind: "file", key: "file:/1", projectId: "proj1", title: "1", directory: ROOT },
      { kind: "file", key: "file:/2", projectId: "proj1", title: "2", directory: ROOT },
      { kind: "file", key: "file:/3", projectId: "proj1", title: "3", directory: ROOT },
    ]
    store.applyTabOrder(["file:/3", "file:/ghost", "file:/1", "file:/1"])
    expect(store.tabs.map((t) => t.key)).toEqual(["file:/3", "file:/2", "file:/1"])
  })

  it("纯 file Tab 重排不写记忆（write discipline 同旧 moveTab：仅含 chat 才同步）", () => {
    store.tabs = [
      { kind: "file", key: "file:/1", projectId: "proj1", title: "1", directory: ROOT },
      { kind: "file", key: "file:/2", projectId: "proj1", title: "2", directory: ROOT },
    ]
    store.applyTabOrder(["file:/2", "file:/1"])
    expect(store.tabs.map((t) => t.key)).toEqual(["file:/2", "file:/1"])
    expect(store.tabMemory.default?.[ROOT]).toBeUndefined()
  })

  it("顺序无变化早退：同序提交 no-op 不动顺序、不发通知", () => {
    store.tabs = [
      { kind: "file", key: "file:/1", projectId: "proj1", title: "1", directory: ROOT },
      { kind: "file", key: "file:/2", projectId: "proj1", title: "2", directory: ROOT },
    ]
    let notified = 0
    const unsub = store.subscribe(() => notified++)
    store.applyTabOrder(["file:/1", "file:/2"])
    unsub()
    expect(store.tabs.map((t) => t.key)).toEqual(["file:/1", "file:/2"])
    // 早退的可观测差异：零 emit（顺序断言在无早退实现下同样通过，无判别力）
    expect(notified).toBe(0)
  })
})

describe("文件引用（design-file-reference）", () => {
  const ref = (path: string, abs: string, isDir = false) => ({
    path,
    absolute: abs,
    filename: abs.split("/").pop() ?? abs,
    isDir,
  })

  it("增删去重：同 absolute 不重复；remove 清空后删条目", () => {
    store.addFileRef("s1", ref("a.ts", "/repo/a.ts"))
    store.addFileRef("s1", ref("a.ts", "/repo/a.ts"))
    store.addFileRef("s1", ref("src/", "/repo/src", true))
    expect(store.fileRefsFor("s1").length).toBe(2)
    store.removeFileRef("s1", "/repo/a.ts")
    expect(store.fileRefsFor("s1").length).toBe(1)
    store.removeFileRef("s1", "/repo/src")
    expect(store.fileRefsFor("s1").length).toBe(0)
  })

  it("sendPrompt parts 构造：文本 + 引用 file part（absolute file:// + source）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    let sentParts: unknown[] = []
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => [project()],
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
      promptAsync: async (_id: string, _dir: string, parts: unknown[]) => {
        sentParts = parts
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.addFileRef("s1", ref("src/a.ts", `${ROOT}/src/a.ts`))
    store.addFileRef("s1", ref("docs/", `${ROOT}/docs`, true))
    const res = await store.sendPrompt("s1", "看下这些", store.fileRefsFor("s1"))
    expect(res.ok).toBe(true)
    expect(sentParts).toEqual([
      { type: "text", text: "看下这些" },
      {
        type: "file",
        mime: "text/plain",
        url: `file://${ROOT}/src/a.ts`,
        filename: "a.ts",
        source: { type: "file", path: "src/a.ts", text: { value: "", start: 0, end: 0 } },
      },
      {
        type: "file",
        mime: "text/plain",
        url: `file://${ROOT}/docs`,
        filename: "docs",
        source: { type: "file", path: "docs/", text: { value: "", start: 0, end: 0 } },
      },
    ])
    // 发送成功引用即清（乐观消息仍带 refs 快照）
    expect(store.fileRefsFor("s1").length).toBe(0)
    expect(store.optimisticBySession.get("s1")![0]!.refs?.length).toBe(2)
  })

  it("纯引用发送合法；全空拒绝", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    let sentParts: unknown[] = []
    ;(store as unknown as { client: unknown }).client = {
      promptAsync: async (_id: string, _dir: string, parts: unknown[]) => {
        sentParts = parts
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.addFileRef("s1", ref("a.ts", `${ROOT}/a.ts`))
    const res = await store.sendPrompt("s1", "", store.fileRefsFor("s1"))
    expect(res.ok).toBe(true)
    expect(sentParts.length).toBe(1)
    expect((sentParts[0] as { type: string }).type).toBe("file")
    const empty = await store.sendPrompt("s1", "", [])
    expect(empty.ok).toBe(false)
  })

  it("发送失败：引用保留供重发（乐观撤回）", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    ;(store as unknown as { client: unknown }).client = {
      promptAsync: async () => {
        throw new Error("net down")
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.addFileRef("s1", ref("a.ts", `${ROOT}/a.ts`))
    const res = await store.sendPrompt("s1", "x", store.fileRefsFor("s1"))
    expect(res.ok).toBe(false)
    expect(store.fileRefsFor("s1").length).toBe(1)
    expect(store.optimisticBySession.get("s1")?.length ?? 0).toBe(0)
  })

  it("sendCommand 携带引用 parts；成功清引用", async () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    let cmdBody: { parts?: unknown[] } = {}
    ;(store as unknown as { client: unknown }).client = {
      sendCommand: async (
        _id: string,
        _dir: string,
        _cmd: string,
        _args: string,
        parts?: unknown[],
      ) => {
        cmdBody = { parts }
      },
    }
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.addFileRef("s1", ref("a.ts", `${ROOT}/a.ts`))
    const refs = store.fileRefsFor("s1")
    const res = await store.sendCommand("s1", "init", "", refs)
    expect(res.ok).toBe(true)
    expect(cmdBody.parts?.length).toBe(1)
    expect(store.fileRefsFor("s1").length).toBe(0)
  })

  it("清理挂点：关 chat Tab / 会话卸载清引用；非 chat 关闭不动他键", () => {
    const s1 = session("s1", ROOT, { created: 1, updated: 1 })
    store.sessionsByProject = new Map([["proj1", sessionsOf(s1)]])
    store.tabs = [{ kind: "chat", key: "chat:s1", projectId: "proj1", title: "s1", directory: ROOT }]
    store.addFileRef("s1", ref("a.ts", `${ROOT}/a.ts`))
    store.addFileRef(ROOT, ref("b.ts", `${ROOT}/b.ts`))
    store.closeTab("chat:s1")
    expect(store.fileRefsFor("s1").length).toBe(0)
    expect(store.fileRefsFor(ROOT).length).toBe(1)
  })
})

describe("终端 Tab（design-terminal-tab）", () => {
  function ptyClient(pty = { id: "pty_1", title: "bash", command: "bash", cwd: ROOT, status: "running", pid: 1 }) {
    const calls: string[] = []
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => [project()],
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
      listShells: async () => [
        { path: "/bin/false", name: "false", acceptable: false },
        { path: "/bin/bash", name: "bash", acceptable: true },
      ],
      createPty: async (dir: string, body: { command?: string }) => {
        calls.push(`create:${dir}:${body.command}`)
        return { ...pty, cwd: dir }
      },
      deletePty: async (id: string) => {
        calls.push(`delete:${id}`)
      },
      ptyConnectToken: async () => ({ ticket: "tkt", expires_in: 30 }),
      ptyWsOrigin: () => "ws://127.0.0.1:1",
    }
    return calls
  }

  it("openTerminalTab：省略 command（走 server $SHELL）+ cwd = 作用域目录 + Tab 归作用域", async () => {
    const calls = ptyClient()
    const ok = await store.openTerminalTab()
    expect(ok).toBe(true)
    expect(calls).toEqual([`create:${ROOT}:undefined`])
    expect(store.tabs.some((t) => t.key === "terminal:pty_1" && t.directory === ROOT)).toBe(true)
    expect(store.activeTabKey).toBe("terminal:pty_1")
    expect(store.ptyRuntimeFor("pty_1")).toEqual({ exited: false, title: "bash" })
  })

  it("closeTerminalTab：DELETE pty + 关 Tab + 入关闭栈", async () => {
    const calls = ptyClient()
    await store.openTerminalTab()
    await store.closeTerminalTab("pty_1")
    expect(calls).toEqual([`create:${ROOT}:undefined`, "delete:pty_1"])
    expect(store.tabs.length).toBe(0)
    expect(store.closedTabs.some((e) => e.kind === "terminal" && e.directory === ROOT)).toBe(true)
    expect(store.ptyRuntimeFor("pty_1")).toBeNull()
  })

  it("已退出 pty 关 Tab 不再 DELETE", async () => {
    const calls = ptyClient()
    await store.openTerminalTab()
    store.markPtyExited("pty_1")
    await store.closeTerminalTab("pty_1")
    expect(calls).toEqual([`create:${ROOT}:undefined`])
  })

  it("restoreClosedTab terminal 分支：原目录新建（新 pty id）", async () => {
    const calls = ptyClient()
    store.tabs = []
    store.closedTabs = [
      { kind: "terminal", key: "terminal:pty_old", projectId: "proj1", directory: WT1, title: "bash" },
    ]
    store.restoreClosedTab()
    // ensureScopeFor 同步切到 WT1 → openTerminalTab（异步）用当前作用域
    expect(store.scopeQuery.directory).toBe(WT1)
    await vi.waitFor(() => expect(calls).toEqual([`create:${WT1}:undefined`]))
    expect(store.tabs[0]!.directory).toBe(WT1)
  })

  it("closeProject：该目录运行中 pty 被杀（防孤儿）", async () => {
    const calls = ptyClient()
    await store.openTerminalTab()
    await store.closeProject("proj1")
    expect(calls.some((c) => c === "delete:pty_1")).toBe(true)
    expect(store.tabs.length).toBe(0)
  })

  it("ptyConnectUrl：ticket 组装、不带 cursor（全量回放语义，评审 H1）", async () => {
    ptyClient()
    await store.openTerminalTab()
    const url = await store.ptyConnectUrl("pty_1")
    expect(url).toBe("ws://127.0.0.1:1/pty/pty_1/connect?ticket=tkt&directory=%2Frepo")
  })

  it("teardownConnection：pty 全杀在 client 置 null 之前执行（评审 H2）", async () => {
    const calls = ptyClient()
    await store.openTerminalTab()
    // 直接调 teardown（绕过 disconnect 的其他清理路径）——DELETE 应被发出
    ;(store as unknown as { teardownConnection: () => void }).teardownConnection()
    expect(calls.some((c) => c === "delete:pty_1")).toBe(true)
    expect(store.ptyRuntimeFor("pty_1")).toBeNull()
  })
})
describe("浏览器 Tab（design-browser-tab）", () => {
  beforeEach(() => {
    const d = (window as unknown as { desktop: Record<string, unknown> }).desktop
    for (const [k, fn] of Object.entries(d)) {
      if (k.startsWith("browser") && typeof fn === "function" && "mock" in (fn as object)) {
        ;(fn as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
          browserCalls.push(`${k}:${String(args[0])}`)
          return k === "browserViewCreate" ? Promise.resolve(1) : undefined
        })
      }
    }
  })

  it("openBrowserTab：建 view + Tab 归作用域 + 导航初始 URL；重复打开复用激活", async () => {
    const ok = await store.openBrowserTab("file:///repo/a.html")
    expect(ok).toBe(true)
    expect(browserCalls).toEqual(["browserViewCreate:undefined", "browserNavigate:1"])
    expect(store.tabs.some((t) => t.key === "browser:file:///repo/a.html" && t.directory === ROOT)).toBe(true)
    expect(store.activeTabKey).toBe("browser:file:///repo/a.html")
    browserCalls.length = 0
    await store.openBrowserTab("file:///repo/a.html")
    expect(browserCalls).toEqual([]) // 复用不建新 view
    expect(store.tabs.length).toBe(1)
  })

  it("view-create 失败（shim -1）：返回 false（上层回退文件 Tab）", async () => {
    const d = (window as unknown as { desktop: { browserViewCreate: ReturnType<typeof vi.fn> } }).desktop
    d.browserViewCreate.mockResolvedValueOnce(-1)
    const ok = await store.openBrowserTab("file:///repo/b.html")
    expect(ok).toBe(false)
    expect(store.tabs.length).toBe(0)
  })

  it("closeBrowserTab：dispose + 关闭栈记当前页 URL", async () => {
    await store.openBrowserTab("file:///repo/a.html")
    // 导航后当前页变化（main 推送）
    store.applyBrowserState({ viewId: 1, url: "file:///repo/c.html", title: "C", loading: false, canGoBack: true, canGoForward: false })
    store.closeBrowserTab("browser:file:///repo/a.html")
    expect(browserCalls.some((c) => c === "browserViewDispose:1")).toBe(true)
    expect(store.tabs.length).toBe(0)
    expect(store.closedTabs.at(-1)).toMatchObject({ kind: "browser", title: "file:///repo/c.html" })
  })

  it("未导航关闭：恢复条目仍按 URL 重开（title 被页面标题覆写，评审 M1 回归）", async () => {
    browserCalls.length = 0
    await store.openBrowserTab("file:///repo/a.html")
    // 未导航但 main 已推送状态（url=初始、title=页面标题）
    store.applyBrowserState({ viewId: 1, url: "file:///repo/a.html", title: "My Doc", loading: false, canGoBack: false, canGoForward: false })
    store.closeBrowserTab("browser:file:///repo/a.html")
    expect(store.closedTabs.at(-1)?.title).toBe("file:///repo/a.html")
    store.restoreClosedTab()
    await vi.waitFor(() => expect(browserCalls).toContain("browserNavigate:1"))
    expect(store.tabs[0]!.key).toBe("browser:file:///repo/a.html")
  })

  it("openBrowserTab 并发重入：IPC 往返窗口内同 URL 只建一个 view（评审 M2 回归）", async () => {
    browserCalls.length = 0
    const d = (window as unknown as { desktop: { browserViewCreate: ReturnType<typeof vi.fn> } }).desktop
    let resolveCreate!: (v: number) => void
    d.browserViewCreate.mockImplementationOnce(() => new Promise<number>((r) => (resolveCreate = r)))
    const p1 = store.openBrowserTab("file:///repo/dup.html")
    const p2 = store.openBrowserTab("file:///repo/dup.html")
    resolveCreate(7)
    expect([await p1, await p2]).toEqual([true, true])
    expect(store.tabs.filter((t) => t.key === "browser:file:///repo/dup.html").length).toBe(1)
    // 只建一个 view（mockImplementationOnce 不经记录包装——以 viewId 映射断言）
    expect(store.browserViewIdFor("browser:file:///repo/dup.html")).toBe(7)
    expect(browserCalls.filter((c) => c === "browserNavigate:7").length).toBe(1)
  })
  it("restoreClosedTab browser 分支：按关闭时 URL 重开", async () => {
    browserCalls.length = 0
    store.closedTabs = [{ kind: "browser", key: "browser:x", projectId: "proj1", directory: ROOT, title: "https://example.com/" }]
    store.restoreClosedTab()
    await vi.waitFor(() => expect(browserCalls).toContain("browserNavigate:1"))
    expect(store.tabs[0]!.key).toBe("browser:https://example.com/")
  })

  it("PDF 文件 Tab 视图：注册即显隐协调 + 关 Tab 注册表兜底 dispose（design-pdf-preview，评审 L5）", async () => {
    browserCalls.length = 0
    store.tabs = [{ kind: "file", key: "file:/repo/a.pdf", projectId: "proj1", title: "a.pdf", directory: ROOT }]
    store.activeTabKey = "file:/repo/a.pdf"
    store.registerFileTabView("file:/repo/a.pdf", 9)
    // 注册即 sync：激活 + 无浮层 → show
    expect(browserCalls).toContain("browserViewShow:9")
    // 浮层中注册 → 立即 hide（M1）
    store.pushOverlay()
    browserCalls.length = 0
    store.registerFileTabView("file:/repo/a.pdf", 10)
    expect(browserCalls).toContain("browserViewHide:10")
    expect(browserCalls).not.toContain("browserViewShow:10")
    // 关 Tab（file kind）→ 注册表兜底 dispose（不限 browser kind）
    store.closeTab("file:/repo/a.pdf")
    expect(browserCalls).toContain("browserViewDispose:10")
    expect(store.browserViewIdFor("file:/repo/a.pdf")).toBeNull()
    store.popOverlay()
  })
  it("applyBrowserState：标题同步到 Tab；overlayCount 驱动显隐协调", async () => {
    await store.openBrowserTab("about:blank")
    store.applyBrowserState({ viewId: 1, url: "https://example.com/", title: "Example", loading: false, canGoBack: false, canGoForward: true })
    expect(store.tabs[0]!.title).toBe("Example")
    // 激活 + 无浮层 → show；overlay 后 → hide
    browserCalls.length = 0
    store.syncBrowserViewVisibility()
    expect(browserCalls).toContain("browserViewShow:1")
    store.pushOverlay()
    browserCalls.length = 0
    store.syncBrowserViewVisibility()
    expect(browserCalls).toContain("browserViewHide:1")
    expect(browserCalls).not.toContain("browserViewShow:1")
    store.popOverlay()
    expect(store.overlayCount).toBe(0)
  })
})

describe("worktree 同步（design-worktree-sync）", () => {
  /** 直驱 handleEvent，带可选 meta（worktree.ready 需 project 字段） */
  function dispatch(
    directory: string,
    ev: { type: string; properties: unknown },
    meta?: { project?: string; workspace?: string },
  ) {
    ;(store as unknown as {
      handleEvent: (dir: string, ev: unknown, meta?: unknown) => void
    }).handleEvent(directory, ev, meta)
  }

  it("worktree.ready SSE：重拉项目列表，左栏多一行（他端创建刷新）", async () => {
    // 初始 sandboxes = [WT1, WT2]；他端创建 WT3，server 广播 worktree.ready
    const client = (store as unknown as { client: Record<string, unknown> }).client
    let listCalls = 0
    client.listProjects = async () => {
      listCalls++
      return listCalls === 1
        ? [{ ...project(), sandboxes: [WT1, WT2, "/repo/.git/opencode-worktrees/wt3"] }]
        : [project()]
    }
    dispatch(
      "/repo/.git/opencode-worktrees/wt3",
      { type: "worktree.ready", properties: { name: "wt3", branch: "main" } },
      { project: "proj1" },
    )
    await vi.waitFor(() =>
      expect(store.workspacesOfProject("proj1")).toHaveLength(3),
    )
  })

  it("worktree.ready 闸门：项目未打开时忽略（不重拉）", async () => {
    store.projectStates = {
      default: { opened: ["proj2"], currentProjectId: "proj2", currentWorkspaceId: null },
    }
    store.projects = [project(), { id: "proj2", worktree: "/other", time: { created: 0, updated: 0 }, sandboxes: [] }]
    const client = (store as unknown as { client: Record<string, unknown> }).client
    let listCalls = 0
    client.listProjects = async () => {
      listCalls++
      return [project()]
    }
    dispatch(
      "/repo/.git/opencode-worktrees/wt3",
      { type: "worktree.ready", properties: { name: "wt3" } },
      { project: "proj1" },
    )
    // 未打开 proj1 → 不触发 listProjects（等一个微任务）
    await new Promise((r) => setTimeout(r, 10))
    expect(listCalls).toBe(0)
  })

  it("worktree.failed：忽略（无 busy UI 需复位，不崩溃）", () => {
    dispatch(
      "/repo/.git/opencode-worktrees/wt3",
      { type: "worktree.failed", properties: { message: "boom" } },
      { project: "proj1" },
    )
    // 不崩溃即通过；projects 不被修改
    expect(store.workspacesOfProject("proj1")).toHaveLength(2)
  })

  it("syncWorktrees：检测他端删除——卸载消失目录的会话/Tab/记忆", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s2))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" } } }
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])
    // 切到 WT1 开 Tab（作用域记忆恢复 chat:s2）
    await store.setCurrentWorkspace(WT1)
    expect(store.tabs.some((t) => t.key === "chat:s2")).toBe(true)

    // 他端删除 WT1：listProjects 返回不含 WT1
    const client = (store as unknown as { client: Record<string, unknown> }).client
    client.listProjects = async () => [{ ...project(), sandboxes: [WT2] }]

    await store.syncWorktrees()
    // sandboxes 已更新
    expect(store.workspacesOfProject("proj1")).toHaveLength(1)
    // Tab 关闭
    expect(store.tabs.some((t) => t.directory === WT1)).toBe(false)
    // 记忆清除
    expect(store.tabMemory.default?.[WT1]).toBeUndefined()
    // 会话卸载
    expect(store.sessionsByProject.get("proj1")?.has("s2")).toBe(false)
  })

  it("syncWorktrees：无变化时幂等（不误删）", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    store.sessionsByProject.set("proj1", sessionsOf(s2))
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s2])
    snapshots.set(WT2, [])
    await store.setCurrentWorkspace(WT1)

    const client = (store as unknown as { client: Record<string, unknown> }).client
    // listProjects 返回不变的 sandboxes
    client.listProjects = async () => [project()]

    await store.syncWorktrees()
    expect(store.workspacesOfProject("proj1")).toHaveLength(2)
    expect(store.sessionsByProject.get("proj1")?.has("s2")).toBe(true)
  })

  it("syncWorktrees：未打开项目不检测（跳过）", async () => {
    store.projectStates = {
      default: { opened: ["proj2"], currentProjectId: "proj2", currentWorkspaceId: null },
    }
    store.projects = [
      project(),
      { id: "proj2", worktree: "/other", time: { created: 0, updated: 0 }, sandboxes: [] },
    ]
    snapshots.set("/other", [])
    await store.setCurrentWorkspace(null)

    const client = (store as unknown as { client: Record<string, unknown> }).client
    let listCalled = false
    client.listProjects = async () => {
      listCalled = true
      // proj1 的 WT1 被删，但 proj1 未打开
      return [
        { ...project(), sandboxes: [WT2] },
        { id: "proj2", worktree: "/other", time: { created: 0, updated: 0 }, sandboxes: [] },
      ]
    }

    await store.syncWorktrees()
    expect(listCalled).toBe(true)
    // proj1 仍保持原值（store.projects 被 fresh 覆盖，但 proj1 未打开不 unload）
    // 关键：不报错、无 unload 副作用
  })
})

describe("左栏 entry 顺序与拖拽（design-layout §3 打开序）", () => {
  /** 注入 N 个互异项目（worktree 互异、无 sandboxes）并清空打开态 */
  function withProjects(...ids: string[]) {
    const list = ids.map((id) => ({
      id,
      worktree: `/wt-${id}`,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    }))
    ;(store as unknown as { client: unknown }).client = {
      listSessions: async () => [],
      listSessionStatus: async () => ({}),
      listProjects: async () => list,
      listPendingPermissions: async () => [],
      listPendingQuestions: async () => [],
    }
    store.projects = list
    store.projectStates = {
      default: { opened: [], currentProjectId: null, currentWorkspaceId: null },
    }
  }

  it("行序 = 打开顺序（非 server 快照创建序）", async () => {
    withProjects("p1", "p2", "p3")
    await store.openProject("p3")
    await store.openProject("p1")
    await store.openProject("p2")
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p3", "p1", "p2"])
  })

  it("新打开项目追加末位；关闭后重开落末位", async () => {
    withProjects("p1", "p2", "p3")
    await store.openProject("p1")
    await store.openProject("p2")
    await store.openProject("p3")
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p1", "p2", "p3"])
    await store.closeProject("p1")
    await store.openProject("p1")
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p2", "p3", "p1"])
  })

  it("applyEntryOrder 前插/后插重排（预览序整体覆盖）", async () => {
    withProjects("p1", "p2", "p3")
    await store.openProject("p1")
    await store.openProject("p2")
    await store.openProject("p3")
    store.applyEntryOrder(["p3", "p1", "p2"])
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p3", "p1", "p2"])
    store.applyEntryOrder(["p1", "p3", "p2"])
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p1", "p3", "p2"])
  })

  it("applyEntryOrder 重排落盘 project.state；无位移早退不落盘", async () => {
    withProjects("p1", "p2")
    await store.openProject("p1")
    await store.openProject("p2")
    const sets: Array<{ key: string; value: unknown }> = []
    ;(window as unknown as { desktop: { storeSet: (k: string, v: unknown) => Promise<void> } }).desktop
      .storeSet = async (key: string, value: unknown) => {
        sets.push({ key, value })
      }
    store.applyEntryOrder(["p2", "p1"])
    await vi.waitFor(() => {
      const last = sets.at(-1)
      expect(last?.key).toBe("project.state")
      expect((last!.value as { default: { opened: string[] } }).default.opened).toEqual(["p2", "p1"])
    })
    sets.length = 0
    store.applyEntryOrder(["p2", "p1"])
    expect(sets).toHaveLength(0)
  })

  it("applyEntryOrder 键去重；未知键不复活已关 entry（并发关闭防御）", () => {
    withProjects("p1", "p2")
    store.projectStates = {
      default: { opened: ["p1", "p2"], currentProjectId: "p1", currentWorkspaceId: null },
    }
    store.applyEntryOrder(["p2", "p2", "p1", "ghost"])
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p2", "p1"])
  })
})

describe("左栏 entry 顺序与拖拽（design-layout §3 打开序）——global 平权", () => {
  it("global 目录行与普通项目混合参与打开序与 applyEntryOrder 落位", () => {
    const gsession = { ...session("g1", "/docs", { created: 1, updated: 1 }), projectID: "global" }
    store.projects = [
      { id: "global", worktree: "/", time: { created: 0, updated: 0 } },
      { id: "p1", worktree: "/wt-p1", time: { created: 0, updated: 0 }, sandboxes: [] },
    ]
    store.sessionsByProject.set("global", sessionsOf(gsession))
    const gkey = globalEntryKey("/docs")
    store.projectStates = {
      default: { opened: ["p1", gkey], currentProjectId: "p1", currentWorkspaceId: null },
    }
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p1", gkey])
    store.applyEntryOrder([gkey, "p1"])
    expect(store.openedEntries.map((e) => e.key)).toEqual([gkey, "p1"])
    expect(store.projectStates.default.opened).toEqual([gkey, "p1"])
  })
})

describe("左栏 entry 顺序与拖拽（design-layout §3 打开序）——applyEntryOrder 落位", () => {
  it("按预览序整体重排并落盘；含 keys 未覆盖键的防御", async () => {
    store.projects = [
      { id: "p1", worktree: "/wt-p1", time: { created: 0, updated: 0 }, sandboxes: [] },
      { id: "p2", worktree: "/wt-p2", time: { created: 0, updated: 0 }, sandboxes: [] },
      { id: "p3", worktree: "/wt-p3", time: { created: 0, updated: 0 }, sandboxes: [] },
    ]
    store.projectStates = {
      default: { opened: ["p1", "p2", "p3"], currentProjectId: "p1", currentWorkspaceId: null },
    }
    const sets: Array<{ key: string; value: unknown }> = []
    ;(window as unknown as { desktop: { storeSet: (k: string, v: unknown) => Promise<void> } }).desktop
      .storeSet = async (key: string, value: unknown) => {
        sets.push({ key, value })
      }
    // 预览序 = 拖 p1 到末位；keys 缺 p2（拖拽中列表变化防御）→ 原相对顺序追加
    store.applyEntryOrder(["p3", "p1"])
    expect(store.openedEntries.map((e) => e.key)).toEqual(["p3", "p1", "p2"])
    await vi.waitFor(() => {
      const last = sets.at(-1)
      expect(last?.key).toBe("project.state")
      expect((last!.value as { default: { opened: string[] } }).default.opened).toEqual(["p3", "p1", "p2"])
    })
    // 顺序无变化 no-op 不落盘
    sets.length = 0
    store.applyEntryOrder(["p3", "p1", "p2"])
    expect(sets).toHaveLength(0)
  })
})

describe("createProjectFromDirectory（design-new-project）", () => {
  const clientOf = () => (store as unknown as { client: Record<string, unknown> }).client

  it("git 文件夹：resolveProject 注册后刷新 projects 并直接 openProject", async () => {
    const fresh: Project = { id: "newproj", worktree: "/fresh", time: { created: 9, updated: 9 }, sandboxes: [] }
    let resolvedDir = ""
    clientOf().resolveProject = async (dir: string) => {
      resolvedDir = dir
      return fresh
    }
    let listCalls = 0
    clientOf().listProjects = async () => {
      listCalls++
      return [project(), fresh]
    }
    snapshots.set("/fresh", [])

    await store.createProjectFromDirectory("/fresh")
    expect(resolvedDir).toBe("/fresh")
    // projects 先刷新（左栏/打开流数据源必须含新项目）
    expect(listCalls).toBe(1)
    expect(store.projects.some((p) => p.id === "newproj")).toBe(true)
    const ps = store.projectStateFor()
    expect(ps.opened).toContain("newproj")
    expect(ps.currentProjectId).toBe("newproj")
    expect(store.currentProject?.id).toBe("newproj")
  })

  it("非 git 文件夹（解析为 global）：以 global 目录 entry 打开（D1，不动文件系统）", async () => {
    const globalProj: Project = { id: "global", worktree: "/", time: { created: 0, updated: 0 }, sandboxes: [] }
    clientOf().resolveProject = async () => globalProj
    clientOf().listProjects = async () => [project(), globalProj]
    snapshots.set("/plain", [])

    await store.createProjectFromDirectory("/plain")
    const ps = store.projectStateFor()
    expect(ps.opened).toContain(globalEntryKey("/plain"))
    expect(ps.currentProjectId).toBe("global")
    expect(store.currentWorkspace?.directory).toBe("/plain")
    // 左栏出现该 global 目录行（零会话兜底行的 opened 闸门已放行）
    expect(store.openedEntries.some((e) => e.key === globalEntryKey("/plain"))).toBe(true)
  })

  it("解析失败：异常上抛，打开状态不变（弹窗不关可重试的前提）", async () => {
    clientOf().resolveProject = async () => {
      throw new Error("目录不存在")
    }
    await expect(store.createProjectFromDirectory("/nope")).rejects.toThrow("目录不存在")
    const ps = store.projectStateFor()
    expect(ps.opened).toEqual(["proj1"])
    expect(ps.currentProjectId).toBe("proj1")
  })

  it("在途闸门：注册期间断连（client 置 null）→ 抛错不打开（评审 R2：弹窗不按成功关闭）", async () => {
    const fresh: Project = { id: "newproj2", worktree: "/fresh2", time: { created: 9, updated: 9 }, sandboxes: [] }
    clientOf().resolveProject = async () => {
      ;(store as unknown as { client: unknown }).client = null
      return fresh
    }
    let listCalled = false
    clientOf().listProjects = async () => {
      listCalled = true
      return [project(), fresh]
    }

    await expect(store.createProjectFromDirectory("/fresh2")).rejects.toThrow("连接已断开")
    expect(listCalled).toBe(false)
    expect(store.projectStateFor().opened).toEqual(["proj1"])
  })

  it("listProjects 失败：异常上抛不打开（评审 R1：projects 不含新项目时打开 = 不一致态）", async () => {
    const fresh: Project = { id: "newproj3", worktree: "/fresh3", time: { created: 9, updated: 9 }, sandboxes: [] }
    clientOf().resolveProject = async () => fresh
    clientOf().listProjects = async () => {
      throw new ApiError(0, "network", "无法连接服务器")
    }

    await expect(store.createProjectFromDirectory("/fresh3")).rejects.toThrow("无法连接服务器")
    const ps = store.projectStateFor()
    expect(ps.opened).toEqual(["proj1"])
    expect(ps.currentProjectId).toBe("proj1")
  })

  it("signal 中止：resolve 完成后已取消 → 不刷新不打开（评审 R3：弹窗关闭即取消）", async () => {
    const fresh: Project = { id: "newproj4", worktree: "/fresh4", time: { created: 9, updated: 9 }, sandboxes: [] }
    clientOf().resolveProject = async () => fresh
    let listCalled = false
    clientOf().listProjects = async () => {
      listCalled = true
      return [project(), fresh]
    }
    const ac = new AbortController()

    const p = store.createProjectFromDirectory("/fresh4", ac.signal)
    ac.abort()
    await p
    expect(listCalled).toBe(false)
    expect(store.projectStateFor().opened).toEqual(["proj1"])
  })
})
