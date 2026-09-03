/**
 * unified diff 解析（design-diff-view §4.1）——移植 openbuilder design-diff-view
 * 的 parseDiffHunks 规则：
 * - 以第一个 `@@` 为文件头/内容分界（diff --git / Index: / --- / +++ 全部丢弃，
 *   根治 `+++ b/f` 误判为增行）；
 * - hunk 内只做单字符 +/-/空格 判定（added `++i` 的 raw `+++i` 是合法内容行，
 *   绝不再判 +++/---）；
 * - 多文件兜底：内容行产不出 `diff `/`Index: ` 前缀，遇之即停；
 * - `\ No newline at end of file` 丢弃（机读噪声）；
 * - 解析后按 HUNK_CONTEXT_KEEP 收窄展示 context（见 narrowHunk）。
 * 兼容两种文件头：git --git 风格与 Index: 风格（session diff）。
 */

export interface DiffLine {
  kind: "+" | "-" | " "
  /** 剥离前缀后的行内容 */
  text: string
  /** removed/context 行的旧行号 */
  oldNo?: number
  /** added/context 行的新行号 */
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
  additions: number
  deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * 展示 context 收窄保留行数（对齐 VCS_DIFF_CONTEXT / git --unified=3）。
 * `/session/:id/diff` 的 patch 由 server 端 Snapshot.diffFull 以
 * context=Number.MAX_SAFE_INTEGER 预计算（恒整文件单 hunk），客户端在解析层
 * 统一收窄；/vcs/diff 的 patch 已是 -U3 形态，收窄是 no-op——幂等性前提
 * keep >= VCS_DIFF_CONTEXT（diff-parse.test.ts 有不变量测试钉住）。
 */
export const HUNK_CONTEXT_KEEP = 3

/**
 * 单 hunk 按 keep 行 context 收窄（等价 git -Ukeep 的分节规则）：
 * 变更行（+/- 连续块）及其前后各 keep 行 context 保留，其余 context 丢弃；
 * 保留区之间出现未覆盖 context 即拆分为多个 hunk（两处改动间 context 超过
 * 2*keep 行则分节）。拆分后段头行号取行前推进计数（与解析循环同规则推进）：
 * added 段首的 oldStart / removed 段首的 newStart 取虚拟推进值（= 该侧下一行号）。
 * 无变更行（纯 context hunk）返回 []（不构成展示，真实 diff 不产出此形态）。
 */
function narrowHunk(hunk: DiffHunk, keep: number): DiffHunk[] {
  const lines = hunk.lines
  const keepFlags = new Array<boolean>(lines.length).fill(false)
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind === " ") {
      i++
      continue
    }
    // 连续变更块 [i, j)：前后各扩 keep 行（钳制在 hunk 内）
    let j = i
    while (j < lines.length && lines[j].kind !== " ") j++
    for (let k = Math.max(0, i - keep); k < Math.min(lines.length, j + keep); k++) keepFlags[k] = true
    i = j
  }
  // 行前推进计数：oldAt[k]/newAt[k] = 消费第 k 行前的 old/new 侧行号
  const oldAt = new Array<number>(lines.length)
  const newAt = new Array<number>(lines.length)
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  for (let k = 0; k < lines.length; k++) {
    oldAt[k] = oldNo
    newAt[k] = newNo
    if (lines[k].kind === "-") oldNo++
    else if (lines[k].kind === "+") newNo++
    else {
      oldNo++
      newNo++
    }
  }
  // 连续保留段切为 hunk
  const out: DiffHunk[] = []
  let s = 0
  while (s < lines.length) {
    if (!keepFlags[s]) {
      s++
      continue
    }
    let e = s
    while (e < lines.length && keepFlags[e]) e++
    const seg = lines.slice(s, e)
    let additions = 0
    let deletions = 0
    for (const line of seg) {
      if (line.kind === "+") additions++
      else if (line.kind === "-") deletions++
    }
    out.push({ oldStart: oldAt[s], newStart: newAt[s], lines: seg, additions, deletions })
    s = e
  }
  return out
}

/** 解析单文件 patch 为 hunk 列表并按 HUNK_CONTEXT_KEEP 收窄；无文本差异（二进制/空）返回 [] */
export function parseDiffHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      cur = {
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        lines: [],
        additions: 0,
        deletions: 0,
      }
      hunks.push(cur)
      // 行号计数从 header 声明值起步（无 count 视为 1——git 对单行省略 count）
      oldNo = cur.oldStart
      newNo = cur.newStart
      continue
    }
    if (!cur) {
      // 第一个 @@ 之前全是文件头，丢弃
      continue
    }
    if (raw.startsWith("+")) {
      cur.lines.push({ kind: "+", text: raw.slice(1), newNo })
      cur.additions++
      newNo++
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "-", text: raw.slice(1), oldNo })
      cur.deletions++
      oldNo++
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ kind: " ", text: raw.slice(1), oldNo, newNo })
      oldNo++
      newNo++
    } else if (raw === "") {
      // patch 末尾换行产物，跳过
      continue
    } else if (raw.startsWith("diff ") || raw.startsWith("Index: ")) {
      // 多文件残留兜底：内容行必以 +/-/空格开头，此前缀只属于下一个文件头
      break
    } else if (raw.startsWith("\\")) {
      // \ No newline at end of file：机读噪声，丢弃（移动端同决策）
      continue
    } else {
      // 未知形态（如 Index: 风格的 ==== 分隔线落入 hunk 外已丢；此处防御）
      continue
    }
  }
  return hunks.flatMap((hunk) => narrowHunk(hunk, HUNK_CONTEXT_KEEP))
}
