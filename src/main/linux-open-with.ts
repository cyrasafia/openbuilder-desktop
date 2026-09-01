/**
 * Linux「打开方式」（design-linux-open-with §1）：.desktop 枚举/解析纯函数 +
 * xdg-mime / gio launch 子进程封装。纯函数独立导出供单测（fixture 字符串）。
 */
import { execFile, spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export interface OpenWithApp {
  id: string
  /** data dir 相对的 .desktop 路径（如 org.gnome.TextEditor.desktop / kde4/foo.desktop） */
  name: string
  /** 应用图标 data URL（主题查找产物；未找到/解析失败 = null——渲染层按首字母瓷片兜底） */
  icon: string | null
  /** MimeType 是否命中目标 MIME（祖先闭包）；全量列表中匹配组排前、其余排后 */
  matches: boolean
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
  /** Icon= 原始值：主题图标名或绝对路径（渲染消费 png/svg data URL，§1.1） */
  icon?: string
}

/** INI 浅解析（[Desktop Entry] 段键值；等号分割、注释/空行跳过；仅取首个段头后键） */
export function parseDesktopEntry(content: string, locale: string): DesktopEntry | null {
  const lines = content.split("\n")
  let inEntry = false
  let name = ""
  let nameLocalized = ""
  let exec: string | undefined
  let noDisplay = false
  let icon: string | undefined
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
    else if (key === "Icon") icon = value
    else if (key === "MimeType") for (const m of value.split(";")) if (m) mimeTypes.add(m)
  }
  if (!name && !nameLocalized) return null
  return {
    name: nameLocalized || name,
    exec,
    noDisplay,
    icon,
    mimeTypes,
  }
}

/**
 * 解析 subclasses 数据（共享 mime-db `<data>/mime/subclasses`，每行
 * `<子类型> <祖先类型>`；# 注释）→ 子类型 → 直接祖先多重集。
 * 语义对齐 libegg/xdg-utils：.desktop 只声明祖先 MIME（如文本编辑器仅声明
 * `text/plain`）即可打开具体子类型（如 .json 子类链 text/plain ⇐ … ⇐
 * application/json），字面 MimeType 精确匹配会漏掉这些应用（2026-08-31 真机
 * 实证：application/json 只出 firefox，遗漏 gedit/TextEditor/micro/vim/sublime）。
 */
export function parseSubclasses(content: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const sp = line.search(/\s/)
    if (sp < 0) continue
    const child = line.slice(0, sp)
    const parent = line.slice(sp + 1).trim()
    if (!map.has(child)) map.set(child, new Set())
    map.get(child)!.add(parent)
  }
  return map
}

/**
 * MIME 祖先后闭包（含自身；直接祖先由 subclasses 反复解引用；环安全）。
 * 查不到 subclasses 数据时仅返回自身（退化为旧的字面匹配行为）。
 */
export function mimeAncestorsOf(
  mime: string,
  subclasses: Map<string, Set<string>>,
): Set<string> {
  const out = new Set<string>([mime])
  const queue = [mime]
  while (queue.length > 0) {
    const mime = queue.pop()!
    for (const parent of subclasses.get(mime) ?? []) {
      if (!out.has(parent)) {
        out.add(parent)
        queue.push(parent)
      }
    }
  }
  return out
}

/** data dirs（XDG 语义：$XDG_DATA_HOME + $XDG_DATA_DIRS，缺省补齐） */
export function xdgDataDirs(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  const dirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean)
  return [home, ...dirs]
}

/**
 * 解析 index.theme 的 Inherits= 链（纯函数）。
 * theme 文件按 XDG icon spec：`[Icon Theme]` 段 `Inherits=` 逗号列表。
 */
export function parseInherits(content: string): string[] {
  const out: string[] = []
  let inEntry = false
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("[")) {
      inEntry = line === "[Icon Theme]"
      continue
    }
    if (!inEntry) continue
    const eq = line.indexOf("=")
    if (eq > 0 && line.slice(0, eq).trim() === "Inherits") {
      for (const t of line.slice(eq + 1).split(",")) {
        const name = t.trim()
        if (name && !out.includes(name)) out.push(name)
      }
      break
    }
  }
  return out
}

/** 用户当前 icon 主题名（gsettings，2s 超时；GNOME 外桌面/失败 → hicolor） */
async function currentUserTheme(): Promise<string> {
  const v = await execFileText(
    "gsettings",
    ["get", "org.gnome.desktop.interface", "icon-theme"],
    2000,
  )
  // gsettings 输出带引号：'Adwaita' → Adwaita
  const m = v.match(/^'?([^']+)'?$/)
  return m?.[1]?.trim() || "hicolor"
}

/**
 * 主题继承链（B 类修复）：start 主题 → Inherits 逐级解引用；hicolor 未显式
 * 出现时恒补链尾兜底（XDG icon spec 要求）。读不到 index.theme 的主题不展开
 * Inherits 但仍占链位（其目录查找自然落空）。返回按优先级排序的主题名列表
 * （环安全——已访问主题跳过）。
 */
