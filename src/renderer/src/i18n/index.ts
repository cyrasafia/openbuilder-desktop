/**
 * i18n：中/英 catalog。原则沿用 openbuilder DESIGN.md：
 * 英文是重写不是翻译；句式对单复数不敏感（session: 4 而非 4 sessions）。
 */
export type Locale = "zh" | "en"

const zh = {
  appTitle: "openbuilder desktop",
  // 左栏
  projectsTitle: "项目",
  openProject: "打开项目…",
  closeProject: "关闭项目",
  newSession: "新建会话",
  sessionsTitle: "会话",
  archivedSessions: "已归档",
  unarchive: "取消归档",
  archive: "归档",
  rename: "重命名",
  delete: "删除",
  workspacesTitle: "工作区",
  newWorkspace: "新建工作区",
  deleteWorkspace: "删除工作区",
  mainWorkspace: "主工作区",
  // 工作区
  workspaceName: "名称",
  workspaceBranch: "分支（可选）",
  create: "创建",
  cancel: "取消",
  confirm: "确定",
  // Tab
  closeTab: "关闭",
  newChatTab: "新聊天",
  untitled: "（未命名）",
  // 聊天
  inputPlaceholder: "输入消息…（Ctrl+Enter 发送）",
  send: "发送",
  sending: "发送中",
  abort: "停止",
  you: "你",
  assistant: "助手",
  thinking: "思考中",
  toolCall: "工具",
  inputLabel: "输入",
  outputLabel: "输出",
  retry: "重试",
  // 文件
  filesTitle: "文件",
  loading: "加载中…",
  empty: "空",
  loadFailed: "加载失败",
  // 设置
  settings: "设置",
  connectionTitle: "服务器连接",
  profileName: "名称",
  profileUrl: "服务器地址",
  profileUser: "用户名（可选）",
  profilePassword: "密码（可选）",
  profileMode: "模式",
  modeAttach: "attach（连接现有服务）",
  modeManaged: "managed（本机启动）",
  addProfile: "添加",
  removeProfile: "删除",
  activateProfile: "启用",
  activeProfile: "当前使用",
  theme: "主题",
  themeAuto: "跟随系统",
  themeDark: "深色",
  themeLight: "浅色",
  language: "语言",
  langAuto: "跟随系统",
  langZh: "中文",
  langEn: "English",
  testConnection: "测试连接",
  testOk: "连接正常（版本 {version}）",
  testFailed: "连接失败",
  // 状态栏
  statusStreaming: "实时",
  statusDegraded: "重连中",
  statusOffline: "离线",
  statusReconciling: "对账中",
  serverInfo: "服务器",
  // 空态
  noProject: "先打开一个项目",
  noSession: "新建会话开始工作",
  connectFirst: "先配置服务器连接",
  openSettings: "打开设置",
  confirmCloseStreamingTab:
    "会话正在运行，关闭将停止并归档该会话。继续？",
  confirmDeleteSession: "删除会话？不可恢复",
  confirmDeleteWorkspace: "删除工作区？",
  errorTitle: "出错了",
}

const en: typeof zh = {
  appTitle: "openbuilder desktop",
  projectsTitle: "Projects",
  openProject: "Open project…",
  closeProject: "Close project",
  newSession: "New session",
  sessionsTitle: "Sessions",
  archivedSessions: "Archived",
  unarchive: "Unarchive",
  archive: "Archive",
  rename: "Rename",
  delete: "Delete",
  workspacesTitle: "Worktrees",
  newWorkspace: "New worktree",
  deleteWorkspace: "Delete worktree",
  mainWorkspace: "main",
  workspaceName: "Name",
  workspaceBranch: "Branch (optional)",
  create: "Create",
  cancel: "Cancel",
  confirm: "OK",
  closeTab: "Close",
  newChatTab: "New chat",
  untitled: "(untitled)",
  inputPlaceholder: "Message… (Ctrl+Enter to send)",
  send: "Send",
  sending: "Sending",
  abort: "Stop",
  you: "You",
  assistant: "Assistant",
  thinking: "Thinking",
  toolCall: "Tool",
  inputLabel: "Input",
  outputLabel: "Output",
  retry: "Retry",
  filesTitle: "Files",
  loading: "Loading…",
  empty: "Empty",
  loadFailed: "Failed to load",
  settings: "Settings",
  connectionTitle: "Server",
  profileName: "Name",
  profileUrl: "Server URL",
  profileUser: "Username (optional)",
  profilePassword: "Password (optional)",
  profileMode: "Mode",
  modeAttach: "attach (existing server)",
  modeManaged: "managed (spawn local)",
  addProfile: "Add",
  removeProfile: "Remove",
  activateProfile: "Use",
  activeProfile: "Active",
  theme: "Theme",
  themeAuto: "System",
  themeDark: "Dark",
  themeLight: "Light",
  language: "Language",
  langAuto: "System",
  langZh: "中文",
  langEn: "English",
  testConnection: "Test connection",
  testOk: "OK (version {version})",
  testFailed: "Connection failed",
  statusStreaming: "live",
  statusDegraded: "reconnecting",
  statusOffline: "offline",
  statusReconciling: "reconciling",
  serverInfo: "Server",
  noProject: "Open a project first",
  noSession: "Start a session to begin",
  connectFirst: "Configure a server first",
  openSettings: "Open settings",
  confirmCloseStreamingTab: "Session is running. Closing stops and archives it. Continue?",
  confirmDeleteSession: "Delete session? This cannot be undone.",
  confirmDeleteWorkspace: "Delete worktree?",
  errorTitle: "Something went wrong",
}

export type MessageKey = keyof typeof zh
export type Catalog = Record<MessageKey, string>

export function getCatalog(locale: Locale): Catalog {
  return locale === "zh" ? zh : en
}

export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))
}

/** 相对时间（与移动端规则一致） */
export function relativeTime(locale: Locale, ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return locale === "zh" ? "刚刚" : "just now"
  if (min < 60) return locale === "zh" ? `${min} 分钟前` : `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return locale === "zh" ? `${h} 小时前` : `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return locale === "zh" ? `${d} 天前` : `${d}d ago`
  const date = new Date(ts)
  return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US")
}
