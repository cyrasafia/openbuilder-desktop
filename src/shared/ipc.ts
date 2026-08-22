/** 持久化 store 的形状（main 进程 electron-store 风格，自写 JSON 实现） */
export interface StoreShape {
  /** 连接配置列表 + 激活项 */
  "connection.profiles": {
    profiles: ConnectionProfile[]
    activeId: string | null
  }
  /** 每个连接（profileId）下已打开的项目 id 列表 + 当前项目 + 当前工作区 */
  "project.state": Record<
    string,
    { opened: string[]; currentProjectId: string | null; currentWorkspaceId: string | null }
  >
  /** 布局状态：各栏尺寸/折叠 */
  "layout.state": {
    leftWidth: number
    rightWidth: number
    leftCollapsed: boolean
    rightCollapsed: boolean
  }
  /** 主题：auto | dark | light */
  "theme.mode": "auto" | "dark" | "light"
  /** 语言：auto | zh | en */
  "locale.mode": "auto" | "zh" | "en"
}

export interface ConnectionProfile {
  id: string
  name: string
  /** attach: server 基地址，如 http://127.0.0.1:15120 */
  baseUrl: string
  /** 可选 basic auth */
  username?: string
  password?: string
  /** managed: 用本机 opencode serve 起进程（v0.1 简化：发现 + spawn） */
  mode: "attach" | "managed"
}

/** IPC 通道类型（preload ↔ main） */
export interface DesktopApi {
  storeGet<K extends keyof StoreShape>(key: K): Promise<StoreShape[K] | null>
  storeSet<K extends keyof StoreShape>(key: K, value: StoreShape[K]): Promise<void>
  managedStart(): Promise<{
    ok: boolean
    error?: string
    baseUrl?: string
    username?: string
    password?: string
  }>
  managedStop(): Promise<void>
  onManagedEvent(cb: (payload: string) => void): () => void
  openPathPicker(): Promise<string | null>
  getAppVersion(): Promise<string>
}