export function themeChainOf(
  start: string,
  dataDirs: string[],
  readIndex: (theme: string) => string | null = (t) => {
    for (const dir of dataDirs) {
      const p = join(dir, "icons", t, "index.theme")
      if (existsSync(p)) return readFileSync(p, "utf8")
    }
    return null
  },
): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const t = queue.shift()!
    if (seen.has(t)) continue
    seen.add(t)
    chain.push(t)
    if (t === "hicolor") continue // spec：hicolor 不再 Inherits
    const content = readIndex(t)
    if (!content) continue
    for (const parent of parseInherits(content)) if (!seen.has(parent)) queue.push(parent)
  }
  if (!chain.includes("hicolor")) chain.push("hicolor")
  return chain
}

/** 档位遍历序（A 类修复）：目标 48 精确档 → 升档全序（64→96→128→256→512…递增）
 *  → 降档全序（32→24→22→16→8）。用户要求**升档优先于降档**（大图标缩小渲染
 *  无损，小图标放大会糊）——纯距离排序会把 32 排在 96 前，与需求相反（2026-08-31
 *  code review 修正）。@2 目录不单列（位图按文件名查，可接受）。 */
const ICON_SIZES_ASC_FIRST = (want: number): number[] => {
  const sizes = [...new Set([48, 64, 96, 128, 256, 512, 72, 32, 24, 22, 16, 8])]
  const up = sizes.filter((s) => s > want).sort((a, b) => a - b)
  const down = sizes.filter((s) => s < want).sort((a, b) => b - a)
  return [want, ...up, ...down]
}

/** 主题内 context 子目录遍历序：apps 优先，其余（legacy/actions/devices 等
 *  AdwaitaLegacy 把老应用图标放在 legacy/）兜底。 */
const ICON_CONTEXTS = ["apps", "legacy", "actions", "devices", "mimetypes", "places", "status", "categories", "emblems", "emotes", "ui"] as const

/**
 * Icon= 值 → 图标绝对路径（纯函数，注入依赖便于单测）。
 * XDG icon spec 查找（2026-08-31 修订，覆盖五类失败实测）：
 * 1. 主题链（B）：gsettings 当前主题 → Inherits 解引用 → hicolor 恒兜底
 * 2. scalable 优先（svg/png——C 类：scalable/ 目录可能装的是位图）
 * 3. 位图档位升→降序遍历（A：typora 仅 128/256 档）× context 目录（B：
 *    AdwaitaLegacy 把应用图标放 legacy/、actions/）
 * 4. 遗留 pixmaps：大小写不敏感 + svg（D：Alacritty.svg）
 * `Icon=/abs/path` 按后缀直用（无后缀先 .png 后 .svg）。SVG 可渲染性已实证
 * （Electron 43 真机 `<img>` 对 data:/file: 的 svg 均成功光栅化）。Flatpak
 * exports 在 data dirs 内天然覆盖。彻底未找到 = null（E 类：悬空引用），
 * 渲染层首字母瓷片兜底。
 */
export function iconPathOf(
  icon: string,
  dataDirs: string[],
  size = 48,
  exists: (path: string) => boolean = existsSync,
  chain: string[] = ["hicolor"],
): string | null {
  if (!icon) return null
  // 绝对路径：svg/png 直用；无后缀先 .png 后 .svg
  if (icon.startsWith("/")) {
    if (/\.(png|svg)$/i.test(icon)) return exists(icon) ? icon : null
    for (const ext of [".png", ".svg"]) {
      const withExt = icon + ext
      if (exists(withExt)) return withExt
    }
    return null
  }
  // 1+2：主题链 × scalable（svg → png；scalable 目录装位图同样接）
  for (const theme of chain) {
    for (const ext of ["svg", "png"]) {
      for (const dir of dataDirs) {
        const p = join(dir, "icons", theme, "scalable", "apps", `${icon}.${ext}`)
        if (exists(p)) return p
      }
    }
  }
  // 3：主题链 × 档位（升→降）× context 目录
  for (const theme of chain) {
    for (const sz of ICON_SIZES_ASC_FIRST(size)) {
      for (const ctx of ICON_CONTEXTS) {
        for (const dir of dataDirs) {
          const p = join(dir, "icons", theme, `${sz}x${sz}`, ctx, `${icon}.png`)
          if (exists(p)) return p
        }
      }
    }
  }
  // 4：遗留 pixmaps——大小写不敏感 + svg
  for (const dir of dataDirs) {
    const legacy = `${icon}.png`
    const legacySvg = `${icon}.svg`
    for (const name of [legacy, legacySvg]) {
      const p = join(dir, "pixmaps", name)
      if (exists(p)) return p
    }
  }
  return null
}

/**
 * pixmaps 大小写不敏感兜底（D 类）：iconPathOf 精确名未命中后调用，
 * 列目录逐项比对（pixmaps 目录通常数百项，同步 IO 可接受；列目录谓词
 * 注入便于单测）。
 */
