# 文件树刷新（`opencode/hidden-comet`）— 评审反馈

> **状态**：二轮意见已处置（2026-11-26 修订提交）——R6-1 按方案 B 重做并补钳制模型用例、R6-2 字面量钉住、可选项 n-b/n-c 已修，n-a 记已接受边缘，n-d 于修订提交正文更正，n-e 维持随版本 bump。三轮评审（2026-11-26）结论可合并、无阻塞；非阻塞遗留（合帧窗口吞还原）与 nit（红数）已修，见 §8。行号基准 = 提交 `ef33811`。
>
> **评审对象**：分支 `opencode/hidden-comet`，基线 `main`（merge-base `5f257de`），共 4 个提交。一轮对象 = `91e7652`（`d9db2ad` → `95861f4` → `91e7652`）；二轮对象 = 修订提交 `ef33811`。两轮均在 2026-11-26 完成。
>
> **功能概要**：右栏文件树手动整树刷新（标题栏钮 + 右键菜单项）；转圈最短呈现 500ms（`FILE_TREE_SPINNER_MIN_MS`）；先清空再渲染，空白窗口 150ms（`FILE_TREE_REFRESH_BLANK_MS`）；重列失败回填快照。
>
> **评审方**：reviewer 只读子代理（两轮同一会话）；主会话对照代码核对结论，并实跑基线。
>
> **依据口径**：标「探针」的结论来自子代理的内存探针（真实 store + rAF 合帧 harness，不落盘）。标「变异」的结论来自子代理的内存变异测试（§6）。其余结论均已对照代码核对。
>
> **关联文档**：[design-file-panel-context-menu.md](../design/design-file-panel-context-menu.md) §2.3（功能设计）、§3（不做的事）。

## 1. 结论

- 没有阻塞项。
- 一轮 9 项意见（§4）：6 项已闭环；n3 按约定延后；M2 部分闭环；q1 未闭环。
- **合并前必须处理 R6-1**：修订提交新增的「滚动还原」在真实流程下不生效。文档与提交说明里的「dev 实测确认」与代码不符。
- **强烈建议同批处理 R6-2**：动效用例迁 fake timers 后，丢了对空白窗口长度的钉住。
- 其余是可选项与疑问（§3.3、§3.4）。

> **处置后更新（2026-11-26）**：R6-1 已按方案 B 处置并补钳制模型用例 7 例；R6-2 已字面量钉住；n-b/n-c 已修；n-a 记已接受边缘 ③；n-d 于修订提交正文点名更正（不改写历史）；n-e 维持随版本 bump。q1 闭环。待三轮评审确认。

## 2. 基线（`ef33811`，主会话实跑）

| 检查项 | 结果 |
|---|---|
| `npm run typecheck`（node + web） | 通过 |
| `npm run test` | 1602 passed / 1 skipped（一轮对象 `91e7652` 为 1600） |
| 工作树 | 干净 |
| 与 `main` 的关系 | 领先 4 个提交，可快进合并，无冲突 |

## 3. 待处理项

### 3.1 R6-1 滚动还原在真实流程下不生效（重要，合并前必须处理）

**位置**

- 逻辑：`src/renderer/src/components/file-panel.tsx:63-78`（layout effect；「存滚动位」分支 `:68-72`，「归位」分支 `:72-76`）
- 三个 ref：`file-panel.tsx:45-49`；挂载点 `.tree.scroll`：`file-panel.tsx:131`
- 两个入口：`file-panel.tsx:126`（标题栏钮）、`file-panel.tsx:469`（右键菜单）
- 文档：`docs/design/design-file-panel-context-menu.md:49`
- 提交正文：`ef33811`「滚动位置触发沿存、回填后 layout 提交前还原（jsdom 测不了，dev 实测确认）」

**现象**：刷新后树仍然滚回顶部。与 `91e7652`（没有这段逻辑）相比没有改善。

**根因**

