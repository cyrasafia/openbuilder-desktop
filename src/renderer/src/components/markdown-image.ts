/**
 * markdown 相对路径图片解析（design-markdown-preview §2.8）：预览态 `<img src>`
 * 相对路径以 md 文件所在目录为基准解析为绝对路径；不可解析（外链/协议相对/
 * 非图片扩展/空 src）返回 null——字面交给 `<img>`，外链图照常经网络加载，
 * 非图片扩展维持破图（与「分发只按扩展名，不嗅探内容」同哲学）。
 * 纯函数，无 React 依赖（同 markdown-frontmatter.ts 先例）。
 * isImagePath / IMAGE_MIME_BY_EXT 自 workspace.tsx 迁入：文件 Tab 图片分发
 * （design-image-preview §2.2）与 md 相对图片扩展名闸门共用同一集合，单一来源。
 */

/**
 * 位图扩展 → mime（design-image-preview §2.3：服务端 mimeType 缺省时的
 * data URL 兜底映射）。svg 不在此表（服务端对 svg 返回 text 源码，另行分发）。
 */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

/**
 * 图片文件判定（design-image-preview §2.2）：basename 最后一个**非前导**点的
 * 后缀，大小写不敏感；点文件（前导点，如 `.png`）不命中。
 */
export function isImagePath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === "svg" || ext in IMAGE_MIME_BY_EXT
}

/** URL scheme（`http:` / `data:` / `file:` 等，首段字母开头 + 合法 scheme 字符） */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * POSIX join + normalize：折叠空段 / `.` / `..`（溢出的 `..` 丢弃）。
 * rel 以 `/` 开头视作文件系统绝对路径（web 语义的站点根在本功能无对应物，
 * 本地文件预览按绝对路径消费），baseDir 不参与。
 */
function resolvePosix(baseDir: string, rel: string): string {
  const joined = rel.startsWith("/") ? rel : `${baseDir}/${rel}`
  const out: string[] = []
  for (const seg of joined.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return `/${out.join("/")}`
}

/**
 * md 图片 src → 绝对路径。null = 不解析（外链/data URL/协议相对/非图片扩展/
 * 空 src），字面透传 `<img>`。query/hash 先剥离（GitHub 口径）；`%XX` 解包
 * （`%20` 空格等；坏 `%` 序列保留原样，不整体失败——扩展名仍可命中闸门）。
 */
export function resolveMarkdownImage(baseDir: string, src: string): string | null {
  const clean = src.split("#")[0].split("?")[0]
  if (!clean || URL_SCHEME.test(clean) || clean.startsWith("//")) return null
  let rel = clean
  try {
    rel = decodeURIComponent(clean)
  } catch {
    // 坏 % 序列：保留原样
  }
  const path = resolvePosix(baseDir, rel)
  return isImagePath(path) ? path : null
}

/**
 * img 覆写侧消费（design-markdown-preview §2.8）：识别 `relativeImageRewrite`
 * 预重写后的 `/` 绝对路径形态（经 rehype-harden 透传时 URL 规范化会百分号编码
 * 空格等——解码还原真实路径）。null = 非重写形态（外链/data/相对字面等），
 * 字面透传 `<img>`。
 */
export function markdownRewrittenImagePath(src: string): string | null {
  if (!src.startsWith("/")) return null
  let path = src.split("#")[0].split("?")[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    // 坏 % 序列：保留原样
  }
  return isImagePath(path) ? path : null
}

/** mdast 最小结构视图（同 markdown.tsx softBreaks 手法，不引入 unist 依赖） */
interface MdNodeLike {
  type?: string
  url?: string
  children?: MdNodeLike[]
}

/**
 * remark 插件（design-markdown-preview §2.8）：mdast image 节点 url 预重写——
 * 相对路径在 streamdown 默认 rehype 管线**之前**解析为文件系统绝对路径。管线
 * 事实（实测 + rehype-harden 源码）：其 wildcard 配置把 `./a.png`/`../a.png`
 * 按 dummy origin 折叠成 `/a.png`（`..` 段基准信息丢失）、裸 `a.png` 直接拦为
 * 占位节点；而 `/` 开头的 relative 输入原样透传（pathname 回写）——故重写为
 * `/` 绝对路径可无损穿过 harden + sanitize（src 协议白名单只认 http/https，
 * 自定义 scheme 标记不可行）。不可解析（外链/非图扩展）不改写，维持原行为。
 * 代码块/行内代码不产生 image 节点，天然跳过；raw html `<img>` 不经 mdast
 * image 节点，不覆盖（仅支持 markdown 图片语法，含 reference 形态——改写
 * definition 节点；引用与定义跨 streamdown 块时解析本就落回字面文本，属
 * 既有行为，不在本层处理）。
 *
 * **必须以 `[plugin, { baseDir }]` 元组形态挂载**：streamdown 的 processor 缓存
 * 按插件源码文本生成 key——返回闭包的工厂（`make(baseDir)` 形态）源码恒同，
 * 不同基准目录的文件会撞 key 复用首个处理器（实测：先开 /repo 下 md 再开
 * /repo/docs 下的，后者图片按错误基准重写）。元组形态的 options 参与序列化
 * 进 key（`JSON.stringify(opts)`），基准目录得以区分。
 */
export function relativeImageRewrite(options: { baseDir: string }) {
  const { baseDir } = options
  return (tree: MdNodeLike): void => {
    const walk = (node: MdNodeLike) => {
      // image：行内图片语法；definition：reference 语法的定义节点（`![alt][ref]`
      // + `[ref]: ./img/a.png`——remark-rehype 解析 imageReference 时取 definition
      // 的 url 作 src，不改写则 harden 折叠后被覆写消费成错误路径）。
      // definition 同时服务 linkReference：图片扩展闸门下非图 url 不动，链接
      // 行为不变（相对链接本就不跳转，§3 既有决策）
      if (
        (node.type === "image" || node.type === "definition") &&
        typeof node.url === "string"
      ) {
        const resolved = resolveMarkdownImage(baseDir, node.url)
        if (resolved) node.url = resolved
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
  }
}