export function iconPixmapCaseInsensitiveOf(
  icon: string,
  dataDirs: string[],
  listDir: (path: string) => string[] | null = (p) => {
    try {
      return readdirSync(p)
    } catch {
      return null
    }
  },
): string | null {
  const want = `${icon.toLowerCase()}`
  for (const dir of dataDirs) {
    const pm = join(dir, "pixmaps")
    const entries = listDir(pm)
    if (!entries) continue
    const hit = entries.find(
      (f) =>
        f.toLowerCase() === `${want}.png` || f.toLowerCase() === `${want}.svg`,
    )
    if (hit) return join(pm, hit)
  }
  return null
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

/**
 * 读共享 mime-db 子类表（xdg-mime 数据目录下的 `mime/subclasses`，与
 * `xdg-mime query filetype` 同源）：**跨全部 data dir 合并**（mime-db 文件按
 * shared-mime-info 规范联合而非遮蔽——如 WPS 只写 ~/.local/share/mime/subclasses，
 * freedesktop 基线在 /usr/share/mime/subclasses，取首个会丢整条链）。
 * 全部读取失败/不存在 → 空 map，枚举退化为字面匹配。
 */
async function readSubclasses(): Promise<Map<string, Set<string>>> {
  const merged = new Map<string, Set<string>>()
  for (const dir of xdgDataDirs()) {
    let part: Map<string, Set<string>>
    try {
      part = parseSubclasses(await readFile(join(dir, "mime", "subclasses"), "utf8"))
    } catch {
      continue
    }
    for (const [child, parents] of part) {
      const acc = merged.get(child) ?? new Set<string>()
      for (const p of parents) acc.add(p)
      merged.set(child, acc)
    }
  }
  return merged
}

/** 最近一次枚举的 id → desktop 绝对路径（appId 白名单，§1.2） */
const lastEnumerated = new Map<string, string>()

export async function listOpenWithApps(path: string, locale: string): Promise<OpenWithApp[]> {
  const mime = (await execFileText("xdg-mime", ["query", "filetype", path], 2000)) || "application/octet-stream"
  // 祖先闭包（共享 mime-db `<data>/mime/subclasses`；缺数据退化为字面匹配）：
  // .desktop 常只声明祖先类型（文本编辑器仅 `text/plain`），按 gio/libegg 语义
  // 子类文件同样可由其打开（见 parseSubclasses 注释的 2026-08-31 实证）
  const subclasses = await readSubclasses()
  const accepted = mimeAncestorsOf(mime, subclasses)
  // 主题链每枚举只算一次（性能实证 2026-08-31：iconDataUrlOf 内逐 app 调
  // currentUserTheme → 110 个 gsettings 子进程 ≈ 900ms，占总耗时 ~75%）
  const dirs = xdgDataDirs()
  const chain = themeChainOf(await currentUserTheme(), dirs)
  lastEnumerated.clear()
  // 2026-08-31 修订：**全量应用**（不再按 MimeType 过滤）——用户要求「所有类型的
  // open with 列表都改为全量应用」；匹配与否以 matches 标记，渲染层分组展示。
  // 单 app 处理（收集/读文件/图标）彼此无依赖 → Promise.all 并行
  const results: OpenWithApp[] = []
  const seen = new Set<string>()
  const jobs: Promise<void>[] = []
  for (const dir of dirs) {
    for (const abs of await collectDesktopFiles(dir)) {
      const id = abs.slice(join(dir, "applications").length + 1)
      if (seen.has(id)) continue
      seen.add(id)
      jobs.push(
        (async () => {
          let content: string
          try {
            content = await readFile(abs, "utf8")
          } catch {
            return
          }
          const entry = parseDesktopEntry(content, locale)
          // XDG 遮蔽已由 seen 预过滤（此处 entry 仍可能为 null——解析失败跳过）
          if (!entry || entry.noDisplay || !entry.exec) return
          const matches =
            mime === "application/octet-stream" ||
            [...entry.mimeTypes].some((m) => accepted.has(m))
          const app: OpenWithApp = {
            id,
            name: entry.name,
            icon: await iconDataUrlOf(entry.icon, dirs, chain),
            matches,
          }
          results.push(app)
          lastEnumerated.set(id, abs)
        })(),
      )
    }
  }
  await Promise.all(jobs)
  // 分组排序（2026-08-31）：匹配组在前、其余组在后；组内按本地化名字母序
  results.sort((a, b) => (a.matches === b.matches ? a.name.localeCompare(b.name) : a.matches ? -1 : 1))
  return results
}

/** Icon= → 图标 data URL（svg→image/svg+xml、png→image/png；未找到/读取失败 = null，兜底首字母瓷片）。
 *  主题链/dir 列表由调用方注入（每枚举一次——否则 110 次 gsettings 子进程 ≈ 900ms），
 *  pixmaps 大小写不敏感兜底。 */
async function iconDataUrlOf(
  icon: string | undefined,
  dirs: string[],
  chain: string[],
): Promise<string | null> {
  if (!icon) return null
  const file =
    iconPathOf(icon, dirs, 48, existsSync, chain) ?? iconPixmapCaseInsensitiveOf(icon, dirs)
  if (!file) return null
  const mime = file.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png"
  try {
    const buf = await readFile(file)
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
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