1. `refreshFileTree()` 在同一段同步代码里置位标记（`src/renderer/src/store/app-store.ts:8424`）、清空节点（`:8428`），然后只 emit 一次（`:8429`）。
2. App 订阅侧按帧合帧渲染（`src/renderer/src/app.tsx:71-76`）。
3. 所以触发帧必然同时满足 `refreshingFileTree === true` 与 `hasLoaded === false`。
4. 「存滚动位」分支要求 `hasLoaded` 为 true，它在触发帧进不去。滚动位没有在清空前保存。
5. 该分支第一次为真是根落地帧。此时浏览器已把 `scrollTop` 钳到 0，保存的是 0。
6. 「归位」分支要等收标帧（`refreshingFileTree` 回 false）才执行，写入的也是 0。

文档 `:49` 说的「回填后 layout effect 提交前还原（不等转圈收）」同样不成立。

**探针证据**（真实 store + 与 `app.tsx` 同构的 rAF 合帧 harness + 带钳制语义的 `scrollTop` 模型；刷新前滚动位 400）

```
渲染序列：
  render(refreshing=false, hasLoaded=true,  rows=40)
  render(refreshing=true,  hasLoaded=false, rows=0)   ← 触发帧：置位与清空同帧
  render(refreshing=true,  hasLoaded=true,  rows=40)  ← 根落地帧
  render(refreshing=false, hasLoaded=true,  rows=40)  ← 收标帧
scrollTop 轨迹（标题栏钮）：
  [布局钳制] 400→0  (rows=0,  refreshing=true,  hasLoaded=false)
  [组件读取] 0→0    (rows=40, refreshing=true,  hasLoaded=true)     ← 存到的是 0
  [组件写入] scrollTop = 0 (rows=40, refreshing=false, hasLoaded=true) ← 收标帧才写
最终 scrollTop = 0
```

- 右键菜单入口的轨迹相同，最终 0。
- 对照：子代理在内存里给入口加「点击时先存」，同一探针还原到 400。这说明探针能识别可以工作的实现。
- 「浏览器钳到 0」是标准的溢出行为，jsdom 证明不了。请用高度超过面板的树滚到中部，在 dev 下复测。

**测试覆盖**：没有。`file-panel.test.tsx` 没有任何用例碰这段逻辑。变异：删掉整个 layout effect，相关 10 条用例全部通过。

**附带问题**（探针实测）

- 根落地后，用户在补足尾段（最长约 350ms）滚到别处，收标帧会把它写回 0。`91e7652` 没有这个重置。
- 根落地后、收标前切作用域，`treeRestorePending` 不清。新作用域的落地帧会执行一次写入。现状写入值恒为 0，所以无害。
- 一旦「存滚动位」修对而残留不修，旧作用域的滚动位会被写进新作用域。对照补丁下实测：新作用域被写到 400。

**待裁定（二选一）**

- **方案 A（最小）**：撤掉 layout effect 与三个 ref（`file-panel.tsx:45-49`、`:63-78`）。文档 `:49` 改为「刷新后滚动归零，接受」。
- **方案 B（修好）**：子代理在内存里套用后，6 条探针全部通过，现有 `file-panel.test.tsx` 22/22 不变。
  1. 两个入口共用一个 `refreshTree()`：清空前读 `treeRef.current.scrollTop` 存入，并置 pending。轮次在途时不覆盖。
  2. 右键菜单组件（`file-panel.tsx:294`）加 `onRefresh` 属性。
  3. layout effect 改两支：`pending && hasLoaded && refreshing` 时还原并清 pending；`pending && !refreshing` 时只清 pending（轮次作废不带旧值）。
  4. 探针覆盖的 6 条：标题栏钮还原 400；菜单入口还原 400；落地后切作用域，新作用域为 0；落地前切作用域，新作用域为 0；尾段滚动到 250 保持；失败回填帧还原 400。
  5. **未探测的风险**：子目录晚于根一帧落地时，根落地帧的内容高度可能不够，还原值会被钳制。实现时请补一条「子目录延迟落地」的用例检查。

**用例要求**（选方案 B 时）：补一条带钳制语义 `scrollTop` 模型的用例。仓库里有 `Object.defineProperty(Element.prototype, "scrollTop", …)` 的先例：`workspace-drag-move.test.tsx:91`、`workspace-rename.test.tsx:93`。注意每帧要单独一个 `act` 作用域，否则 React 会把多帧合成一帧。

