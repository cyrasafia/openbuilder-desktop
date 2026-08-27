/**
 * YAML front matter 拆分（design-markdown-preview §2.5）。
 * 语义移植自移动端 openbuilder `lib/features/files/markdown_html.dart` 的
 * `splitFrontMatter`（按 AGENTS.md 约定先行检索到的同类实现，桌面端不重新发明）：
 * - 起始 `---` 必须在首字节（无前导空白）；
 * - 围栏线 trim 后恰为 `---`，且块内至少含一条任意缩进层级的 `key: value`
 *   （纯 `---` 夹心无映射 = 两条分隔线，不是 front matter）；
 * - 一旦判定成立，YAML 头恒从正文剥离（不再以裸 YAML 渲染）；元数据卡为尽力
 *   提取——只收顶层标量条目，纯嵌套容器时 frontMatter 为 null 但正文仍剥离。
 * 已知局限（与 openbuilder 原版逐行一致，属参考实现继承而非移植走样；两端口
 * 一起修才可偏离）：闭合围栏按「首条 trim 后恰为 ---」扫描，不区分缩进/块标量
 * 内部——块标量里嵌 `---` 行（如 desc: | 内含分隔线）会被误认闭合线，desc 塌缩
 * 为占位、缩进残文泄入正文。
 * 返回 null = 未检出 front matter（正文原样）；返回值的 frontMatter 可为 null。
 */

export interface FrontMatterEntry {
  key: string
  value: string
}

export interface FrontMatterSplit {
  frontMatter: FrontMatterEntry[] | null
  body: string
}

/** 首字符为空格/制表符 = 缩进行（归属上层键） */
function isIndented(line: string): boolean {
  const c = line.charCodeAt(0)
  return c === 0x20 || c === 0x09
}

/** 块标量（|/> 及其 chomping 变体）：literal 保留换行，folded 折叠为空格 */
function blockScalarKind(value: string): "literal" | "folded" | null {
  switch (value) {
    case "|":
    case "|-":
    case "|+":
      return "literal"
    case ">":
    case ">-":
    case ">+":
      return "folded"
    default:
      return null
  }
}

const EMPTY_VALUE = "—" // 空值占位（与 openbuilder 一致的 em dash）

export function splitFrontMatter(content: string): FrontMatterSplit | null {
  if (!content.startsWith("---")) return null
  const lines = content.split("\n")
  if (lines.length === 0 || lines[0].trim() !== "---") return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  // 无闭合围栏，或围栏内为空（end===1）：不是 front matter
  if (end <= 1) return null
  const entries: FrontMatterEntry[] = []
  let sawMapping = false
  let i = 1
  while (i < end) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }
    const trimmed = line.trim()
    if (trimmed.indexOf(":") > 0) sawMapping = true
    // 缩进行归属上层键（嵌套容器成员/块标量续行），条目提取在顶层行处理
    if (isIndented(line)) {
      i++
      continue
    }
    const colon = line.indexOf(":")
    if (colon <= 0) {
      i++
      continue
    }
    const key = line.slice(0, colon).trim()
    const rawValue = line.slice(colon + 1).trim()
    if (key === "") {
      i++
      continue
    }
    const block = blockScalarKind(rawValue)
    if (block !== null) {
      const buf: string[] = []
      i++
      while (i < end) {
        const l = lines[i]
        if (l.trim() === "") {
          buf.push("")
          i++
          continue
        }
        if (!isIndented(l)) break
        buf.push(l.trim())
        i++
      }
      const joined = buf
        .filter((s) => s !== "")
        .join(block === "folded" ? " " : "\n")
      entries.push({ key, value: joined === "" ? EMPTY_VALUE : joined })
      continue
    }
    let value = rawValue
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (value === "") {
      // 空值下探：下一非空行若为缩进 = 嵌套容器父键（不收条目）；否则空标量占位
      let peek = i + 1
      while (peek < end && lines[peek].trim() === "") peek++
      if (peek < end && isIndented(lines[peek])) {
        i++
        continue
      }
      value = EMPTY_VALUE
    }
    entries.push({ key, value })
    i++
  }
  // 纯 `---` 夹心（无任何映射行）：判定不成立，正文原样返回
  if (!sawMapping) return null
  const bodyStart = end + 1
  let body: string
  if (bodyStart >= lines.length) {
    body = ""
  } else {
    let s = bodyStart
    if (lines[s] === "") s++ // 剥离围栏后紧跟的一个空行（与正文首块间不留双空行）
    body = lines.slice(s).join("\n")
  }
  return { frontMatter: entries.length === 0 ? null : entries, body }
}
