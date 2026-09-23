/**
 * 独立连接弹窗（design-guided-add-server 修订 3，2026-09-23）：新建/切换服务
 * 器挂起期的呈现——宿主（设置弹窗/欢迎卡片）整体隐藏（.connecting-host-
 * hidden，display:none 保挂载，editing/草稿/扫描结果状态不丢），由本弹窗
 * 独立承接连接反馈：居中小弹窗（spinner + addProfileConnecting 文案）。
 * **无任何可交互控件**——无关闭钮、Esc 无效、遮罩点击无操作（连接不可中
 * 断，修订 2 冻结语义不变）；成功/失败由挂起流收尾方卸载本组件，失败回原
 * 窗口内联展示 connectionError。设置弹窗与欢迎屏共用（单一来源非复制）。
 */
import { LoaderCircle } from "lucide-react"
import { useI18n } from "../app"

export function ConnectingDialog() {
  const { t } = useI18n()
  return (
    <div className="dialog-mask">
      <div className="dialog connecting-dialog" role="status" aria-live="polite">
        <LoaderCircle className="pending-connect-spinner" size={16} aria-hidden />
        <span>{t.addProfileConnecting}</span>
      </div>
    </div>
  )
}
