const TOOL_LABELS: Record<string, string> = {
  list_notes: '列出笔记',
  read_note: '读取笔记',
  search_notes: '搜索笔记',
  write_note: '写入笔记',
  delete_note: '删除笔记',
  record_inbox: '记入收件箱',
  search_imports: '检索导入资料',
}

function shortArgs(args: string): string {
  if (!args) return ''
  try {
    const o = JSON.parse(args) as Record<string, unknown>
    const parts: string[] = []
    for (const [k, v] of Object.entries(o)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      parts.push(`${k}: ${(s ?? '').slice(0, 60)}`)
    }
    return parts.join(' · ')
  } catch {
    return args.slice(0, 80)
  }
}

export default function ToolTimeline(props: {
  steps: { name: string; args: string; result?: string }[]
  aborted?: boolean
}) {
  if (props.steps.length === 0 && !props.aborted) return null
  return (
    <div className="timeline">
      {props.steps.map((s, i) => (
        <div className="step" key={i}>
          <div className="dot" />
          <div className="stepbody">
            <div className="steplabel">
              {TOOL_LABELS[s.name] ?? s.name}
              {s.result === undefined && <span className="running">运行中…</span>}
            </div>
            {shortArgs(s.args) && <div className="stepargs">{shortArgs(s.args)}</div>}
            {s.result !== undefined && <div className="stepresult">{s.result}</div>}
          </div>
        </div>
      ))}
      {props.aborted && <div className="steplabel aborted">已中止</div>}
    </div>
  )
}
