# server 不可达时会话 Tab 可恢复（todo-server-unreachable-tab-recovery）

> 状态：待办（需先调研再决策，实施时另开分支）。来源：官方 v2.2.0 #56248「Keep session tabs recoverable when their server becomes unreachable」的借鉴评估（2026-10-27 会话裁定：需进一步研究内容再决定）。

## 背景

我们的断开态处理：SSE 断连 → 指数退避重连 → 重连必全量对账（会话 + 消息 + worktree + pending，spec-v0.5 #1）。会话 Tab 在断开期间的呈现/可操作态未专项设计。

官方 v2.2.0 面向多 server 场景做了「server 不可达时会话 Tab 保持可恢复」。我们单 server 本机连接，场景不同，可借鉴度待评估。

## 调研项（实施前完成）

1. 读官方 #56248 的实现内容（断开期间 Tab 呈什么态、恢复路径是什么、与重连对账如何配合）
2. 对照我们的断开态现状：Tab 是否保持可见、内容是否冻结、重连后是否平滑恢复
3. 识别真实缺口（如有）再定做不做

## 不做假设

- 不预设要抄官方形态；我们单 server 场景的缺口可能为空
