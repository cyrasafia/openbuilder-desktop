/** front matter 拆分（design-markdown-preview §2.5）——用例移植自移动端
 * openbuilder test/markdown_front_matter_test.dart（语义同源，不重新发明） */
import { describe, expect, it } from "vitest"
import { splitFrontMatter } from "./markdown-frontmatter"

describe("splitFrontMatter", () => {
  it("基础 front matter：条目提取 + 正文剥离", () => {
    const content = "---\ntitle: Hello World\nauthor: cyra\n---\n\n# Body\ntext"
    const split = splitFrontMatter(content)
    expect(split).not.toBeNull()
    expect(split!.frontMatter!.length).toBe(2)
    expect(split!.frontMatter![0]).toEqual({ key: "title", value: "Hello World" })
    expect(split!.frontMatter![1]).toEqual({ key: "author", value: "cyra" })
    expect(split!.body.startsWith("# Body")).toBe(true)
  })

  it("闭合围栏后的一个空行被剥离", () => {
    const split = splitFrontMatter("---\ntitle: A\n---\n\nfirst")
    expect(split!.frontMatter![0].value).toBe("A")
    expect(split!.body).toBe("first")
  })

  it("闭合围栏后无空行：正文原样衔接", () => {
    expect(splitFrontMatter("---\ntitle: A\n---\nfirst")!.body).toBe("first")
  })

  it("非 --- 开头：原样返回", () => {
    expect(splitFrontMatter("# Hi")).toBeNull()
  })

  it("首行前导空白（不在首字节）：不判定", () => {
    const content = " ---\ntitle: A\n---\nbody"
    expect(splitFrontMatter(content)).toBeNull()
  })

  it("无闭合围栏：原样返回", () => {
    expect(splitFrontMatter("---\ntitle: A\nbody")).toBeNull()
  })

  it("围栏内无 key:value 映射：原样返回", () => {
    expect(splitFrontMatter("---\nnot a mapping\n---\nbody")).toBeNull()
  })

  it("顶层无冒号行跳过（不中断提取）", () => {
    const split = splitFrontMatter("---\ntitle: A\nbadline\n---\nbody")
    expect(split!.frontMatter!.length).toBe(1)
    expect(split!.frontMatter![0].value).toBe("A")
    expect(split!.body).toBe("body")
  })

  it("字面量块标量（|）保留换行", () => {
    const split = splitFrontMatter("---\ntitle: A\ndescription: |\n  first line\n  second line\n---\nbody")
    expect(split!.frontMatter![1]).toEqual({ key: "description", value: "first line\nsecond line" })
  })

  it("折叠块标量（>）以空格连接", () => {
    const split = splitFrontMatter("---\nsummary: >\n  one\n  two\n---\nbody")
    expect(split!.frontMatter![0].value).toBe("one two")
  })

  it("嵌套容器成员不入卡；容器父键（空值 + 缩进下探）同样跳过", () => {
    const split = splitFrontMatter(
      "---\nversion: 2\nname: doc\ndescription: |\n  multi\n  line\ncolors:\n  seed-dark: \"#4ADE80\"\n  seed-light: \"#16A34A\"\n---\n\n## Heading",
    )
    expect(split!.frontMatter!.map((e) => e.key)).toEqual(["version", "name", "description"])
    expect(split!.frontMatter![0].value).toBe("2")
    expect(split!.frontMatter![2].value).toBe("multi\nline")
    expect(split!.body.startsWith("## Heading")).toBe(true)
  })

  it("纯嵌套容器：无卡但正文仍剥离", () => {
    const split = splitFrontMatter("---\ncolors:\n  red: \"#f00\"\n  blue: \"#00f\"\n---\n# Body")
    expect(split!.frontMatter).toBeNull()
    expect(split!.body).toBe("# Body")
  })

  it("分隔线夹心（无映射）：不是 front matter，原样返回", () => {
    const content = "---\n\ntext above\n\n---\ntext below"
    expect(splitFrontMatter(content)).toBeNull()
  })

  it("引号值解包", () => {
    const split = splitFrontMatter('---\ntitle: "Hello: World"\nnote: \'quoted\'\n---\nbody')
    expect(split!.frontMatter![0].value).toBe("Hello: World")
    expect(split!.frontMatter![1].value).toBe("quoted")
  })

  it("空标量值以 em dash 占位", () => {
    const split = splitFrontMatter("---\ndraft:\n---\nbody")
    expect(split!.frontMatter![0].value).toBe("—")
  })

  it("围栏后即结束：正文为空串", () => {
    expect(splitFrontMatter("---\ntitle: A\n---\n")!.body).toBe("")
  })

  it("无尾随换行的闭合围栏：条目正常 + 正文为空串", () => {
    const split = splitFrontMatter("---\ntitle: A\n---")
    expect(split!.frontMatter!.length).toBe(1)
    expect(split!.body).toBe("")
  })
})
