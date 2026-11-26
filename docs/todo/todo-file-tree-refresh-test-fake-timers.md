# 文件树刷新动效测试迁移 fake timers（todo）

> 来源：design-file-panel-context-menu §2.3「先清空再渲染」评审（2026-11-26，
> 非阻塞意见 1）。实施时另开分支。

## 1. 背景

文件树刷新动效（转圈最短呈现 500ms + 先清空再渲染空白窗 150ms）引入三处
**真实定时器 + 窗口断言**的用例（app-store.test.ts）：

- 「在途标记」「先清空再渲染」：`sleep(50)` 后断言 `listFiles` 未被调用——
  若事件循环在 sleep 期间停顿 >100ms，150ms 空白定时器提前触发，断言红。
- 「转圈最短呈现」：`sleep(50)` 后断言 `refreshingFileTree` 仍为 true——
  sleep 过冲跨过 ~500ms 补足点同样红（需 ~10 倍过冲，概率更低）。

慢 CI（限流 / GC 停顿）下有偶发抖动风险。同文件「文件监听」describe 块已有
确定性先例：`vi.useFakeTimers()` + `advanceTimersByTimeAsync`。

## 2. 待办

1. 上述三处用例迁 fake timers（注意：deferred 手动 resolve 与微任务冲刷在
   fake timers 下经 `advanceTimersByTimeAsync` 推进；`waitFor` 需替换为手动
   断言，勿混用真/假定时器）。
2. 迁移后删除真实 sleep，套件预计省 ~1s。

## 3. 已接受的边缘（记录在案，不修）

空白窗口内 watcher 去抖定时器（`scheduleTreeRefresh`，300ms 去抖）落地会把
单行提前回填、局部吞掉该行的清空帧。纯视觉、瞬态、重列落地即自愈；触发场景
为 agent 活跃写文件的同时用户点刷新。不修。
