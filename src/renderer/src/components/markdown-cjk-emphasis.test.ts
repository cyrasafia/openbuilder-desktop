/**
 * CJK 标点侧向修复（design-markdown-preview §2.9）：rescueCjkEmphasis 纯函数
 * + 插件遍历。核心样例来自用户实测（闭合 ** 前是全角逗号、后紧跟汉字）。
 */
import { describe, expect, it } from "vitest"
import { cjkEmphasis, rescueCjkEmphasis, type MdastNode } from "./markdown-cjk-emphasis"

const text = (value: string): MdastNode => ({ type: "text", value })
const strong = (value: string): MdastNode => ({ type: "strong", children: [text(value)] })
const emphasis = (value: string): MdastNode => ({ type: "emphasis", children: [text(value)] })

describe("rescueCjkEmphasis", () => {
  it("闭合 ** 前是全角标点（用户实测样例）→ strong", () => {
    expect(rescueCjkEmphasis("前文。**每一张订单都是双赢的结果，**只有在基础上。")).toEqual([
      text("前文。"),
      strong("每一张订单都是双赢的结果，"),
      text("只有在基础上。"),
    ])
  })

  it("开侧 ** 后是全角标点、前是汉字 → strong（开侧对称失效补救）", () => {
    expect(rescueCjkEmphasis("字**，加粗**尾")).toEqual([text("字"), strong("，加粗"), text("尾")])
  })

  it("text 节点开头的 **（prev 缺失按非空白处理）可正常开侧", () => {
    expect(rescueCjkEmphasis("**加粗，**尾")).toEqual([strong("加粗，"), text("尾")])
  })

  it("单星斜体 / 三星粗斜体同样补救", () => {
    expect(rescueCjkEmphasis("字*斜体，*尾")).toEqual([text("字"), emphasis("斜体，"), text("尾")])
    expect(rescueCjkEmphasis("***粗斜，***尾")).toEqual([
      { type: "emphasis", children: [strong("粗斜，")] },
      text("尾"),
    ])
  })

  it("前后都是全角标点的极短内容也补救（a**，**b）", () => {
    expect(rescueCjkEmphasis("a**，**b")).toEqual([text("a"), strong("，"), text("b")])
  })

  it("纯 ASCII 标点维持严格 CommonMark（**foo,**bar 不补救）→ null", () => {
    expect(rescueCjkEmphasis("see **foo,**bar and **baz,**qux")).toBeNull()
  })

  it("空格侧翼不补救 → null（与规范口径一致）", () => {
    expect(rescueCjkEmphasis("a ** b，** c")).toBeNull()
  })

  it("未配对的单个 run → null", () => {
    expect(rescueCjkEmphasis("2**10 即 1024")).toBeNull()
  })

  it("配对不可交叉：嵌套场景外层废弃、内层保留（跨节点限制的同源约束）", () => {
    // **a *b，* c**：内层 * 配对后 boundary 前移，外层 ** 开侧起点越界被废弃
    expect(rescueCjkEmphasis("**a *b，* c**尾")).toEqual([
      text("**a "),
      emphasis("b，"),
      text(" c**尾"),
    ])
  })

  it("多组顺序配对", () => {
    expect(rescueCjkEmphasis("**甲，**乙 **丙，**丁")).toEqual([
      strong("甲，"),
      text("乙 "),
      strong("丙，"),
      text("丁"),
    ])
  })
})

describe("cjkEmphasis（插件遍历）", () => {
  it("段落/blockquote/heading 内的 text 均替换；inlineCode 的值不触及", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            text("字**，加粗**尾 "),
            { type: "inlineCode", value: "**不补救，**" },
            text(" *斜，*尾"),
          ],
        },
        { type: "heading", depth: 2, children: [text("标题 **粗，**尾")] } as MdastNode,
      ],
    }
    cjkEmphasis()(tree)
    const para = tree.children![0].children!
    expect(para.slice(0, 3)).toEqual([text("字"), strong("，加粗"), text("尾 ")])
    expect(para[3]).toEqual({ type: "inlineCode", value: "**不补救，**" })
    expect(para.slice(4)).toEqual([text(" "), emphasis("斜，"), text("尾")])
    expect(tree.children![1].children).toEqual([text("标题 "), strong("粗，"), text("尾")])
  })

  it("无可补救的树保持引用与结构不变", () => {
    const tree: MdastNode = { type: "paragraph", children: [text("**foo,**bar")] }
    const before = tree.children
    cjkEmphasis()(tree)
    expect(tree.children).toBe(before)
  })
})
