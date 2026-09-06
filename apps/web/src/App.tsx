import { useCallback, useEffect, useState } from 'react'
import {
  deleteJSON,
  getJSON,
  groupSessions,
  type ModelConfig,
  type SessionSummary,
} from './api'
import ChatView from './chat/ChatView'
import NotesView from './notes/NotesView'
import ImportsView from './imports/ImportsView'
import SettingsView from './settings/SettingsView'
import ConfirmDialog from './ui/ConfirmDialog'

export type Tab = 'chat' | 'notes' | 'imports' | 'settings'

const MODEL_STORAGE_KEY = 'htwm.modelId'

export default function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [models, setModels] = useState<ModelConfig[]>([])
  const [currentModelId, setCurrentModelId] = useState<string | null>(() =>
    localStorage.getItem(MODEL_STORAGE_KEY)
  )
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)

  const refreshSessions = useCallback(() => {
    getJSON<SessionSummary[]>('/api/sessions')
      .then(setSessions)
      .catch(() => {})
  }, [])

  const refreshModels = useCallback(() => {
    getJSON<ModelConfig[]>('/api/models')
      .then(setModels)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshSessions()
    refreshModels()
  }, [refreshSessions, refreshModels])

  // 当前选择的模型被删除（或本地存了脏值）→ 回退到默认模型
  useEffect(() => {
    if (models.length === 0) return
    if (currentModelId && models.some((m) => m.id === currentModelId)) return
    const next = models.find((m) => m.isDefault) ?? models[0]
    setCurrentModelId(next.id)
    localStorage.setItem(MODEL_STORAGE_KEY, next.id)
  }, [models, currentModelId])

  const selectModel = useCallback((id: string) => {
    setCurrentModelId(id)
    localStorage.setItem(MODEL_STORAGE_KEY, id)
  }, [])

  const removeSession = async (id: string) => {
    try {
      await deleteJSON(`/api/sessions/${id}`)
      if (activeId === id) setActiveId(null)
      refreshSessions()
    } catch {
      // 列表下次刷新会修正
    }
  }

  const groups = groupSessions(sessions)
  const currentModel = models.find((m) => m.id === currentModelId)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">emerald-squirrel</div>
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
          <button
            className={`navtab ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            设置
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
              onDelete={() => setPendingDelete(s)}
            />
          ))}
          {groups.week.length > 0 && <div className="grouplabel">近 7 天</div>}
          {groups.week.map((s) => (
            <SessionItem
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => { setTab('chat'); setActiveId(s.id) }}
              onDelete={() => setPendingDelete(s)}
            />
          ))}
          {groups.earlier.length > 0 && <div className="grouplabel">更早</div>}
          {groups.earlier.map((s) => (
            <SessionItem
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => { setTab('chat'); setActiveId(s.id) }}
              onDelete={() => setPendingDelete(s)}
            />
          ))}
          {sessions.length === 0 && <div className="empty-hint">还没有会话</div>}
        </div>
        <div className="userfooter">
          <span className="modeltag">{currentModel ? currentModel.name : '默认 .env'}</span>
          <span className="hint">写入需确认</span>
        </div>
      </aside>
      <main className="main">
        {tab === 'chat' && (
          <ChatView
            sessionId={activeId}
            models={models}
            currentModelId={currentModelId}
            onSelectModel={selectModel}
            onSessionCreated={setActiveId}
            onTurnEnd={() => { refreshSessions() }}
          />
        )}
        {tab === 'notes' && <NotesView />}
        {tab === 'imports' && <ImportsView />}
        {tab === 'settings' && <SettingsView models={models} onChange={refreshModels} />}
        {pendingDelete && (
          <ConfirmDialog
            message={`删除会话「${pendingDelete.title}」？`}
            onConfirm={() => {
              void removeSession(pendingDelete.id)
              setPendingDelete(null)
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
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
