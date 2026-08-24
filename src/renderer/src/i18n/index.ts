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
  sessionIndicatorTitle: "会话 {count}，进行中 {busy}，待输入 {waiting}",
  archivedSessions: "已归档",
  workspacesTitle: "工作区",
  newWorkspace: "新建工作区",
  deleteWorkspace: "删除工作区",
  mainWorkspace: "主工作区",
  cancel: "取消",
  confirm: "确定",
  // Tab
  closeTab: "关闭",
  newTab: "新建 Tab",
  untitled: "（未命名）",
  // 聊天
  inputPlaceholder: "输入消息…（Enter 发送，Shift+Enter 换行）",
  send: "发送",
  sending: "发送中",
  abort: "停止",
  you: "你",
  assistant: "助手",
  thinking: "思考中",
  toolCall: "工具",
  inputLabel: "输入",
  outputLabel: "输出",
  copy: "复制",
  copied: "已复制",
  retry: "重试",
  // 输入中提示（design-typing-indicator §5；文案对齐移动端 ARB 同场景）
  generating: "正在生成…",
  retrying: "重试中",
  retryingMessage: "重试中：{message}",
  // 斜杠命令
  commandListLoading: "正在获取命令…",
  commandHintKeys: "↑↓ 选择　Enter/Tab 补全　Esc 关闭",
  // 授权/问题卡片
  permissionRequest: "授权请求",
  permissionAllowOnce: "允许一次",
  permissionAlwaysAllow: "总是允许",
  reject: "拒绝",
  permissionExecute: "执行命令",
  permissionExternalDir: "访问外部目录",
  pendingQueue: "1/{total} 待处理",
  questionSubmit: "提交",
  questionNext: "下一步",
  replyFailed: "操作失败",
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
  // 服务器连接状态（左栏底部）
  statusStreaming: "实时",
  statusDegraded: "重连中",
  statusOffline: "离线",
  statusReconciling: "对账中",
  // 窗口控制（Linux 自定义头部）
  winMinimize: "最小化",
  winMaximize: "最大化",
  winRestore: "还原",
  winClose: "关闭",
  // 空态
  noProject: "先打开一个项目",
  connectFirst: "先配置服务器连接",
  openSettings: "打开设置",
  // 新 Tab 引导页
  guideHint: "发送消息开始新会话，或从下方恢复已归档会话",
  guidePlaceholder: "输入新会话的第一条消息…",
  openTerminal: "终端",
  openBrowser: "网页",
  comingSoon: "即将支持",
  restoreHint: "点击恢复",
  confirmCloseStreamingTab:
    "会话正在运行，关闭将停止并归档该会话。继续？",
  confirmSwitchProject:
    "切换项目将关闭并归档当前所有打开的会话。继续？",
  confirmDeleteWorkspace: "删除工作区？",
  errorTitle: "出错了",
  // agent/模型/思考强度切换（design-agent-model-switch）
  model: "模型",
  thinkingLabel: "思考强度",
  thinkingDefault: "默认",
  setAsDefault: "设为默认",
  clearDefaults: "清除默认值",
  modelLoadFailed: "加载失败，点击重试",
  modelSearchPlaceholder: "搜索模型…",
  noModelMatch: "无匹配模型",
  defaultsTitle: "默认值",
  defaultsHint: "新建会话自动应用（仅本客户端）",
}

const en: typeof zh = {
  appTitle: "openbuilder desktop",
  projectsTitle: "Projects",
  openProject: "Open project…",
  closeProject: "Close project",
  sessionIndicatorTitle: "Sessions: {count}, working: {busy}, waiting: {waiting}",
  archivedSessions: "Archived",
  workspacesTitle: "Worktrees",
  newWorkspace: "New worktree",
  deleteWorkspace: "Delete worktree",
  mainWorkspace: "main",
  cancel: "Cancel",
  confirm: "OK",
  closeTab: "Close",
  newTab: "New tab",
  untitled: "(untitled)",
  inputPlaceholder: "Message… (Enter to send, Shift+Enter for newline)",
  send: "Send",
  sending: "Sending",
  abort: "Stop",
  you: "You",
  assistant: "Assistant",
  thinking: "Thinking",
  toolCall: "Tool",
  inputLabel: "Input",
  outputLabel: "Output",
  copy: "Copy",
  copied: "Copied",
  retry: "Retry",
  generating: "Generating…",
  retrying: "Retrying",
  retryingMessage: "Retrying: {message}",
  commandListLoading: "Loading commands…",
  commandHintKeys: "↑↓ select  Enter/Tab complete  Esc close",
  // Permission/question cards
  permissionRequest: "Permission request",
  permissionAllowOnce: "Allow once",
  permissionAlwaysAllow: "Always allow",
  reject: "Reject",
  permissionExecute: "Run command",
  permissionExternalDir: "Access external directory",
  pendingQueue: "1/{total} pending",
  questionSubmit: "Submit",
  questionNext: "Next",
  replyFailed: "Action failed",
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
  winMinimize: "Minimize",
  winMaximize: "Maximize",
  winRestore: "Restore",
  winClose: "Close",
  noProject: "Open a project first",
  connectFirst: "Configure a server first",
  openSettings: "Open settings",
  guideHint: "Send a message to start a session, or restore an archived one below",
  guidePlaceholder: "First message for a new session…",
  openTerminal: "Terminal",
  openBrowser: "Browser",
  comingSoon: "Coming soon",
  restoreHint: "Click to restore",
  confirmCloseStreamingTab: "Session is running. Closing stops and archives it. Continue?",
  confirmSwitchProject: "Switching projects closes and archives all open sessions. Continue?",
  confirmDeleteWorkspace: "Delete worktree?",
  errorTitle: "Something went wrong",
  model: "Model",
  thinkingLabel: "Thinking",
  thinkingDefault: "Default",
  setAsDefault: "Set as default",
  clearDefaults: "Clear defaults",
  modelLoadFailed: "Load failed — click to retry",
  modelSearchPlaceholder: "Search models…",
  noModelMatch: "No matching models",
  defaultsTitle: "Defaults",
  defaultsHint: "Applied to new sessions (this client only)",
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
