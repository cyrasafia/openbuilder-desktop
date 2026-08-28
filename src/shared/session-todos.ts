/**
 * 会话任务列表（todo）的归一化与展示投影（design-task-list.md）。
 * 参考移动端：openbuilder models.dart Todo.fromJson（status/priority 缺省回退）
 * 与 conversation_screen.dart showFooter 的 `todos.any((t) => !t.done)` 投影。
 *
 * todo.updated / GET /session/:id/todo 均为全量替换语义（每次携带整个列表），
 * 无合并路径——归一化后整表 set 即正确。
 */
import type { Todo } from "./api-types"

/** 完成语义（移动端 Todo.done 同源）：cancelled 不再占用「未完成」，与 completed 同观感 */
export function todoDone(t: Todo): boolean {
  return t.status === "completed" || t.status === "cancelled"
}

/** in_progress（移动端 Todo.active 同源）——行图标与动画依据 */
export function todoActive(t: Todo): boolean {
  return t.status === "in_progress"
}

/**
 * 事件/REST 负载 → Todo[]。防御式：非数组/非对象条目丢弃、缺 content 的条目
 * 丢弃（无展示价值）、status/priority 缺省回退 pending/medium（openapi 必填，
 * 回退仅防旧版 server 或畸形载荷）。
 */
export function normalizeTodoList(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  for (const x of raw) {
    if (!x || typeof x !== "object") continue
    const o = x as Record<string, unknown>
    const content = typeof o.content === "string" ? o.content : ""
    if (!content) continue
    out.push({
      content,
      status: typeof o.status === "string" ? o.status : "pending",
      priority: typeof o.priority === "string" ? o.priority : "medium",
    })
  }
  return out
}

/** 展示闸门：存在未完成任务才渲染任务卡（全部完成/取消即整卡隐藏，同移动端） */
export function todosActive(todos: Todo[]): boolean {
  return todos.some((t) => !todoDone(t))
}

/** 内容签名 key（openapi Todo 无 id；纯展示无状态，仅作列表 key） */
export function todoKey(t: Todo, i: number): string {
  return `${i}\0${t.status}\0${t.content}`
}
