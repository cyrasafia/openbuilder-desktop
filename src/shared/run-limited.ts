/**
 * 并发受限执行（REST 池约束：5 条 SSE 常驻后仅 ~1 空闲连接，无限扇出会让
 * 排队请求的 AbortSignal.timeout 从分发起算、尾部请求饿死超时——降级为空
 * 快照虽保守保命，但该目录会一直陈旧到下次刷新）。
 * 单个任务失败不中断其余任务（Promise.all 已捕获后续拒绝，剩余 worker 继续消费队列）。
 */
export async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]
        await fn(item)
      }
    }),
  )
}
