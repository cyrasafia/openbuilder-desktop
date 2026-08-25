/**
 * HTML 预览文档构建（design-html-preview §3.1）：向原始 HTML 注入 CSP meta
 * （default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:）。
 * 扫描器移植 openbuilder design-html-preview 的"严格单调单趟线性扫描"规格：
 * 跳过注释（含 --!> / <!--> 突闭）/bogus comment/raw-text 元素（含 template
 * 惰性内容，闭合终止符含 > / 空白 / 斜杠，假闭合 </scriptx 不结束）/plaintext，
 * 普通标签体以首个 > 为界；命中真实 <head> 注入其后，仅 <html> 补 head，
 * 片段前置。对齐解析器忽略语义：</head> 或 <body> 之后的 <head> 不注入
 * （meta 落 body 无效）、非文档头部的 <html> 不作注入点——宁走前置兜底
 * （前置的 meta 必为 head 子节点，CSP 恒生效）。残余盲区（属性值内字面
 * 标签等）后果 = CSP 失效（外链可载），脚本仍被 iframe sandbox 禁死——
 * 可接受（设计 §2）。
 */

export const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:">'

/** 扫描跳过其内容（到匹配闭合标签）的 raw-text / 惰性元素 */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "xmp",
  "noembed",
  "noframes",
  "template",
])

const SCAN_LIMIT = 8 * 1024 * 1024

function isTagNameStart(ch: string | undefined): boolean {
  return ch != null && /[a-zA-Z]/.test(ch)
}

/** 注释结束位置（含 `--!>` 变体与 `<!-->`/`<!--->` 突闭）；-1 = 未闭合 */
function commentEnd(lower: string, lt: number): number {
  // 突闭：<!-->（5 字符）与 <!--->（6 字符）
  if (lower.startsWith("<!-->", lt)) return lt + 5
  if (lower.startsWith("<!--->", lt)) return lt + 6
  const from = lt + 4
  const a = lower.indexOf("-->", from)
  const b = lower.indexOf("--!>", from)
  if (a === -1) return b === -1 ? -1 : b + 4
  if (b === -1) return a + 3
  return a < b ? a + 3 : b + 4
}

/** 单趟扫描注入 CSP；返回带注入的完整文档 */
export function buildHtmlPreviewDocument(html: string): string {
  if (html.length > SCAN_LIMIT) {
    // 超限跳过扫描：前置注入（CSP 仍生效，可能触发 quirks mode 渲染降级）
    return CSP_META + html
  }
  const lower = html.toLowerCase()
  const len = html.length
  let i = 0
  let htmlInsertion = -1 // <html…> 开标签结束位置（无真实 head 时用）
  let headDead = false // 见过 </head> 或 <body>：其后的 <head> 是被解析器忽略的假标签
  let seenTag = false // 已见过任何真实标签（非注释/bogus）：其后的 <html> 同样被忽略

  const injectAt = (pos: number, payload: string) => html.slice(0, pos) + payload + html.slice(pos)

  while (i < len) {
    const lt = lower.indexOf("<", i)
    if (lt === -1) break
    // 间隙文本（上个结构结束到本标签前）：非空白 = 已进入隐式 body——
    // 其后的 <head>/<html> 均被解析器忽略（headDead/seenTag 置位）
    if (lower.slice(i, lt).trim() !== "") {
      headDead = true
      seenTag = true
    }
    // 注释
    if (lower.startsWith("<!--", lt)) {
      const end = commentEnd(lower, lt)
      if (end === -1) break
      i = end
      continue
    }
    // bogus comment（<?…> / 非注释 <!…>，含 doctype/CDATA，止于首个 >）
    if (lt + 1 < len && (lower[lt + 1] === "!" || lower[lt + 1] === "?")) {
      const gt = lower.indexOf(">", lt + 2)
      if (gt === -1) break
      i = gt + 1
      continue
    }
    // 闭合标签：普通标签体处理（首个 > 为界）
    if (lt + 1 < len && lower[lt + 1] === "/") {
      let j = lt + 2
      while (j < len && /[a-zA-Z0-9]/.test(lower[j])) j++
      const tag = lower.slice(lt + 2, j)
      const gt = lower.indexOf(">", j)
      if (gt === -1) break
      if (tag === "head") headDead = true
      seenTag = true
      i = gt + 1
      continue
    }
    // 开标签
    if (isTagNameStart(lower[lt + 1])) {
      let j = lt + 1
      while (j < len && /[a-zA-Z0-9]/.test(lower[j])) j++
      const tag = lower.slice(lt + 1, j)
      // 标签体：首个 > 为界（属性值内字面 <head> 因此随体消费，不误报）
      const gt = lower.indexOf(">", j)
      if (gt === -1) break
      const afterTag = gt + 1
      if (tag === "head") {
        if (!headDead) {
          // 真实 head：紧随其后注入
          return injectAt(afterTag, CSP_META)
        }
        // 假 head（body 后）：继续扫描，最终走兜底
      } else if (tag === "html") {
        // 只有前面无真实标签的 <html> 是有效注入点（后续 <html> 被解析器忽略）
        if (!seenTag) htmlInsertion = afterTag
      } else if (tag === "body") {
        headDead = true
      }
      seenTag = true
      if (tag === "plaintext") {
        // 无闭合标签，吞到文档尾
        break
      }
      if (RAW_TEXT_ELEMENTS.has(tag)) {
        // raw-text：找带终止符校验的闭合（</tag 后随 > / 空白 / 斜杠；
        // </scriptx 不闭合，</script/> 合法自闭合）
        let from = afterTag
        for (;;) {
          const close = lower.indexOf("</" + tag, from)
          if (close === -1) {
            from = -1
            break
          }
          const afterName = close + 2 + tag.length
          const term = lower[afterName]
          if (term === ">" || term === "/" || term === undefined || /\s/.test(term)) {
            from = close
            break
          }
          from = afterName
        }
        if (from === -1) break
        const gt2 = lower.indexOf(">", from + 2 + tag.length)
        if (gt2 === -1) break
        i = gt2 + 1
        continue
      }
      i = afterTag
      continue
    }
    // 裸 < 后非标签起始：当普通字符跳过
    i = lt + 1
  }

  if (htmlInsertion >= 0) {
    // 只有文档头部的 <html>：补一个 <head>（该位置先于任何 body，恒有效）
    return injectAt(htmlInsertion, "<head>" + CSP_META + "</head>")
  }
  // 片段 / 无注入点 / 假 head：前置（meta 必为 head 子节点，CSP 恒生效）
  return CSP_META + html
}
