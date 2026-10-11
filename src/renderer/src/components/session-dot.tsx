import type { SessionDotState } from "@shared/pending-requests"

/** dotStateFor 六态 → session-* 变体类。Record 键穷尽：新增状态缺映射即编译错——
 * 历史上 sidebar / workspace 各持一份同构三元链，对新增状态静默回落灰点（unread
 * 设计 §5.2 记录过的坑：TypeScript 不报错、漏加分支即画错色），本组件收拢为
 * 单一映射后消除 */
const DOT_CLASS: Record<SessionDotState, string> = {
  running: "session-running",
  error: "session-error",
  failed: "session-failed",
  waiting: "session-waiting",
  unread: "session-unread",
  idle: "session-idle",
}

/**
 * 会话状态点（12px 盒，Tab 条 / 左栏逐点态 / >4 聚合 chip 共用）。
 * inline SVG circle 而非 border-radius 伪元素（2026-10-11，
 * design-indicator-aggregate-chip）：Chromium 在分数 DPR（GNOME Wayland
 * 1.25/1.5 等）下对 border-radius 盒做「吸附后拉伸」光栅化，6px 圆点按位置
 * 亚像素相位变形为扁/竖椭圆；SVG 路径光栅化对相位不敏感（16 相位 × DPR
 * 1.25/1.1 实测全部同几何）。running / error 附 r=5.5 光晕圆（呼吸同旧 11px
 * 规格；svg overflow:visible 见 app.css——SVG 元素默认裁剪内容到自身视口，
 * 呼吸最大 scale 1.15 = 12.65px 超出 12px 盒需自由溢出）。
 */
export function SessionDot({ state }: { state: SessionDotState }) {
  const halo = state === "running" || state === "error"
  return (
    <span className={"status-dot " + DOT_CLASS[state]}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        {halo ? <circle className="halo" cx="6" cy="6" r="5.5" /> : null}
        <circle className="core" cx="6" cy="6" r="3" />
      </svg>
    </span>
  )
}
