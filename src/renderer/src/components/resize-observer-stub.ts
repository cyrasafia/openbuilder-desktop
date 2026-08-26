/**
 * ResizeObserver 测试 stub（jsdom 缺失）：CodeMirror 测量与 FileView TOC 测宽共用。
 * 默认 observe/disconnect 无副作用；记录实例与观察目标，测试可手动 `fire()`
 * 触发回调模拟尺寸变更（配合对 target 的 clientWidth 覆写）。
 */
export class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = []
  target: Element | null = null
  private readonly cb: ResizeObserverCallback

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    ResizeObserverStub.instances.push(this)
  }

  observe(el: Element): void {
    this.target = el
  }

  unobserve(): void {}

  disconnect(): void {}

  /** 测试助手：手动触发回调（先对 target 覆写 clientWidth 等） */
  fire(): void {
    this.cb([], this as unknown as ResizeObserver)
  }

  static reset(): void {
    ResizeObserverStub.instances = []
  }
}
