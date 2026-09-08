/**
 * CJK 标点侧向修复（remark 插件，design-markdown-preview §2.9）。
 *
 * CommonMark 侧向规则（flanking）对 CJK 的已知缺陷：闭合 `**` 前是全角标点
 * （，。、；等）、后紧跟汉字时不满足 right-flanking，无法闭合，整段加粗
 * 退化为字面文本——`**每一张订单都是双赢的结果，**只有…` 不渲染加粗；
 * 开侧对称失效：`字**，加粗**` 的 `**` 后是全角标点、前是汉字，不满足
 * left-flanking。micromark（streamdown 底层）严格遵循规范，行为相同
 * （GitHub 亦然）。参考：移动端 openbuilder design-message-autolink 的
 * CJK 标点先例（全角标点吞字，MF-1）——CJK 标点在 ASCII 为中心的
 * 语法规则里天然是坑位。
 *
 * 方案：mdast 后置补救。解析后失效的定界符残留在 text 节点字面里，本插件
 * 按「放宽侧向」重新配对：定界符严格判定不可开/闭、但侧翼字符是**非 ASCII
 * 标点**时仍允许开/闭。纯 ASCII 内容维持 CommonMark 严格语义不变
 * （`**foo,**bar` 仍不渲染，与 GitHub 一致）；`_` 底线族不补救
 * （intraword 语义不同，且 `foo__bar__baz` 型标识符误伤风险高）。
 */
export interface MdastNode {
  type?: string
  value?: string
  children?: MdastNode[]
}

/** Unicode 标点（CommonMark 口径：Pc/Pd/Pe/Pf/Pi/Po/Ps，\p{P} 等价覆盖） */
const isPunct = (ch: string | undefined) => !!ch && /\p{P}/u.test(ch)
const isWs = (ch: string | undefined) => !!ch && /\s/.test(ch)
/** 非 ASCII 标点：全角形式（，。！？（）：；）与 CJK 专有（、《》「」【】—…） */
const isCjkPunct = (ch: string | undefined) => !!ch && ch >= "\u0080" && isPunct(ch)

/* 严格侧向判定（CommonMark 口径）。text 节点两端缺失邻字符时按「非空白非
 * 标点」处理——比规范更严（规范视行首/行末为空白）；严格可开/闭的定界符
 * 已被 micromark 正常消费不会残留，收紧只会减少误判，方向安全。 */
const canOpenStrict = (prev: string | undefined, next: string | undefined) =>
  !!next && !isWs(next) && (!isPunct(next) || (!!prev && (isWs(prev) || isPunct(prev))))

const canCloseStrict = (prev: string | undefined, next: string | undefined) =>
  !!prev && !isWs(prev) && (!isPunct(prev) || (!!next && (isWs(next) || isPunct(next))))

/** 放宽侧向：严格判定不过 + 侧翼是非 ASCII 标点 → 补救允许 */
const canOpen = (prev: string | undefined, next: string | undefined) =>
  canOpenStrict(prev, next) || isCjkPunct(next)
const canClose = (prev: string | undefined, next: string | undefined) =>
  canCloseStrict(prev, next) || isCjkPunct(prev)

interface DelimRun {
  start: number
  end: number
  len: number
}

interface RescuedPair {
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
  len: number
}

/**
 * 单个 text 节点内的补救配对：扫描 `*` 连续段（长度 1–3，>3 罕见不做），
 * 等长配对（2→strong、1→emphasis、3→emphasis>strong，与 `***x***` 的
 * `<em><strong>` 语义一致）。配对不可交叉（boundary 闸门）：与已配对区间
 * 交叠的开侧定界符废弃，同 text 节点内嵌套补救不成立——嵌套场景
 * （如 `**a *b* c，**`，内层被 micromark 正常解析后外层定界符分属不同
 * text 节点）本插件不处理，属跨节点限制。返回拆分后的节点组，无可
 * 补救返回 null。
 */
export function rescueCjkEmphasis(value: string): MdastNode[] | null {
  const runs: DelimRun[] = []
  for (const m of value.matchAll(/\*+/g)) {
    const len = m[0].length
    if (len <= 3) runs.push({ start: m.index, end: m.index + len, len })
  }
  const openers: DelimRun[] = []
  const pairs: RescuedPair[] = []
  let boundary = 0
  for (const run of runs) {
    const prev = run.start > 0 ? value[run.start - 1] : undefined
    const next = run.end < value.length ? value[run.end] : undefined
    if (canClose(prev, next)) {
      // 栈顶向下找同长且不与已配对区间交叠的开侧定界符；截断其上的
      // 项（起点必然 < 当前闭侧起点，对未来闭侧同样不可用）
      let idx = -1
      for (let i = openers.length - 1; i >= 0; i--) {
        if (openers[i].len === run.len && openers[i].start >= boundary) {
          idx = i
          break
        }
      }
      if (idx !== -1) {
        pairs.push({ openStart: openers[idx].start, openEnd: openers[idx].end, closeStart: run.start, closeEnd: run.end, len: run.len })
        openers.length = idx
        boundary = run.end
        continue
      }
    }
    if (canOpen(prev, next)) openers.push(run)
  }
  if (pairs.length === 0) return null
  const out: MdastNode[] = []
  let pos = 0
  for (const p of pairs) {
    if (p.openStart > pos) out.push({ type: "text", value: value.slice(pos, p.openStart) })
    const inner: MdastNode = { type: "text", value: value.slice(p.openEnd, p.closeStart) }
    out.push(
      p.len === 1
        ? { type: "emphasis", children: [inner] }
        : p.len === 2
          ? { type: "strong", children: [inner] }
          : { type: "emphasis", children: [{ type: "strong", children: [inner] }] },
    )
    pos = p.closeEnd
  }
  if (pos < value.length) out.push({ type: "text", value: value.slice(pos) })
  return out
}

/** remark 插件形态（同 markdown.tsx softBreaks 的手写遍历风格）：遍历整树，
 *  对含 `*` 的 text 节点做补救拆分。code/inlineCode 的值在自身 value 而非
 *  text 子节点，天然不受触及 */
export const cjkEmphasis =
  () =>
  (tree: MdastNode): void => {
    const walk = (node: MdastNode) => {
      if (!Array.isArray(node.children)) return
      for (const child of node.children) walk(child)
      let next: MdastNode[] | null = null
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.type === "text" && typeof child.value === "string" && child.value.includes("*")) {
          const segs = rescueCjkEmphasis(child.value)
          if (segs) {
            if (!next) next = node.children.slice(0, i)
            next.push(...segs)
            continue
          }
        }
        next?.push(child)
      }
      if (next) node.children = next
    }
    walk(tree)
  }