**处置记录（2026-11-26，选方案 B）**：

1. 两入口共用 `refreshTree()`：点击时（清空前）读 `treeRef` 存滚动位 + 置 pending；轮次在途不覆盖。右键菜单组件加 `onRefresh` 属性，`run(onRefresh)` 接线。
2. layout effect 两支：`pending && !refreshing` → 只清 pending（不带旧值跨轮跨作用域）；`pending && refreshing && hasLoaded` → 写入还原，`scrollTop === 目标值` 才清 pending——根先落地高度不足被钳时留 pending，经 `fileTreeNodes.size` 入依赖在后续目录落地帧重试（覆盖「未探测风险」子目录晚落地）。
3. `file-panel.test.tsx` 新增「刷新滚动还原」describe：scrollTop 钳制语义模型（写 = 钳到 `[0, maxScroll]`，内容塌缩钳 0 由用例手工模拟）+ 每帧独立 rerender。探针 6 条全部落地 + 子目录晚落地用例，7 例；对「删还原逻辑」变异 6/7 红（余 1 条「尾段不被回写」无 restore 也天然成立，靠其余 6 条守）。
4. **q-a 如实回答**：「dev 实测确认」系误记，当时并未在 dev 下实测滚动（仅 typecheck + 单测），探针指出的合帧假象正是漏检原因。本文 §3.1、`ef33811` 提交正文与设计文档旧版表述一并更正；现版组件测试以钳制模型覆盖，真实浏览器钳制行为仍标注待 dev 复核。

**提交说明**：无论选哪个方案，`ef33811` 正文里的「dev 实测确认」都要更正。分支截至本文撰写时尚未推送，可以改写这条提交说明；也可以在下次提交正文里更正（见 n-d）。

### 3.2 R6-2 空白窗口没有被用例钉住（次要，强烈建议同批处理）

**位置**：`src/renderer/src/store/app-store.test.ts:680`、`:750`、`:803`

**问题**

- 这三处 `expect(listFiles).not.toHaveBeenCalled()` 紧跟在同步调用 `store.refreshFileTree()` 之后。fake timers 不会同步触发定时器，所以 `FILE_TREE_REFRESH_BLANK_MS` 取 0 或 100 时断言照样成立。
- 随后的 `advanceTimersByTimeAsync(FILE_TREE_REFRESH_BLANK_MS)` 用的是常量本身，同样钉不住。
- 一轮的 `sleep(50)` 窗口断言虽然会抖，但钉住了窗口长度。重写时被整体拿掉了。

**变异**：`FILE_TREE_REFRESH_BLANK_MS = 0` 在一轮被杀，二轮存活。取 100 同样存活。

**处置记录（2026-11-26）**：三处改字面量钉住——「转圈最短呈现」与「先清空再渲染」在 `refreshFileTree()` 后先 `advanceTimersByTimeAsync(149)` 断言未发请求、再 `advance(1)` 断言发起（149/1 钉死窗口 ≥150 且在 150 发起），补足收标同法用 349/1 字面量；「空白窗口内切作用域」在切作用域前推进 149ms 断言未发（BLANK=0/100 时作废路径走不到，断言失去意义）。变异 `BLANK = 0` 复测：3 用例红（初记 2 用例，三轮评审更正——「空白窗口内切作用域」的 149ms 断言同样变红）。

**修法**（子代理验证：现状通过，常量取 0 或 100 时变红）。必须用字面量。下面是 `:673` 用例的写法，替换 `:680-681` 两行：

```ts
store.refreshFileTree()
await vi.advanceTimersByTimeAsync(149)
expect(listFiles).not.toHaveBeenCalled()
await vi.advanceTimersByTimeAsync(1)
expect(listFiles).toHaveBeenCalledTimes(1)
```

另两处同法：`:750` 处窗口后是 2 次请求（根 + `src/`）；`:803` 处在切作用域之前先推进 149ms 并断言未发请求。

### 3.3 可选项

