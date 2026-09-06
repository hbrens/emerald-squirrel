export type Preview =
  | { diff: { t: '+' | '-'; l: string }[] }
  | { newFile: string }
  | { note: string }
  | { delete: string }

export type ProposalData = {
  id: string
  tool: 'write_note' | 'delete_note' | 'record_inbox'
  args: Record<string, unknown>
  preview: Preview
  status?: 'pending' | 'approved' | 'rejected'
}

const TOOL_TITLES: Record<ProposalData['tool'], string> = {
  write_note: '写入笔记',
  delete_note: '删除笔记',
  record_inbox: '记入收件箱',
}

export default function ProposalCard(props: {
  p: ProposalData
  onRespond: (id: string, approve: boolean) => void
}) {
  const { p } = props
  const pending = (p.status ?? 'pending') === 'pending'
  return (
    <div className={`proposal ${pending ? 'pending' : p.status}`}>
      <div className="proposal-head">
        <span className="proposal-tool">{TOOL_TITLES[p.tool]}</span>
        {'title' in p.args && typeof p.args.title === 'string' && (
          <span className="proposal-title">{p.args.title}</span>
        )}
        {'delete' in p.preview && (
          <span className="proposal-title">{p.preview.delete}</span>
        )}
        {!pending && (
          <span className={`proposal-state ${p.status}`}>
            {p.status === 'approved' ? '已写入' : '已取消'}
          </span>
        )}
      </div>
      <div className="proposal-body">
        {'diff' in p.preview && (
          <pre className="diff">
            {p.preview.diff.map((d, i) => (
              <div key={i} className={d.t === '+' ? 'add' : 'del'}>
                {d.t} {d.l}
              </div>
            ))}
          </pre>
        )}
        {'newFile' in p.preview && <pre className="previewblock">{p.preview.newFile}</pre>}
        {'note' in p.preview && <pre className="previewblock">{p.preview.note}</pre>}
        {'delete' in p.preview && p.tool === 'delete_note' && (
          <div className="deletepreview">将删除笔记：{p.preview.delete}</div>
        )}
        {p.tool === 'delete_note' && !('delete' in p.preview) && (
          <div className="deletepreview">将删除一篇笔记</div>
        )}
      </div>
      {pending && (
        <div className="proposal-actions">
          <button className="btn primary" onClick={() => props.onRespond(p.id, true)}>
            确认写入
          </button>
          <button className="btn" onClick={() => props.onRespond(p.id, false)}>
            取消
          </button>
        </div>
      )}
    </div>
  )
}
