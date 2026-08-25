/**
 * parseDiffHunks 测试（design-diff-view §4.1）：文件头丢弃、第一个 @@ 切界、
 * 内容行单字符前缀（+++i 合法）、多文件兜底、\No newline 丢弃、行号推进。
 */
import { describe, expect, it } from "vitest"
import { parseDiffHunks } from "./diff-parse"

describe("parseDiffHunks", () => {
  it("git --git 风格文件头全部丢弃；@@ 切界；行号推进正确", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 0000000..1111111",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed",
      " context2",
      "+added",
      " context3",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].additions).toBe(1)
    expect(hunks[0].deletions).toBe(1)
    const kinds = hunks[0].lines.map((l) => l.kind)
    expect(kinds).toEqual([" ", "-", " ", "+", " "])
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["context", "removed", "context2", "added", "context3"])
    // 行号：context old=1 new=1；removed old=2；context2 old=3 new=2；added new=3；context3 old=4 new=4
    const [c1, r, c2, a, c3] = hunks[0].lines
    expect([c1.oldNo, c1.newNo]).toEqual([1, 1])
    expect([r.oldNo, r.newNo]).toEqual([2, undefined])
    expect([c2.oldNo, c2.newNo]).toEqual([3, 2])
    expect([a.oldNo, a.newNo]).toEqual([undefined, 3])
    expect([c3.oldNo, c3.newNo]).toEqual([4, 4])
  })

  it("Index: 风格（session diff）文件头同样丢弃", () => {
    const patch = ["Index: pubspec.yaml", "=".repeat(67), "--- pubspec.yaml\t", "+++ pubspec.yaml\t", "@@ -1,2 +1,2 @@", " a", "-b", "+c"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a", "b", "c"])
  })

  it("内容行 +++i（added 文本本身是 +++i）不被当文件头丢弃", () => {
    const patch = ["@@ -1,1 +1,2 @@", " const x = 1", "-++i", "++++i"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks[0].lines.map((l) => l.kind)).toEqual([" ", "-", "+"])
    expect(hunks[0].lines[2].text).toBe("+++i")
  })

  it("多文件残留兜底：遇 diff /Index: 前缀即停", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      " a",
      "diff --git a/b b/b",
      "Index: b",
      "@@ -1,1 +1,1 @@",
      " b",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a"])
  })

  it("\\ No newline at end of file 丢弃", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+a"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(["-", "+"])
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a", "a"])
  })

  it("空 patch / 纯文件头（二进制）返回 []", () => {
    expect(parseDiffHunks("")).toEqual([])
    expect(parseDiffHunks("Binary files differ\n")).toEqual([])
    expect(parseDiffHunks("diff --git a/x b/x\nnew file mode\nBinary files differ")).toEqual([])
  })

  it("单行 hunk 省略 count（@@ -5 +5 @@）行号仍正确", () => {
    const patch = ["@@ -5 +5 @@", " x", "+y"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks[0].oldStart).toBe(5)
    expect(hunks[0].newStart).toBe(5)
    const [c, a] = hunks[0].lines
    expect([c.oldNo, c.newNo]).toEqual([5, 5])
    expect([a.oldNo, a.newNo]).toEqual([undefined, 6])
  })
})