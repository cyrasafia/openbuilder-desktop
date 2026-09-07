/**
 * markdown 相对路径图片解析测试（design-markdown-preview §2.8）：
 * 基准目录 join/normalize、%XX 解包、query/hash 剥离、外链透传、扩展名闸门
 * + remark 预重写插件与 img 覆写侧消费。
 */
import { describe, expect, it } from "vitest"
import {
  isImagePath,
  markdownRewrittenImagePath,
  relativeImageRewrite,
  resolveMarkdownImage,
} from "./markdown-image"

describe("resolveMarkdownImage（design-markdown-preview §2.8）", () => {
  it("相对路径：基准目录 join + normalize（./ 与 .. 折叠）", () => {
    expect(resolveMarkdownImage("/repo/docs", "./img/a.png")).toBe("/repo/docs/img/a.png")
    expect(resolveMarkdownImage("/repo/docs", "img/b.png")).toBe("/repo/docs/img/b.png")
    expect(resolveMarkdownImage("/repo/docs", "../assets/c.svg")).toBe("/repo/assets/c.svg")
    expect(resolveMarkdownImage("/repo/docs", "x/../../d.png")).toBe("/repo/d.png")
    expect(resolveMarkdownImage("/repo/docs", "a/../..//e.png")).toBe("/repo/e.png")
  })

  it("根目录基准与 .. 溢出（溢出段丢弃不越界）", () => {
    expect(resolveMarkdownImage("/", "img/a.png")).toBe("/img/a.png")
    expect(resolveMarkdownImage("/repo", "../../a.png")).toBe("/a.png")
  })

  it("%XX 解包：空格等编码字符还原为真实路径", () => {
    expect(resolveMarkdownImage("/repo", "img/my%20pic.png")).toBe("/repo/img/my pic.png")
    expect(resolveMarkdownImage("/repo", "%E4%B8%AD%E6%96%87.png")).toBe("/repo/中文.png")
  })

  it("坏 % 序列保留原样（不整体失败）", () => {
    expect(resolveMarkdownImage("/repo", "a%zz.png")).toBe("/repo/a%zz.png")
    expect(resolveMarkdownImage("/repo", "100%.png")).toBe("/repo/100%.png")
  })

  it("query / hash 剥离", () => {
    expect(resolveMarkdownImage("/repo", "a.png?v=1")).toBe("/repo/a.png")
    expect(resolveMarkdownImage("/repo", "a.png#frag")).toBe("/repo/a.png")
    expect(resolveMarkdownImage("/repo", "a.png?x#y")).toBe("/repo/a.png")
  })

  it("绝对路径 src 视作文件系统路径", () => {
    expect(resolveMarkdownImage("/repo/docs", "/abs/img/a.png")).toBe("/abs/img/a.png")
    expect(resolveMarkdownImage("/repo/docs", "/abs/../b.png")).toBe("/b.png")
  })

  it("外链 / 协议相对 / data / file / 空 src：null 透传（不拦截）", () => {
    expect(resolveMarkdownImage("/repo", "https://e.com/a.png")).toBeNull()
    expect(resolveMarkdownImage("/repo", "http://e.com/a.png")).toBeNull()
    expect(resolveMarkdownImage("/repo", "//cdn.e.com/a.png")).toBeNull()
    expect(resolveMarkdownImage("/repo", "data:image/png;base64,AA==")).toBeNull()
    expect(resolveMarkdownImage("/repo", "file:///home/u/a.png")).toBeNull()
    expect(resolveMarkdownImage("/repo", "")).toBeNull()
    expect(resolveMarkdownImage("/repo", "#frag")).toBeNull()
    expect(resolveMarkdownImage("/repo", "?q=1")).toBeNull()
  })

  it("扩展名闸门：非图片扩展不解析（不嗅探内容）", () => {
    expect(resolveMarkdownImage("/repo", "doc.pdf")).toBeNull()
    expect(resolveMarkdownImage("/repo", "index.md")).toBeNull()
    expect(resolveMarkdownImage("/repo", "archive.tar.gz")).toBeNull()
  })

  it("svg / 大小写扩展名命中", () => {
    expect(resolveMarkdownImage("/repo", "diagram.svg")).toBe("/repo/diagram.svg")
    expect(resolveMarkdownImage("/repo", "photo.JPG")).toBe("/repo/photo.JPG")
    expect(resolveMarkdownImage("/repo", "icon.WebP")).toBe("/repo/icon.WebP")
  })
})

