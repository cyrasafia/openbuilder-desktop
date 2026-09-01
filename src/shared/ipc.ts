/** 持久化 store 的形状（main 进程 electron-store 风格，自写 JSON 实现） */
import type { ModelRef } from "./api-types"
import type { ScopeTabMemory } from "./scope-tab-memory"

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
  /** worktree 级 Tab 记忆（design-tab-memory）：profileKey → directory → 记忆 */
  "tabs.memory": Record<string, Record<string, ScopeTabMemory>>
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
  /** 全局默认 agent/模型（design-agent-model-switch D-AM-4）：profileKey → 默认值 */
  "model.defaults": Record<
    string,
    { agent?: string; model?: ModelRef }
  >
  /** 消息流思考（reasoning）显隐，默认隐藏（同移动端 showThinking） */
  "chat.showThinking": boolean
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

/** 运行平台：main 进程 process.platform 的字面量集；纯浏览器 shim 为 "browser" */
export type DesktopPlatform = "linux" | "darwin" | "win32" | "browser"

/** 浏览器 Tab 视图状态（design-browser-tab §1.1，main 聚合事件推送） */
export interface BrowserViewState {
  viewId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 浏览器视图 bounds（contentView 坐标系，DIP；design-browser-tab §1.1） */
export interface BrowserViewRect {
  x: number
  y: number
  width: number
  height: number
}

/** IPC 通道类型（preload ↔ main） */
export interface DesktopApi {
  platform: DesktopPlatform
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
  /** 选 HTML 文件（浏览器 Tab「打开本地文件」，design-browser-tab §1.3） */
  openHtmlFilePicker(): Promise<string | null>
  getAppVersion(): Promise<string>
  /** 系统默认方式打开文件/目录（shell.openPath）；resolve ""=成功，否则错误信息 */
  shellOpenPath(path: string): Promise<string>
  /** 系统「打开方式」（design-file-panel-context-menu §2.4）：win32 = OpenAs_RunDLL 对话框，
   *  darwin = 系统应用选择器；linux 无系统对话框，渲染层不提供入口。同返回错误信息约定 */
  shellOpenWith(path: string): Promise<string>
  /** 浏览器 Tab（design-browser-tab §1.1）：WebContentsView 生命周期与导航 */
  browserViewCreate(): Promise<number>
  browserViewBounds(viewId: number, rect: BrowserViewRect): void
  browserViewShow(viewId: number): void
  browserViewHide(viewId: number): void
  browserViewDispose(viewId: number): void
  browserNavigate(viewId: number, url: string): void
  browserGoBack(viewId: number): void
  browserGoForward(viewId: number): void
  browserReload(viewId: number): void
  browserStop(viewId: number): void
  /** 视图状态推送（main → renderer），返回取消订阅 */
  onBrowserViewState(cb: (state: BrowserViewState) => void): () => void
  /** 浏览器视图内快捷键转发（main → renderer；页面聚焦时 window keydown 不可达，评审 M5） */
  onBrowserShortcut(cb: (input: { key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }) => void): () => void
  /** Linux「打开方式」应用枚举（design-linux-open-with §1.1；仅 linux 有意义）。
   *  **全量应用**（2026-08-31 修订，不再按 MIME 过滤）：matches = MimeType 命中
   *  目标 MIME（祖先闭包）；已按「匹配组在前、其余组后，组内字母序」排序。
   *  icon = 图标 data URL（png/svg；null = 渲染层首字母瓷片兜底） */
  shellListOpenWithApps(path: string): Promise<{ id: string; name: string; icon: string | null; matches: boolean }[]>
  /** Linux 按枚举结果中的应用启动（design-linux-open-with §1.2；appId 须来自
   *  最近一次枚举——main 侧白名单校验）。返回错误信息（""=成功） */
  shellOpenWithApp(path: string, appId: string): Promise<string>
  /** Linux 自定义头部窗口控制（title-bar.tsx；仅 frameless 窗口有意义） */
  winMinimize(): void
  winToggleMaximize(): void
  winClose(): void
  winIsMaximized(): Promise<boolean>
  /** 最大化/还原状态推送（main → renderer），返回取消订阅 */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
}
