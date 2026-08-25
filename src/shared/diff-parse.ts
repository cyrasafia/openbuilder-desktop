/**
 * unified diff 解析（design-diff-view §4.1）——移植 openbuilder design-diff-view
 * 的 parseDiffHunks 规则：
 * - 以第一个 `@@` 为文件头/内容分界（diff --git / Index: / --- / +++ 全部丢弃，
 *   根治 `+++ b/f` 误判为增行）；
 * - hunk 内只做单字符 +/-/空格 判定（added `++i` 的 raw `+++i` 是合法内容行，
 *   绝不再判 +++/---）；
 * - 多文件兜底：内容行产不出 `diff `/`Index: ` 前缀，遇之即停；
 * - `\ No newline at end of file` 丢弃（机读噪声）。
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

/** 解析单文件 patch 为 hunk 列表；无文本差异（二进制/空）返回 [] */
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
  return hunks
}
