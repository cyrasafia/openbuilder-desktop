/**
 * parseDiffHunks 测试（design-diff-view §4.1）：文件头丢弃、第一个 @@ 切界、
 * 内容行单字符前缀（+++i 合法）、多文件兜底、\No newline 丢弃、行号推进、
 * context 收窄（session diff 整文件 patch → 按 -U3 分节）。
 */
import { describe, expect, it } from "vitest"
import { HUNK_CONTEXT_KEEP, parseDiffHunks } from "./diff-parse"
import { VCS_DIFF_CONTEXT } from "./rest-client"

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
      "@@ -1,1 +1,2 @@",
      " a",
      "+a2",
      "diff --git a/b b/b",
      "Index: b",
      "@@ -1,1 +1,1 @@",
      " b",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a", "a2"])
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
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(5)
    expect(hunks[0].newStart).toBe(5)
    const [c, a] = hunks[0].lines
    expect([c.oldNo, c.newNo]).toEqual([5, 5])
    expect([a.oldNo, a.newNo]).toEqual([undefined, 6])
  })
})

describe("context 收窄（session diff 整文件 patch，design-diff-view §4.1 修订）", () => {
  it("两处改动间长 context：拆分为两 hunk，变更前后各留 3 行；段头行号正确", () => {
    const patch = [
      "@@ -1,12 +1,14 @@",
      " c1",
      "-a",
      "+b",
      " c2",
      " c3",
      " c4",
      " c5",
      " c6",
      " c7",
      " c8",
      " c9",
      " c10",
      "+i",
      " c11",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(2)
    // 段 1：c1 + 变更 + 后 3 行 context（c2–c4）；c5 起未覆盖
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["c1", "a", "b", "c2", "c3", "c4"])
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].additions).toBe(1)
    expect(hunks[0].deletions).toBe(1)
    // 段 2：前 3 行 context（c8–c10）+ 变更 + c11；段头 = 行前推进计数
    expect(hunks[1].lines.map((l) => l.text)).toEqual(["c8", "c9", "c10", "i", "c11"])
    expect(hunks[1].oldStart).toBe(9)
    expect(hunks[1].newStart).toBe(9)
    expect(hunks[1].additions).toBe(1)
    expect(hunks[1].deletions).toBe(0)
    // 行号随段保留推进语义：段 2 末行 old=12 new=13
    const last = hunks[1].lines[hunks[1].lines.length - 1]
    expect([last.oldNo, last.newNo]).toEqual([12, 13])
  })

  it("hunk 头尾 context 超过 3 行被裁剪", () => {
    const patch = [
      "@@ -1,12 +1,12 @@",
      " p1",
      " p2",
      " p3",
      " p4",
      " p5",
      "-a",
      "+b",
      " q1",
      " q2",
      " q3",
      " q4",
      " q5",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["p3", "p4", "p5", "a", "b", "q1", "q2", "q3"])
    expect(hunks[0].oldStart).toBe(3)
    expect(hunks[0].newStart).toBe(3)
  })

  it("已收窄 patch（-U3 形态，/vcs/diff 路径）原样通过（幂等）", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " const x = 1",
      "-const y = 2",
      "+const y = 3",
      "+const z = 4",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines).toHaveLength(4)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(1)
  })

  it("两处改动间 context 恰为 6 行（2*keep）不拆分（git -U3 同规则）", () => {
    const patch = [
      "@@ -1,12 +1,12 @@",
      " m1",
      "-m2",
      "+m2x",
      " g1",
      " g2",
      " g3",
      " g4",
      " g5",
      " g6",
      "-m8",
      "+m8x",
      " m9",
    ].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines).toHaveLength(12)
  })

  it("段首为 added 行：oldStart 取虚拟推进值（= 其后首个旧行号）", () => {
    // 变更块首行为 +（前面无 context 可留）：段头 oldStart = old 侧下一行号
    const patch = ["@@ -5,2 +5,3 @@", "+new", " c6", " c7"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].newStart).toBe(5)
    expect(hunks[0].oldStart).toBe(5)
    expect(hunks[0].lines[0].newNo).toBe(5)
    expect(hunks[0].lines[1].oldNo).toBe(5)
  })

  it("纯 context hunk（无变更行）丢弃", () => {
    const patch = ["@@ -1,3 +1,3 @@", " a", " b", " c"].join("\n")
    expect(parseDiffHunks(patch)).toEqual([])
  })

  it("added 文件（全 + 行）不受收窄影响", () => {
    const patch = ["@@ -0,0 +1,3 @@", "+a", "+b", "+c"].join("\n")
    const hunks = parseDiffHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(0)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(["+", "+", "+"])
  })

  it("不变量：HUNK_CONTEXT_KEEP >= VCS_DIFF_CONTEXT（/vcs/diff 的 -U patch 幂等通过收窄的前提）", () => {
    // keep 低于线上 context 时，server 按 -U{n>keep} 产出的 patch 会被再裁剪，
    // 展示 context 少于请求语义——两常量须同向维护（review 意见，防漂移）
    expect(HUNK_CONTEXT_KEEP).toBeGreaterThanOrEqual(VCS_DIFF_CONTEXT)
  })
})