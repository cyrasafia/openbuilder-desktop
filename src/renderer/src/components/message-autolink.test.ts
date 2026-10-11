/**
 * 文件路径自动链接（design-message-autolink）：识别/编码/解码/归属校验纯函数
 * + mdast 插件变换。用例集移植自 openbuilder message_autolink_test.dart 的
 * 「file paths / decodeFileHref / resolveProjectPath」三组（URI 组不移植——桌面
 * URI 归 remark-gfm autolink，本模块无 URI 分支），按桌面语义变体（归属校验
 * 解析期、resolveProjectPath 返回绝对路径）适配。
 */
import { describe, expect, it } from "vitest"
import {
  decodeFileHref,
  fileHref,
  isBareDomainPath,
  messageFileLinks,
  parseFilePath,
  resolveProjectPath,
  type MdastNode,
} from "./message-autolink"

const text = (value: string): MdastNode => ({ type: "text", value })
const para = (...children: MdastNode[]): MdastNode => ({ type: "paragraph", children })
const codeBlock = (value: string): MdastNode => ({ type: "code", value })
const inlineCode = (value: string): MdastNode => ({ type: "inlineCode", value })
const link = (url: string, value: string): MdastNode => ({
  type: "link",
  url,
  children: [text(value)],
})
const run = (src: string, directory: string): MdastNode => {
  const tree: MdastNode = { type: "root", children: [para(text(src))] }
  messageFileLinks({ directory })(tree)
  return tree
}
const runs = (children: MdastNode[], directory: string): MdastNode => {
  const tree: MdastNode = { type: "root", children: [para(...children)] }
  messageFileLinks({ directory })(tree)
  return tree
}
/** text 节点扫描结果：提取 link 节点（url, 文本）序列；无 link 返回 [] */
const linksOf = (tree: MdastNode): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  const walk = (node: MdastNode) => {
    if (node.type === "link") {
      out.push([node.url ?? "", (node.children?.[0] as { value?: string })?.value ?? ""])
      return
    }
    node.children?.forEach(walk)
  }
  tree.children?.forEach(walk)
  return out
}

describe("parseFilePath", () => {
  it("相对/点前缀/绝对路径 + 行号后缀", () => {
    expect(parseFilePath("lib/foo.dart")).toEqual({ path: "lib/foo.dart", line: null })
    expect(parseFilePath("./src/a.ts")).toEqual({ path: "./src/a.ts", line: null })
    expect(parseFilePath("../x/y.md")).toEqual({ path: "../x/y.md", line: null })
    expect(parseFilePath("/home/u/proj/lib/foo.dart")).toEqual({
      path: "/home/u/proj/lib/foo.dart",
      line: null,
    })
    expect(parseFilePath("lib/foo.dart:42")).toEqual({ path: "lib/foo.dart", line: 42 })
    expect(parseFilePath("lib/foo.dart:42:10")).toEqual({ path: "lib/foo.dart", line: 42 })
  })

  it("排除：单段/无扩展名/目录/点文件为末段/散文/glued/端口/盘符/空白", () => {
    expect(parseFilePath("main.dart")).toBeNull()
    expect(parseFilePath("src/Makefile")).toBeNull()
    expect(parseFilePath("docs/")).toBeNull()
    expect(parseFilePath("config/.gitignore")).toEqual({
      path: "config/.gitignore",
      line: null,
    })
    expect(parseFilePath("and/or")).toBeNull()
    expect(parseFilePath("etc/hosts")).toBeNull()
    expect(parseFilePath("lib/foo.dart:42abc")).toBeNull()
    expect(parseFilePath("my dir/foo.dart")).toBeNull()
    expect(parseFilePath("")).toBeNull()
  })

  it("整串校验锚定：host:port/盘符形整串拒绝（lookbehind 属扫描层，词首起匹配的整 token 合法——移动端同构）", () => {
    expect(parseFilePath("localhost:8080/a/b.dart")).toBeNull() // host:port（段字符集不含 :）
    expect(parseFilePath("C:/Users/x/y.dart")).toBeNull() // Windows 盘符
    expect(parseFilePath("xlib/foo.dart")).toEqual({ path: "xlib/foo.dart", line: null }) // 整 token
  })
})

describe("isBareDomainPath", () => {
  it("首段 TLD 结尾 = 裸域名；点开头目录/绝对路径不误伤", () => {
    expect(isBareDomainPath("github.com/org/repo/blob/main/foo.dart")).toBe(true)
    expect(isBareDomainPath("EXAMPLE.IO/x/y.ts")).toBe(true)
    expect(isBareDomainPath(".github/workflows/ci.yml")).toBe(false)
    expect(isBareDomainPath("/home/u/x/lib/foo.dart")).toBe(false)
    expect(isBareDomainPath("lib/foo.dart")).toBe(false)
  })
})