| # | 位置 | 问题 | 建议 | 处置（2026-11-26） |
|---|---|---|---|---|
| n-a | `app-store.ts:8434-8443` | 目录从磁盘删除后重列失败，旧节点被回填成孤儿 key。它不会被渲染（根的新列表里没有这一行），但每次手动刷新会多发一个必败请求。与提交 `d9db2ad`–`95861f4` 的行为相同；相对 `91e7652`，由「刷新一次后自清」变成「常驻」 | 不修也可以 | 接受不修，记入设计文档「已接受的边缘 ③」 |
| n-b | `app-store.ts:8443` | 回填后的「立即 emit」没有断言。变异：删掉这一句，两个失败用例仍然通过 | 用订阅记录补一条用例。探针实测 emit 序列是「触发 → 回填（标记仍真）→ 收标」，行为正确 | 已补：「全部重列失败」用例挂订阅（触发前挂，防漏记首拍），断言序列 `[true, true, false]`；删 emit 变异红 |
| n-c | `file-panel.tsx:63-64` | 注释写「见 §2.3 已接受边缘」。滚动还原在同文档 `:49`；「已接受的边缘」是 `:51` 的两条 watcher 边缘 | 改注释指针 | 该段注释已随方案 B 重写，失效指针一并消除 |
| n-d | 提交正文 | 三处说法需要更正。`95861f4`「变异验证删守卫即红」：一轮 M2 查明删守卫后用例仍然通过。`91e7652`「测试：最短呈现不闪收」：同一轮查明是空用例。`ef33811`「dev 实测确认」：见 R6-1 | 分支未推送，可以改写；或在下次提交正文里点名更正 | 选择不改写历史（保序降低风险），修订提交正文逐条点名更正三处 |
| n-e | `docs/spec/spec-v0.5.md:47`、`docs/design/design-file-watcher.md:187` | 两处「兜底」列还没有写入手动刷新入口 | 随版本 bump 统一同步。`ef33811` 正文已注明 spec 这一处；`design-file-watcher.md` 这一处是二轮核对行号时新发现 | 维持随版本 bump 统一同步（两处一起），提交正文已再注 |

### 3.4 疑问

- **q-a**：「dev 实测确认」时的测试条件是什么？按代码与探针，只有清空帧和落地帧被合帧时，滚动才可能看起来正常。窗口在后台时 rAF 被节流，会出现这种合帧。
  → **回答（2026-11-26 处置时确认）**：当时并未在 dev 下实测滚动——该句是未经验证的误记（仅跑了 typecheck 与单测，jsdom 验证不了钳制就被标成「已确认」）。探针结论正确。已在设计文档与修订提交正文更正；现版实现的覆盖改为 scrollTop 钳制模型组件用例，dev 复核标注为待办。

## 4. 一轮意见闭环表

一轮对象 = `91e7652`。二轮对象 = `ef33811`。

