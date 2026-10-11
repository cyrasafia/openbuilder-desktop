/**
 * 会话消息文件路径自动链接（remark 插件 + 纯函数，design-message-autolink）。
 *
 * 识别规则逐条移植自移动端 openbuilder `message_autolink.dart`（六轮评审 +
 * MF 系列线上缺陷修复收敛的形态约束）；管线形态按桌面 streamdown 架构改为
 * mdast 层插件——围栏/行内代码/既有链接是结构边界，无需移动端的围栏状态机
 * 与「URI > 路径」组合正则优先级（URI 在解析期已被 remark-gfm autolink 转为
 * link 节点，link 子树整体跳过即无冲突）。
 *
 * 与移动端的桌面语义变体（design §2.4）：归属校验在**解析期**（插件闭包
 * directory），项目外/逃逸路径保持纯文本不转链（「不可点」优于「可点但错误」，
 * 且桌面无 toast 基建）；href 携带**绝对路径**，点击层零会话上下文。
 */
export interface MdastNode {
  type?: string
  value?: string
  url?: string
  children?: MdastNode[]
}

/* ---------- 路径正则（移植：段字符集/末段/行号后缀/双 lookbehind） ---------- */

const SEGMENT = "[A-Za-z0-9_@+.-]+"
const TERMINAL_SEG =
  "(?:[A-Za-z0-9_@+.-]+\\.[A-Za-z0-9]{1,10}|\\.[A-Za-z0-9][A-Za-z0-9_@+.-]*)(?![A-Za-z0-9])"
/** 行号后缀 `:N`/`:N:M`（列忽略）；guard 拒绝 glued 字母与尾冒号（ME-2） */
const LINE_SUFFIX = "(?::\\d+(?::\\d+)?)?(?![A-Za-z0-9:])"
/** lookbehind 含 `:`（MD-1）：`localhost:8080/a/b.dart`、`C:/Users/x/y.dart` 不误转链 */
const ABS_PATH = `(?<![A-Za-z0-9_/.:])/(?:${SEGMENT}/)+${TERMINAL_SEG}${LINE_SUFFIX}`
const REL_PATH = `(?<![A-Za-z0-9_/.:])(?:\\.{1,2}/)?(?:${SEGMENT}/)+${TERMINAL_SEG}${LINE_SUFFIX}`

/** text 节点自由文本扫描（matchAll 用；matchAll 不改原 regex 的 lastIndex） */
const PATH_SCAN = new RegExp(`${ABS_PATH}|${REL_PATH}`, "g")
/** 整串校验（行内代码内容 / parseFilePath 剥行号后的路径部分） */
const SINGLE_FILE_PATH = new RegExp(`^(?:${ABS_PATH}|${REL_PATH})$`)
const LINE_SUFFIX_RE = /:(\d+)(?::\d+)?$/
/** 裸域名排除（MA-2）：相对候选首段以常见 TLD 结尾 = 无 scheme URL，不转链 */
const BARE_DOMAIN_TLD = /\.(?:com|org|net|io|dev|app|co|cn|me|xyz)$/i

const WHITESPACE = /\s/

export interface ParsedFilePath {
  path: string
  line: number | null
}

/** 剥 `:N(:M)?` 后缀并对剩余部分整串校验（无空白）。行内代码与自由文本共用。 */
export function parseFilePath(s: string): ParsedFilePath | null {
  if (s === "" || WHITESPACE.test(s)) return null
  const lm = LINE_SUFFIX_RE.exec(s)
  const path = lm ? s.slice(0, lm.index) : s
  if (!SINGLE_FILE_PATH.test(path)) return null
  const line = lm ? Number(lm[1]) : null
  return { path, line }
}

export function isBareDomainPath(path: string): boolean {
  if (path.startsWith("/")) return false
  return BARE_DOMAIN_TLD.test(path.split("/")[0] ?? "")
}

/* ---------- href 编码/解码（移植：字面前缀 + 编码串上拆 query） ---------- */

/** `ob-file:///` + 逐段 encode（`/` 保留）+ `?line=N`；绝对路径形态为四斜杠 */
export function fileHref(path: string, line: number | null): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  return `ob-file:///${encoded}${line != null ? `?line=${line}` : ""}`
}

/**
 * href 解码（MA-3/MC-1/ME-1）：字面前缀剥离（禁 `new URL().pathname`——host
 * 位为空时相对/绝对歧义）→ **仍在编码串上**按第一个 `?` 拆 `line=`（路径中合法
 * `?` 已编码 `%3F`，先 decode 会腐蚀路径）→ decodeURIComponent（畸形编码
 * catch 返回 null）。
 */
