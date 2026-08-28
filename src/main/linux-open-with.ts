/**
 * Linux「打开方式」（design-linux-open-with §1）：.desktop 枚举/解析纯函数 +
 * xdg-mime / gio launch 子进程封装。纯函数独立导出供单测（fixture 字符串）。
 */
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export interface OpenWithApp {
  id: string
  /** data dir 相对的 .desktop 路径（如 org.gnome.TextEditor.desktop / kde4/foo.desktop） */
  name: string
}

/**
 * 启动用户会话应用（gio launch / xdg-open / rundll32 / open）时剥离的环境前缀：
 * 本进程在 dev（electron-vite `npm run dev`）注入的 NODE_ENV / ELECTRON_* / VITE_* 是
 * 应用内部约定，泄漏给外部应用会改变其行为。实证（2026-08-28 真机复现）：MarkText
 * 读到 NODE_ENV=development 后丢弃文件参数、改用 marktext-dev 数据目录起独立实例，
 * 且其 dev URL 构造失败 + GPU 崩溃循环 → 无响应幽灵窗口无法关闭。
 */
const SESSION_APP_ENV_STRIP_PREFIXES = ["NODE_", "ELECTRON_", "VITE_"]

/** 子进程环境净化（纯函数，供单测）：拷贝并剥离上述前缀键。
 *  比较大小写不敏感——Windows 环境变量名不区分大小写（Node 读取即命中），
 *  小写变体（node_env）同样必须剥离 */
export function sanitizedChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (SESSION_APP_ENV_STRIP_PREFIXES.some((p) => upper.startsWith(p))) continue
    out[key] = value
  }
  return out
}

/** 解析后的 desktop 条目（内部域模型） */
interface DesktopEntry {
  name: string
  exec?: string
  noDisplay: boolean
  mimeTypes: Set<string>
}

/** INI 浅解析（[Desktop Entry] 段键值；等号分割、注释/空行跳过；仅取首个段头后键） */
export function parseDesktopEntry(content: string, locale: string): DesktopEntry | null {
  const lines = content.split("\n")
  let inEntry = false
  let name = ""
  let nameLocalized = ""
  let exec: string | undefined
  let noDisplay = false
  const mimeTypes = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      if (inEntry) break // 只取 [Desktop Entry] 段
      inEntry = line === "[Desktop Entry]"
      continue
    }
    if (!inEntry) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    // Name 本地化（zh_CN > zh；仅主 locale 前缀匹配，不遍历全部 Name[...]）
    if (key === "Name") name = value
    else if (key === `Name[${locale}]`) nameLocalized = value
    else if (key.startsWith("Name[") && key.slice(5, -1).startsWith(locale.split("_")[0]) && !nameLocalized)
      nameLocalized = value
    else if (key === "Exec") exec = value
    else if (key === "NoDisplay" && value.toLowerCase() === "true") noDisplay = true
    else if (key === "Hidden" && value.toLowerCase() === "true") noDisplay = true
    else if (key === "MimeType") for (const m of value.split(";")) if (m) mimeTypes.add(m)
  }
  if (!name && !nameLocalized) return null
  return {
    name: nameLocalized || name,
    exec,
    noDisplay,
    mimeTypes,
  }
}

/** data dirs（XDG 语义：$XDG_DATA_HOME + $XDG_DATA_DIRS，缺省补齐） */
export function xdgDataDirs(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  const dirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean)
  return [home, ...dirs]
}

/** 递归收集 applications/ 下 .desktop 文件（限深 3——kde4/ 等一级子目录足够） */
async function collectDesktopFiles(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "applications")
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith(".desktop")) out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

function execFileText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (_err, stdout) => resolve(String(stdout ?? "").trim()))
  })
}

/** 最近一次枚举的 id → desktop 绝对路径（appId 白名单，§1.2） */
const lastEnumerated = new Map<string, string>()

export async function listOpenWithApps(path: string, locale: string): Promise<OpenWithApp[]> {
  const mime = (await execFileText("xdg-mime", ["query", "filetype", path], 2000)) || "application/octet-stream"
  lastEnumerated.clear()
  const apps: OpenWithApp[] = []
  const seen = new Set<string>()
  for (const dir of xdgDataDirs()) {
    for (const abs of await collectDesktopFiles(dir)) {
      const id = abs.slice(join(dir, "applications").length + 1)
      if (seen.has(id)) continue
      let content: string
      try {
        content = await readFile(abs, "utf8")
      } catch {
        continue
      }
      const entry = parseDesktopEntry(content, locale)
      // XDG 遮蔽：首个 data dir 的同名 id 即遮蔽后续目录条目（含 NoDisplay——
      // 用户以 hidden 覆盖文件隐藏系统入口是常见手法），无论本条是否可用
      seen.add(id)
      if (!entry || entry.noDisplay || !entry.exec) continue
      // octet-stream 兜底（MIME 查询失败）不过滤；正常路径按 MimeType 命中
      if (mime !== "application/octet-stream" && !entry.mimeTypes.has(mime)) continue
      lastEnumerated.set(id, abs)
      apps.push({ id, name: entry.name })
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name))
  return apps
}

/**
 * detached spawn 用户会话应用辅助进程（gio/xdg-open/open 共用）+ 短等待窗口：
 * spawn error 与立即非零退出在此窗口内回报（stderr 首行）；长驻/正常 detach
 * 按成功（resolve("") 后事件不再影响结果）。env 必须经 sanitizedChildEnv
 * 净化（见该函数注释的实证事故）。
 */
export function spawnSessionApp(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const done = (err: string) => {
      if (!settled) {
        settled = true
        resolve(err)
      }
    }
    let stderr = ""
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: sanitizedChildEnv(process.env),
    })
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 200) stderr += d.toString()
    })
    child.on("error", () => done(`${cmd} spawn failed`))
    child.on("exit", (code) => {
      // 非零 = 启动失败（stderr 首行）；被信号杀死（code=null）按成功（病态场景兜底）
      if (code != null && code !== 0) done(`${cmd} failed: ${stderr.split("\n")[0] || code}`)
      else done("")
    })
    child.unref()
    // 短窗口兜底：无事件（正常 detach）即按成功
    setTimeout(() => done(""), timeoutMs)
  })
}

export function openWithApp(path: string, appId: string): Promise<string> {
  const desktop = lastEnumerated.get(appId)
  if (!desktop) return Promise.resolve("unknown app (list expired, reopen the picker)")
  // gio launch 负责 Exec 的 %u/%f 展开与转义（不自解析 Exec）
  return spawnSessionApp("gio", ["launch", desktop, path])
}

/**
 * 系统默认方式打开（Linux 分支，「打开」菜单项）：Electron shell.openPath 内部
 * 同样 spawn xdg-open 但无法定制 env——dev 模式 NODE_ENV 泄漏问题同 gio launch，
 * 故 Linux 自管 xdg-open 走净化环境（win32/darwin 见 ipc.ts 分支注记）。
 * 观察窗 5s（宽于 gio launch 的 1.5s）：xdg-open 是脚本，冷缓存/NFS 下枚举
 * handler 可能超 1.5s 才以非零退出，窗口过窄会把真失败当成功。
 */
export function xdgOpen(path: string): Promise<string> {
  return spawnSessionApp("xdg-open", [path], 5000)
}