| 编号 | 级别 | 一轮问题 | 二轮结论 | 依据 |
|---|---|---|---|---|
| M1 | 重要 | 刷新触发即清空 `fileTreeNodes`，`loadFileNodes` 失败不写入。重列失败后整棵树丢失：根失败则树区常驻「加载中…」且不自愈；子目录失败显示「…」（`file-panel.tsx:246-250`）。文档 §3「重列失败时树区保留上次内容」与代码相反 | **已闭环** | 触发前快照 `prev`，settle 时回填缺失的 key 并立即 emit（`app-store.ts:8423`、`:8434-8443`）。文档 §2.3 `:47` 与 §3 `:89` 已同步。两个失败用例杀掉「删回填」与「回填覆盖新数据」两个变异 |
| M2 | 重要 | 两处新用例测不到目标逻辑。「转圈最短呈现」在 50ms 处断言，此时还在空白窗口内，请求没有发出。「旧轮落地不误清新轮」只拦同步清除 | **部分闭环** | 上轮存活的 3 个变异均被杀。空白窗口的钉住丢失（R6-2）。「立即 emit」没有断言（n-b） |
| m1 | 次要 | 同作用域的 `resetFileTree()`（`app-store.ts:4489`）落在刷新窗口内：标记被收、本轮作废。但挂载效应的依赖不含 `refreshingFileTree`，效应不重跑。根只靠这个效应加载（`repullExpandedDirs` 只拉已展开目录，`:3907`），树卡在「加载中…」 | **已闭环** | 依赖数组加入 `store.refreshingFileTree`（`file-panel.tsx:61`）。上轮卡住的探针转绿；删依赖的变异被杀 |
| m2 | 次要 | 刷新期间到达的 watcher 事件，如果落在「server 已读盘、响应未落地」之间，会被闸门（`app-store.ts:8532`、`:8538`）丢弃 | **已闭环** | 记入文档 `:51` 第 ② 条，表述与代码相符 |
| n1 | 可选 | `app.css` 新增 `typing-spin 0.8s`，仓库既有 4 处都是 `1s` | **已闭环** | `app.css:3068` 改为 `1s`，注释同步 |
| n2 | 可选 | 文档「在途期间重复触发合并进当轮」不准确：补足尾段（数据已落地）的点击是被丢弃 | **已闭环** | 文档 `:41` 的措辞已精确化 |
| n3 | 可选 | `spec-v0.5.md:47` 降级表 #3 的兜底列缺手动刷新入口 | **按约定延后** | 随版本 bump 同步（见 n-e） |
| q1 | 疑问 | 清空后内容高度塌缩，滚动位置归零，需要确认是否接受 | **已闭环（方案 B）** | 二轮 R6-1 查明初版实现不生效后按方案 B 重做：入口点击时存、layout effect 双支、size 入依赖重试；钳制模型用例 7 例覆盖探针全部场景 |
| q2 | 疑问 | M1 的处置方向：失败回填，或者接受丢树并改文档 | **已闭环** | 选了回填，文档已同步 |

## 5. 已核查、无问题的面

- **代次守卫**：覆盖空白发起（`app-store.ts:8456`）、落地（`:8433`）、补足收标（`:8446`）三处。旧轮不回填、不收新轮标记，不把旧作用域的内容写进新作用域。
- **singleflight**：没有永久悬挂的路径。`fetchJson` 默认超时 15s（`src/shared/rest-client.ts:160`），`loadFileNodes` 必然 resolve，链路上有 `.catch`（`app-store.ts:8460`）。
- **失败回填的引用共享**：回填节点与快照是同一引用，没有风险。`NodeList` 排序用副本（`file-panel.tsx:166`）；`fileTreeNodes` 只有 set 与 clear。
- **回填与 m1 修法叠加**：没有请求风暴。根此前已加载且全部失败时，根请求共 1 次。首载失败且刷新又失败时共 3 次（首载、轮内、效应补拉），之后停止。
- **卡位稳健性**：`vi.useFakeTimers()` 默认 mock `Date`。探针：起于 T=0 的轮在 T=500 翻转，起于 T=150 的轮在 T=650 翻转，没有 ±1 抖动。`vi.useFakeTimers()` 在 describe 级 `afterEach` 还原（`app-store.test.ts:671`）。
- **清空的影响面**：`fileTreeNodes` 的读取点只有 `file-panel.tsx` 与 watcher 闸门。已打开的文件 Tab 与文件引用不受清空影响。
- **规范**：展开记忆全程不动；i18n 中英齐全；`prefers-reduced-motion` 已处理；4 个 commit 标题符合仓库约定。
- **已删除的 todo 文档**（`todo-file-tree-refresh-test-fake-timers.md`）：三处真实定时器用例已迁；视觉边缘已并入设计文档「已接受的边缘 ①」；全仓库没有悬空引用。

## 6. 变异测试记录

子代理在内存里改写源码后，只跑新增用例。一轮基于 `91e7652`，二轮基于 `ef33811`。

