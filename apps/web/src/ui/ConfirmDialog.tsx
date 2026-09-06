export default function ConfirmDialog(props: {
  message: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="confirm-overlay" onClick={props.onCancel}>
      {/* 页内弹窗:不用 window.confirm,ZCode 内置浏览器里原生弹窗不可见且阻塞页面 */}
      <div className="confirmbox" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-msg">{props.message}</div>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            取消
          </button>
          <button className="btn solid-danger" onClick={props.onConfirm}>
            {props.confirmText ?? '删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
