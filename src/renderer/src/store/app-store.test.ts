/**
 * AppStore 切换链路测试（design-tab-memory §6/§16 先切换后加载 + 死会话收敛）：
 * 只测 store 纯状态机——注入 fake client 与项目/会话/记忆夹具，SSE 不启动
 * （activeProfileId 为空时 startSse 直接返回），快照落点用手动 deferred 控制。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppStore } from "./app-store"
import { SseSubscriber } from "@shared/sse-subscriber"
import type { Project, Session } from "@shared/api-types"

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

  it("死会话 Tab 收敛：快照证实已归档的 Tab 关闭，可见但记忆外的 Tab 保留", async () => {
    const s2 = session("s2", WT1, { created: 2, updated: 2 })
    const s4 = session("s4", WT1, { created: 4, updated: 4 })
    store.sessionsByProject.set("proj1", sessionsOf(s2, s4))
    store.tabMemory = { default: { [WT1]: { projectId: "proj1", tabs: ["s2"], active: "s2" } } }
    // 记忆外的可见会话 Tab（"不强制收敛"保护对象）
    ;(store as unknown as { openChatTabSilent: (s: Session) => void }).openChatTabSilent(s4)
    const s2Archived = session("s2", WT1, { created: 2, updated: 5, archived: 5 })
    snapshots.set(ROOT, [])
    snapshots.set(WT1, [s2Archived, s4])
    snapshots.set(WT2, [])

    await store.setCurrentWorkspace(WT1)
    expect(store.tabs.map((t) => t.key)).toEqual(["chat:s4"])
    expect(store.tabMemory.default?.[WT1]).toEqual({ projectId: "proj1", tabs: [], active: null })
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