describe("fileHref / decodeFileHref", () => {
  it("相对路径 + 行号往返（格式层兼容移动端形态）", () => {
    expect(fileHref("lib/foo.dart", 42)).toBe("ob-file:///lib/foo.dart?line=42")
    expect(decodeFileHref("ob-file:///lib/foo.dart?line=42")).toEqual({
      path: "lib/foo.dart",
      line: 42,
    })
  })

  it("绝对路径无行号往返（四斜杠形态，MA-3）", () => {
    const href = fileHref("/home/u/p/lib/foo.dart", null)
    expect(href).toBe("ob-file:////home/u/p/lib/foo.dart")
    expect(decodeFileHref(href)).toEqual({ path: "/home/u/p/lib/foo.dart", line: null })
  })

  it("空格等 percent-encode 往返", () => {
    const href = fileHref("/home/u/my dir/a b.ts", 7)
    expect(href).toBe("ob-file:////home/u/my%20dir/a%20b.ts?line=7")
    expect(decodeFileHref(href)).toEqual({ path: "/home/u/my dir/a b.ts", line: 7 })
  })

  it("先拆 query 再 decode：路径中编码的 ? 存活（MC-1）", () => {
    const href = "ob-file:///weird%3Fline%3D9/foo.dart"
    expect(decodeFileHref(href)).toEqual({ path: "weird?line=9/foo.dart", line: null })
  })

  it("拒绝：非 ob-file 前缀 / 畸形 percent-encoding（ME-1）/ 空路径 / 非数字行号", () => {
    expect(decodeFileHref("https://example.com/a")).toBeNull()
    expect(decodeFileHref("ob-file:///100%/foo.dart")).toBeNull()
    expect(decodeFileHref("ob-file:///")).toBeNull()
    expect(decodeFileHref("ob-file:///lib/foo.dart?line=abc")).toEqual({
      path: "lib/foo.dart",
      line: null,
    })
  })
})

describe("resolveProjectPath（桌面变体：返回绝对路径）", () => {
  it("相对路径 resolve 为绝对", () => {
    expect(resolveProjectPath("lib/foo.dart", "/repo")).toBe("/repo/lib/foo.dart")
    expect(resolveProjectPath("./a/b.ts", "/repo")).toBe("/repo/a/b.ts")
  })

  it("点段规范化；项目内 .. 折叠正常通过", () => {
    expect(resolveProjectPath("lib/../docs/foo.md", "/repo")).toBe("/repo/docs/foo.md")
    expect(resolveProjectPath("./a/./b.ts", "/repo")).toBe("/repo/a/b.ts")
  })

  it("项目内绝对路径 strip 后重组为绝对", () => {
    expect(resolveProjectPath("/repo/lib/foo.dart", "/repo")).toBe("/repo/lib/foo.dart")
  })

  it("项目外绝对路径拒绝", () => {
    expect(resolveProjectPath("/etc/hosts", "/repo")).toBeNull()
    expect(resolveProjectPath("/other/x/y.dart", "/repo")).toBeNull()
  })

  it("相对路径逃逸项目根拒绝（MC-2）", () => {
    expect(resolveProjectPath("../../etc/nginx/nginx.conf", "/repo")).toBeNull()
    expect(resolveProjectPath("../sibling/a.dart", "/repo")).toBeNull()
  })

  it("绝对路径经 .. 逃逸拒绝；空 directory 拒绝", () => {
    expect(resolveProjectPath("/repo/a/../../escape.dart", "/repo")).toBeNull()
    expect(resolveProjectPath("lib/foo.dart", "")).toBeNull()
  })

  it("directory 尾随斜杠容忍", () => {
    expect(resolveProjectPath("lib/foo.dart", "/repo/")).toBe("/repo/lib/foo.dart")
    expect(resolveProjectPath("/repo/lib/foo.dart", "/repo/")).toBe("/repo/lib/foo.dart")
  })
})