describe("isImagePath（迁入回归，design-image-preview §2.2）", () => {
  it("位图/位图大写/svg 命中；点文件/无扩展/非图不命中", () => {
    expect(isImagePath("/a/b.png")).toBe(true)
    expect(isImagePath("/a/b.PNG")).toBe(true)
    expect(isImagePath("/a/b.svg")).toBe(true)
    expect(isImagePath("/a/.png")).toBe(false)
    expect(isImagePath("/a/png")).toBe(false)
    expect(isImagePath("/a/b.txt")).toBe(false)
  })
})

describe("relativeImageRewrite（remark 预重写）", () => {
  /** 跑最小 mdast 树：walk 全树改写 image 节点 url（元组形态 `[plugin, opts]`，
   *  unified 挂载时 opts 作为 plugin 首参传入） */
  function run(tree: unknown, baseDir: string) {
    relativeImageRewrite({ baseDir })(tree as never)
    return tree
  }

  it("相对 image url 改写为绝对路径（./、裸、../ 形态全覆盖）", () => {
    const tree = run(
      {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "image", url: "./img/a.png" }] },
          { type: "paragraph", children: [{ type: "image", url: "b.jpg" }] },
          { type: "paragraph", children: [{ type: "image", url: "../up/c.svg" }] },
        ],
      },
      "/repo/docs",
    )
    const urls = (tree as { children: { children: { url: string }[] }[] }).children.map(
      (p) => p.children[0].url,
    )
    expect(urls).toEqual(["/repo/docs/img/a.png", "/repo/docs/b.jpg", "/repo/up/c.svg"])
  })

  it("外链 / 非图扩展 / data：不改写（维持原行为）", () => {
    const tree = run(
      {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "image", url: "https://e.com/a.png" }] },
          { type: "paragraph", children: [{ type: "image", url: "./doc.pdf" }] },
          { type: "paragraph", children: [{ type: "image", url: "data:image/png;base64,AA==" }] },
        ],
      },
      "/repo",
    )
    const urls = (tree as { children: { children: { url: string }[] }[] }).children.map(
      (p) => p.children[0].url,
    )
    expect(urls).toEqual(["https://e.com/a.png", "./doc.pdf", "data:image/png;base64,AA=="])
  })

  it("reference 语法：definition 节点 url 同样改写（非图 definition 不动，链接行为不变）", () => {
    const tree = run(
      {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "imageReference", identifier: "ref" }] },
          { type: "definition", identifier: "ref", url: "./img/a.png" },
          { type: "definition", identifier: "doc", url: "./notes.txt" },
        ],
      },
      "/repo/docs",
    )
    const defs = (tree as { children: { type: string; url?: string }[] }).children.filter(
      (c) => c.type === "definition",
    )
    expect(defs[0].url).toBe("/repo/docs/img/a.png")
    expect(defs[1].url).toBe("./notes.txt")
  })
})

describe("markdownRewrittenImagePath（img 覆写侧消费）", () => {
  it("`/` 绝对路径 + 图片扩展 → 解码还原真实路径（%20 空格）", () => {
    expect(markdownRewrittenImagePath("/repo/img/a.png")).toBe("/repo/img/a.png")
    expect(markdownRewrittenImagePath("/repo/img/my%20pic.png")).toBe("/repo/img/my pic.png")
    expect(markdownRewrittenImagePath("/repo/a.png?x#y")).toBe("/repo/a.png")
  })

  it("相对字面 / 外链 / data / 非图扩展 / 根目录裸文件 → null 透传", () => {
    expect(markdownRewrittenImagePath("img/a.png")).toBeNull()
    expect(markdownRewrittenImagePath("./a.png")).toBeNull()
    expect(markdownRewrittenImagePath("https://e.com/a.png")).toBeNull()
    expect(markdownRewrittenImagePath("data:image/png;base64,AA==")).toBeNull()
    expect(markdownRewrittenImagePath("/repo/doc.pdf")).toBeNull()
    expect(markdownRewrittenImagePath("/logo.png")).toBe("/logo.png") // 根目录文件：仍消费（站点根语义在本地预览无对应物）
  })
})
