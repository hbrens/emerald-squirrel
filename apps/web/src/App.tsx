import { useCallback, useEffect, useState } from 'react'
import {
  deleteJSON,
  getJSON,
  groupSessions,
  type SessionSummary,
} from './api'
import ChatView from './chat/ChatView'
import NotesView from './notes/NotesView'
import ImportsView from './imports/ImportsView'

export type Tab = 'chat' | 'notes' | 'imports'

const MODEL_TAG = 'gpt-5.6-sol'

export default function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const refreshSessions = useCallback(() => {
    getJSON<SessionSummary[]>('/api/sessions')
      .then(setSessions)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  const removeSession = async (id: string) => {
    if (!window.confirm('删除这个会话？')) return
    try {
      await deleteJSON(`/api/sessions/${id}`)
      if (activeId === id) setActiveId(null)
      refreshSessions()
    } catch {
      // 列表下次刷新会修正
    }
  }

  const groups = groupSessions(sessions)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">open-sesame</div>
        <nav className="navtabs">
          <button
            className={`navtab ${tab === 'chat' ? 'active' : ''}`}
            onClick={() => setTab('chat')}
          >
            对话
          </button>
          <button
            className={`navtab ${tab === 'notes' ? 'active' : ''}`}
            onClick={() => setTab('notes')}
          >
            笔记
          </button>
          <button
            className={`navtab ${tab === 'imports' ? 'active' : ''}`}
            onClick={() => setTab('imports')}
          >
            导入
          </button>
        </nav>
        <button className="newchat" onClick={() => { setTab('chat'); setActiveId(null) }}>
          ＋ 新对话
        </button>
        <div className="sessionlist">
          {groups.today.length > 0 && <div className="grouplabel">今天</div>}
          {groups.today.map((s) => (
            <SessionItem
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => { setTab('chat'); setActiveId(s.id) }}
              onDelete={() => removeSession(s.id)}
            />
          ))}
          {groups.week.length > 0 && <div className="grouplabel">近 7 天</div>}
          {groups.week.map((s) => (
            <SessionItem
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => { setTab('chat'); setActiveId(s.id) }}
              onDelete={() => removeSession(s.id)}
            />
          ))}
          {groups.earlier.length > 0 && <div className="grouplabel">更早</div>}
          {groups.earlier.map((s) => (
            <SessionItem
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => { setTab('chat'); setActiveId(s.id) }}
              onDelete={() => removeSession(s.id)}
            />
          ))}
          {sessions.length === 0 && <div className="empty-hint">还没有会话</div>}
        </div>
        <div className="userfooter">
          <span className="modeltag">{MODEL_TAG}</span>
          <span className="hint">写入需确认</span>
        </div>
      </aside>
      <main className="main">
        {tab === 'chat' && (
          <ChatView
            sessionId={activeId}
            onSessionCreated={setActiveId}
            onTurnEnd={() => { refreshSessions() }}
          />
        )}
        {tab === 'notes' && <NotesView />}
        {tab === 'imports' && <ImportsView />}
      </main>
    </div>
  )
}

function SessionItem(props: {
  s: SessionSummary
  active: boolean
  onClick: () => void
  onDelete: () => void
}) {
  return (
    <div className={`sessionitem ${props.active ? 'active' : ''}`} onClick={props.onClick}>
      <span className="sessiontitle">{props.s.title}</span>
      <button
        className="sessiondel"
        title="删除会话"
        onClick={(e) => { e.stopPropagation(); props.onDelete() }}
      >
        ×
      </button>
    </div>
  )
}
