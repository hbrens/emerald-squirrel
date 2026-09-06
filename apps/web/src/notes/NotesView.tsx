import { useCallback, useEffect, useState } from 'react'
import { getJSON, type NoteSummary } from '../api'
import { renderMd } from '../md'

type NoteDetail = {
  id: string
  title: string
  content_md: string
  kind: 'topic' | 'inbox'
  createdAt: string
  updatedAt: string
}

export default function NotesView() {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selected, setSelected] = useState<NoteDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    setLoading(true)
    const url = debouncedQ
      ? `/api/notes/search?q=${encodeURIComponent(debouncedQ)}`
      : '/api/notes'
    getJSON<NoteSummary[]>(url)
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setLoading(false))
  }, [debouncedQ])

  const open = useCallback((id: string) => {
    getJSON<NoteDetail>(`/api/notes/${id}`)
      .then(setSelected)
      .catch(() => setSelected(null))
  }, [])

  return (
    <div className="notesview">
      <div className="noteslist">
        <input
          className="searchbox"
          placeholder="搜索笔记…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="notecount">{loading ? '加载中…' : `${notes.length} 篇笔记`}</div>
        <div className="noterows">
          {notes.map((n) => (
            <button
              key={n.id}
              className={`noterow ${selected?.id === n.id ? 'active' : ''}`}
              onClick={() => open(n.id)}
            >
              <span className="notetitle">{n.title}</span>
              <span className="notesummary">{n.summary}</span>
            </button>
          ))}
          {!loading && notes.length === 0 && (
            <div className="empty-hint">{debouncedQ ? '没有匹配的笔记' : '还没有笔记，去对话里记点什么'}</div>
          )}
        </div>
      </div>
      <div className="docview">
        {selected ? (
          <>
            <div className="docview-head">
              <h1>{selected.title}</h1>
              <span className="docview-time">
                更新于 {new Date(selected.updatedAt).toLocaleString('zh-CN')}
              </span>
            </div>
            <div className="md doccontent" dangerouslySetInnerHTML={{ __html: renderMd(selected.content_md) }} />
          </>
        ) : (
          <div className="empty-hint big">从左侧选择一篇笔记</div>
        )}
      </div>
    </div>
  )
}
