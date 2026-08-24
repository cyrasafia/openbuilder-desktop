/**
 * 并发受限执行（REST 池约束：浏览器对同 host HTTP/1.1 连接上限 6，1 条 SSE
 * 常驻后约 5 空闲连接；无限扇出会让排队请求的 AbortSignal.timeout 从发起
 * 时起算、尾部请求饿死超时——降级为空快照虽保守保命，但该目录会一直陈旧
 * 到下次刷新）。
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