export function decodeFileHref(href: string): ParsedFilePath | null {
  const prefix = "ob-file:///"
  if (!href.startsWith(prefix)) return null
  let s = href.slice(prefix.length)
  let line: number | null = null
  const q = s.indexOf("?")
  if (q >= 0) {
    const query = s.slice(q + 1)
    s = s.slice(0, q)
    if (query.startsWith("line=")) {
      const n = Number(query.slice(5))
      line = Number.isInteger(n) ? n : null
    }
  }
  let path: string
  try {
    path = decodeURIComponent(s)
  } catch {
    return null
  }
  if (path === "") return null
  return { path, line }
}

/* ---------- 归属校验（桌面变体：返回绝对路径；移动端返回相对） ---------- */

/**
 * 解析期归属校验：绝对路径须以 `directory + '/'` 开头（strip 后规范化）；相对
 * 路径 resolve `.`/`..` 后仍须位于 directory 内（MC-2：`../` 逃逸与项目外绝对
 * 路径同等拒绝）。失败返回 null，调用方保持纯文本不转链。
 */
export function resolveProjectPath(path: string, directory: string): string | null {
  if (directory === "") return null
  const rel = path.startsWith("/") ? stripProjectRoot(path, directory) : path
  if (rel == null) return null
  const normalized = normalizeRelative(rel)
  if (normalized == null) return null
  const base = directory.endsWith("/") ? directory.slice(0, -1) : directory
  return `${base}/${normalized}`
}

function stripProjectRoot(abs: string, directory: string): string | null {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  if (!abs.startsWith(prefix)) return null
  return abs.slice(prefix.length)
}

function normalizeRelative(rel: string): string | null {
  const out: string[] = []
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(seg)
    }
  }
  if (out.length === 0) return null
  return out.join("/")
}

/* ---------- remark 插件（mdast 层，手写遍历同 cjkEmphasis 约定） ---------- */

/**
 * 消息文件路径转链插件。用法：`[messageFileLinks, { directory }]`（tuple 形式
 * 传入 Streamdown remarkPlugins）。directory 空 = 不识别（消息无会话目录的
 * 防御路径）。link 子树整体跳过（既有链接不二次处理；GFM autolink 的 URI
 * 天然无冲突）；围栏代码块值在 `value` 非 text 子节点，天然不触及。
 */
export function messageFileLinks(options: { directory: string }) {
  const { directory } = options
  return (tree: MdastNode): void => {
    if (!directory) return
    walk(tree, false, directory)
  }
}

function walk(node: MdastNode, insideLink: boolean, directory: string): void {
  if (insideLink) return
  if (!Array.isArray(node.children)) return
  // 先递归子树（link 节点自身进入即被 insideLink 剪枝），后序重建本层 children；
  // linkReference 子树同样剪枝（评审 nit 6）：引用标签文本转链会嵌套产出
  // `<a>` in `<a>` 无效 HTML——linkReference 的目标在 definition 节点，
  // 手写 ob-file definition 由点击层归属校验兜底
  for (const child of node.children) {
    walk(child, child.type === "link" || child.type === "linkReference", directory)
  }
  let next: MdastNode[] | null = null
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    const replacement =
      child.type === "inlineCode" && typeof child.value === "string"
        ? linkifyInlineCode(child.value, directory)
        : child.type === "text" && typeof child.value === "string"
          ? linkifyText(child.value, directory)
          : null
    if (replacement) {
      if (!next) next = node.children.slice(0, i)
      next.push(...replacement)
    } else {
      next?.push(child)
    }
  }
  if (next) node.children = next
}

/** text 节点扫描：每个匹配过裸域名排除 + 归属校验，通过则拆出 link 节点 */
function linkifyText(value: string, directory: string): MdastNode[] | null {
  if (!value.includes("/")) return null
  const out: MdastNode[] = []
  let pos = 0
  let changed = false
  for (const m of value.matchAll(PATH_SCAN)) {
    const start = m.index ?? 0
    const parsed = parseFilePath(m[0])
    if (!parsed || isBareDomainPath(parsed.path)) continue
    const abs = resolveProjectPath(parsed.path, directory)
    if (!abs) continue
    changed = true
    if (start > pos) out.push({ type: "text", value: value.slice(pos, start) })
    out.push({ type: "link", url: fileHref(abs, parsed.line), children: [{ type: "text", value: m[0] }] })
    pos = start + m[0].length
  }
  if (!changed) return null
  if (pos < value.length) out.push({ type: "text", value: value.slice(pos) })
  return out
}

/**
 * 行内代码内容**仅为一个路径**时整节点替换为 link（反引号去除，链接文本 =
 * trim 后内容含行号后缀——移动端同构）；含其他内容/含空白/非路径/裸域名保持
 * code 展示。多行 code span 的 value 含 `\n` 被无空白规则整体拒绝。
 */
function linkifyInlineCode(value: string, directory: string): MdastNode[] | null {
  const inner = value.trim()
  const parsed = parseFilePath(inner)
  if (!parsed || isBareDomainPath(parsed.path)) return null
  const abs = resolveProjectPath(parsed.path, directory)
  if (!abs) return null
  return [{ type: "link", url: fileHref(abs, parsed.line), children: [{ type: "text", value: inner }] }]
}