describe("messageFileLinks 插件", () => {
  const DIR = "/home/u/proj"

  it("自由文本路径转链：href 为绝对路径 + 行号，链接文本保留完整匹配（含行号）", () => {
    const tree = run("see lib/foo.dart:42 now", DIR)
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/lib/foo.dart?line=42", "lib/foo.dart:42"]])
  })

  it("多路径与前后文本正确拆分", () => {
    const tree = run("a src/x.ts 和 docs/y.md b", DIR)
    expect(linksOf(tree)).toEqual([
      ["ob-file:////home/u/proj/src/x.ts", "src/x.ts"],
      ["ob-file:////home/u/proj/docs/y.md", "docs/y.md"],
    ])
    const p = tree.children![0] as { children: MdastNode[] }
    expect(p.children.map((c) => (c.type === "text" ? c.value : `<link>`))).toEqual([
      "a ",
      "<link>",
      " 和 ",
      "<link>",
      " b",
    ])
  })

  it("尾标点留在链外", () => {
    const tree = run("see lib/foo.dart, then", DIR)
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/lib/foo.dart", "lib/foo.dart"]])
  })

  it("围栏代码块（code 节点）不触及", () => {
    const tree: MdastNode = {
      type: "root",
      children: [codeBlock("lib/foo.dart\nmore lib/bar.dart"), para(text("after lib/baz.dart"))],
    }
    messageFileLinks({ directory: DIR })(tree)
    expect((tree.children![0] as { value: string }).value).toBe("lib/foo.dart\nmore lib/bar.dart")
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/lib/baz.dart", "lib/baz.dart"]])
  })

  it("行内代码内容仅为一个路径 → 整节点替换为 link（反引号去除）", () => {
    const tree = runs([inlineCode("lib/foo.dart:7")], DIR)
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/lib/foo.dart?line=7", "lib/foo.dart:7"]])
    expect((tree.children![0] as { children: MdastNode[] }).children[0].type).toBe("link")
  })

  it("行内代码含其他内容/含空格/裸域名 → 保持 code", () => {
    for (const v of ["open lib/foo.dart", "my dir/foo.dart", "github.com/a/b.dart", "main.dart"]) {
      const tree = runs([inlineCode(v)], DIR)
      expect(linksOf(tree)).toEqual([])
      expect((tree.children![0] as { children: MdastNode[] }).children[0].type).toBe("inlineCode")
    }
  })

  it("既有链接子树跳过（不二次处理；GFM autolink URI 无冲突的结构性来源）", () => {
    const tree = runs([link("https://example.com/a/b.dart", "https://example.com/a/b.dart"), text(" and lib/foo.dart")], DIR)
    expect(linksOf(tree)).toEqual([
      ["https://example.com/a/b.dart", "https://example.com/a/b.dart"],
      ["ob-file:////home/u/proj/lib/foo.dart", "lib/foo.dart"],
    ])
  })

  it("裸域名 URL 不转链", () => {
    const tree = run("see github.com/org/repo/blob/main/foo.dart", DIR)
    expect(linksOf(tree)).toEqual([])
  })

  it(".github 点开头目录不误伤（MA-2 反例）", () => {
    const tree = run("ci in .github/workflows/ci.yml", DIR)
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/.github/workflows/ci.yml", ".github/workflows/ci.yml"]])
  })

  it("项目外路径不转链（解析期归属校验，桌面语义变体）", () => {
    const tree = run("系统文件 /etc/nginx/nginx.conf 与逃逸 ../../etc/hosts", DIR)
    expect(linksOf(tree)).toEqual([])
  })

  it("host:port / Windows 盘符不误转（MD-1）；词首起匹配的整 token 转链（lookbehind 只防词中起匹配，移动端同构）", () => {
    const tree = run("listen localhost:8080/a/b.dart or C:/Users/x/y.dart", DIR)
    expect(linksOf(tree)).toEqual([])
    const tree2 = run("word xxlib/foo.dart here", DIR)
    expect(linksOf(tree2)).toEqual([["ob-file:////home/u/proj/xxlib/foo.dart", "xxlib/foo.dart"]])
  })

  it("标题与强调内的 text 节点同样转链", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        { type: "heading", children: [text("改动 lib/foo.dart 说明")] },
        { type: "strong", children: [text("关键 src/a.ts")] },
      ],
    }
    messageFileLinks({ directory: DIR })(tree)
    expect(linksOf(tree)).toEqual([
      ["ob-file:////home/u/proj/lib/foo.dart", "lib/foo.dart"],
      ["ob-file:////home/u/proj/src/a.ts", "src/a.ts"],
    ])
  })

  it("directory 空 = 不识别（防御路径）", () => {
    const tree = run("see lib/foo.dart", "")
    expect(linksOf(tree)).toEqual([])
  })

  it("无 / 文本零改动（快退）", () => {
    const src = "没有任何路径的普通句子"
    const tree = run(src, DIR)
    expect(linksOf(tree)).toEqual([])
    expect(((tree.children![0] as { children: MdastNode[] }).children[0] as { value: string }).value).toBe(src)
  })
})

describe("messageFileLinks 插件（评审修复补充）", () => {
  const DIR = "/home/u/proj"

  it("linkReference 引用文本不转链（防嵌套 a，评审 nit 6）", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "linkReference", identifier: "1", label: "1", children: [text("lib/foo.dart")] },
            text(" 与 lib/bar.ts"),
          ],
        },
        { type: "definition", identifier: "1", label: "1", url: "https://e.com/x" },
      ],
    } as MdastNode
    messageFileLinks({ directory: DIR })(tree)
    // 引用标签保持 linkReference（不产生嵌套 link）；相邻自由文本照常转链
    expect(linksOf(tree)).toEqual([["ob-file:////home/u/proj/lib/bar.ts", "lib/bar.ts"]])
    const p = tree.children![0] as { children: MdastNode[] }
    expect(p.children[0].type).toBe("linkReference")
  })
})