| 变异 | 一轮 | 二轮 |
|---|---|---|
| 删补足逻辑（落地即清标记） | 存活 | 被杀 |
| `FILE_TREE_SPINNER_MIN_MS = 0` | 存活 | 被杀 |
| 同时删两处代次守卫 | 存活 | 被杀 |
| 只删 `settle` 入口守卫 | — | 被杀 |
| 只删 `clear` 守卫 | — | 存活（等价变异：入口守卫先返回） |
| 删空白发起守卫 | 被杀 | 被杀 |
| `resetFileTree` 不进代次 | 被杀 | 被杀 |
| `resetFileTree` 不收标记 | 被杀 | 被杀 |
| 删 singleflight | 被杀 | 被杀 |
| 不清空 `fileTreeNodes` | 被杀 | 被杀 |
| `FILE_TREE_REFRESH_BLANK_MS = 0` | 被杀 | **存活**（R6-2） |
| 根不恒在重列集合 | 被杀 | 被杀 |
| 删挂载效应闸 | 被杀 | 被杀 |
| 删效应依赖 `refreshingFileTree` | — | 被杀 |
| 删失败回填 | — | 被杀 |
| 删回填后的 emit | — | **存活**（n-b） |
| 回填覆盖新数据 | — | 被杀 |
| 删滚动还原 layout effect | — | **存活**（R6-1，零覆盖） |

## 7. 处置顺序与闭环后的更新要求

1. 先裁定 R6-1 的方向（方案 A 或方案 B），再实现并补用例。
2. 处理 R6-2。
3. 处理可选项（§3.3），或写明接受不改的理由。
4. 每处置一项，更新本文对应条目的状态与 §4 的结论列。
5. 按仓库惯例在设计文档补「评审记录」小节并链接本文。先例：design-file-tree-expand-memory 的「评审记录二」。
6. 修订后需要再走一轮评审（AGENTS.md「改完代码先评审再提交」）。

> **处置后更新（2026-11-26）**：1–4 已完成（R6-1 方案 B、R6-2 字面量、n-a 接受不修入边缘 ③、n-b/n-c 已修、n-d 提交正文更正、n-e 维持延后，本文各节已更新）；5 已在设计文档新增「§5 评审记录」链接本文；6 三轮评审已完成——**可合并，无阻塞**；非阻塞遗留（合帧窗口吞还原，慢 server 跳顶复现）已修：收标滞后最后落地至少一拍（`FILE_TREE_CLEAR_GAP_MS` = 50ms），慢轮用例钉住，变异红；nit（§3.2 红数 2→3）已更正。

## 8. 三轮评审与处置（2026-11-26）

评审对象 = 修订提交 `7125800`。结论：**可合并，无阻塞**；方案 B 实现正确、探针 6 条 + 子目录晚落地全部落地、文档处置记录与实现一致、n-d 三处更正完整。

### 8.1 非阻塞：最后内容帧与收标帧被 rAF 合帧时还原丢失

- 窗口：还原写入只发生在 `refreshing === true` 的渲染。落地 emit 与 settle 同链同步段执行，`rest ≤ 0`（重列 ≥ 500ms）时收标 emit 同拍发出；`rest ∈ (0, 一帧]`（重列 ≥ ~334ms）经 `setTimeout(rest)` 落入同一合帧窗——订阅侧 rAF 合帧把三者合成一次 `refreshing=false` 渲染，layout effect 单次运行走「只清 pending」支，最后一次写入机会被吞。影响：单 key（未展开子目录，最常见态）+ 慢 server → 刷新后跳顶；多 key 根帧被钳且高度最后才补足 → 重试丢失。快轮与已成功还原的轮不受影响。
- **处置：选 store 侧修法（评审建议 a）**——收标与最后落地至少隔一拍：`setTimeout(clear, Math.max(rest, FILE_TREE_CLEAR_GAP_MS))`，`FILE_TREE_CLEAR_GAP_MS = 50ms` ≈ 3 帧，慢轮转圈延长 ≤ 50ms 无感。新增慢轮 fake timers 用例：落地 + settle 同步段断言标记仍真（还原机会在位），滞后拍后收标；同步收标变异红。
- 未采样的合帧时序变体（评审关注点 5）随本用例补齐。

### 8.2 nit：§3.2 处置记录红数偏低

变异 `BLANK = 0` 实测 3 用例红（非 2）——「空白窗口内切作用域」的 149ms 断言同样变红。§3.2 处置记录已更正。
