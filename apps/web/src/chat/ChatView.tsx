import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { getJSON, postJSON, type HistoryMessage, type ModelConfig, type ToolCallSummary } from '../api'
import { renderMd } from '../md'
import ToolTimeline from './ToolTimeline'
import ProposalCard, { type ProposalData } from './ProposalCard'

type Status = 'idle' | 'streaming' | 'awaiting_confirm' | 'error'

type ToolStep = { name: string; args: string; result?: string }

type Draft = {
  userText: string
  assistantText: string
  steps: ToolStep[]
  proposals: ProposalData[]
  model: string | null
  notice?: string
  error?: string
  aborted?: boolean
}

type Msg = { role: 'user' | 'assistant'; content: string; toolCalls: ToolCallSummary[]; model?: string | null }

type State = { messages: Msg[]; draft: Draft | null; status: Status; sessionError: string | null }

type Action =
  | { type: 'RESET' }
  | { type: 'LOAD'; messages: Msg[] }
  | { type: 'TURN_START'; text: string; model: string | null }
  | { type: 'DELTA'; text: string }
  | { type: 'TOOL'; name: string; args: string }
  | { type: 'TOOL_RESULT'; preview: string }
  | { type: 'PROPOSAL'; proposal: ProposalData }
  | { type: 'PROPOSAL_DONE'; id: string; approved: boolean }
  | { type: 'TRUNCATED'; dropped: number }
  | { type: 'TURN_ERROR'; message: string }
  | { type: 'SESSION_ERROR'; message: string }
  | { type: 'ABORTED' }
  | { type: 'SET_PROPOSAL_STATUS'; id: string; approved: boolean }
  | { type: 'TURN_END' }

const initial: State = { messages: [], draft: null, status: 'idle', sessionError: null }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'RESET':
      return { ...initial }
    case 'LOAD':
      return { ...state, messages: action.messages }
    case 'TURN_START':
      return {
        ...state,
        status: 'streaming',
        sessionError: null,
        draft: {
          userText: action.text,
          assistantText: '',
          steps: [],
          proposals: [],
          model: action.model,
        },
      }
    case 'DELTA':
      if (!state.draft) return state
      return { ...state, draft: { ...state.draft, assistantText: state.draft.assistantText + action.text } }
    case 'TOOL':
      if (!state.draft) return state
      return {
        ...state,
        draft: { ...state.draft, steps: [...state.draft.steps, { name: action.name, args: action.args }] },
      }
    case 'TOOL_RESULT':
      if (!state.draft || state.draft.steps.length === 0) return state
      return {
        ...state,
        draft: {
          ...state.draft,
          steps: state.draft.steps.map((s, i) =>
            i === state.draft!.steps.length - 1 ? { ...s, result: action.preview } : s
          ),
        },
      }
    case 'PROPOSAL':
      if (!state.draft) return state
      return {
        ...state,
        status: 'awaiting_confirm',
        draft: { ...state.draft, proposals: [...state.draft.proposals, action.proposal] },
      }
    case 'PROPOSAL_DONE': {
      if (!state.draft) return state
      const proposals = state.draft.proposals.map((p) =>
        p.id === action.id ? { ...p, status: action.approved ? 'approved' as const : 'rejected' as const } : p
      )
      const stillPending = proposals.some((p) => p.status === 'pending')
      return {
        ...state,
        status: stillPending ? 'awaiting_confirm' : 'streaming',
        draft: { ...state.draft, proposals },
      }
    }
    case 'SET_PROPOSAL_STATUS': {
      if (!state.draft) return state
      const proposals = state.draft.proposals.map((p) =>
        p.id === action.id ? { ...p, status: action.approved ? 'approved' as const : 'rejected' as const } : p
      )
      return { ...state, draft: { ...state.draft, proposals } }
    }
    case 'TRUNCATED':
      if (!state.draft) return state
      return {
        ...state,
        draft: { ...state.draft, notice: `更早的 ${action.dropped} 条消息已省略出上下文（历史仍完整保存）` },
      }
    case 'TURN_ERROR':
      if (!state.draft) return state
      return { ...state, draft: { ...state.draft, error: action.message } }
    case 'SESSION_ERROR':
      return { ...state, sessionError: action.message }
    case 'ABORTED':
      if (!state.draft) return state
      return { ...state, draft: { ...state.draft, aborted: true } }
    case 'TURN_END': {
      if (!state.draft) return { ...state, status: 'idle' }
      const d = state.draft
      const msgs: Msg[] = [...state.messages, { role: 'user', content: d.userText, toolCalls: [] }]
      msgs.push({
        role: 'assistant',
        content: d.assistantText,
        toolCalls: d.steps.map((s) => ({ name: s.name, args: s.args, resultPreview: s.result ?? '' })),
        model: d.model,
      })
      return { ...state, messages: msgs, draft: null, status: 'idle' }
    }
  }
}

export default function ChatView(props: {
  sessionId: string | null
  models: ModelConfig[]
  currentModelId: string | null
  onSelectModel: (id: string) => void
  onSessionCreated: (id: string) => void
  onTurnEnd: () => void
}) {
  const [state, dispatch] = useReducer(reducer, initial)
  const [input, setInput] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const internalIdRef = useRef<string | null>(props.sessionId)
  const listEndRef = useRef<HTMLDivElement | null>(null)

  // 会话切换：仅在 prop 与内部记录不一致时重置加载
  useEffect(() => {
    if (props.sessionId === internalIdRef.current) return
    internalIdRef.current = props.sessionId
    abortRef.current?.abort()
    dispatch({ type: 'RESET' })
    if (props.sessionId) {
      getJSON<{ messages: HistoryMessage[] }>(`/api/sessions/${props.sessionId}`)
        .then((data) => dispatch({ type: 'LOAD', messages: data.messages }))
        .catch(() => dispatch({ type: 'SESSION_ERROR', message: '会话加载失败' }))
    }
  }, [props.sessionId])

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages.length, state.draft?.assistantText, state.draft?.steps.length])

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const ac = new AbortController()
      abortRef.current = ac
      const modelName = props.models.find((m) => m.id === props.currentModelId)?.name ?? null
      dispatch({ type: 'TURN_START', text: trimmed, model: modelName })
      setInput('')

      const onEvent = (ev: Record<string, unknown>) => {
        switch (ev.type) {
          case 'session':
            internalIdRef.current = ev.sessionId as string
            props.onSessionCreated(ev.sessionId as string)
            break
          case 'delta':
            dispatch({ type: 'DELTA', text: ev.text as string })
            break
          case 'tool':
            dispatch({ type: 'TOOL', name: ev.name as string, args: (ev.args as string) ?? '' })
            break
          case 'tool_result':
            dispatch({ type: 'TOOL_RESULT', preview: ev.preview as string })
            break
          case 'proposal':
            dispatch({ type: 'PROPOSAL', proposal: ev as unknown as ProposalData })
            break
          case 'proposal_done':
            dispatch({ type: 'PROPOSAL_DONE', id: ev.id as string, approved: Boolean(ev.approved) })
            break
          case 'truncated':
            dispatch({ type: 'TRUNCATED', dropped: ev.dropped as number })
            break
          case 'error':
            dispatch({ type: 'TURN_ERROR', message: ev.message as string })
            break
        }
      }

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: internalIdRef.current,
            content: trimmed,
            modelId: props.currentModelId,
          }),
          signal: ac.signal,
        })
        if (resp.status === 409) {
          dispatch({ type: 'SESSION_ERROR', message: '该对话正在另一个窗口进行中' })
          dispatch({ type: 'TURN_END' })
          return
        }
        if (!resp.ok || !resp.body) {
          dispatch({ type: 'SESSION_ERROR', message: `请求失败 HTTP ${resp.status}` })
          dispatch({ type: 'TURN_END' })
          return
        }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const line = frame.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue
            try {
              onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>)
            } catch {
              // 不完整帧，忽略
            }
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          dispatch({ type: 'SESSION_ERROR', message: `连接中断：${String(e)}` })
        } else {
          dispatch({ type: 'ABORTED' })
        }
      } finally {
        dispatch({ type: 'TURN_END' })
        props.onTurnEnd()
      }
    },
    [props]
  )

  const respond = useCallback(
    async (id: string, approve: boolean) => {
      dispatch({ type: 'SET_PROPOSAL_STATUS', id, approved: approve })
      try {
        await postJSON<{ ok: boolean }>('/api/confirm', { id, approve })
        if (approve) props.onTurnEnd()
      } catch {
        // 服务端 proposal_done 事件兜底
      }
    },
    [props]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const busy = state.status !== 'idle'

  return (
    <div className="chatview">
      <div className="topbar">
        <span className="topbar-title">
          {state.messages.length > 0 || internalIdRef.current ? '对话' : '新对话'}
        </span>
        <div className="topbar-right">
          <select
            className="modelselect"
            value={props.currentModelId ?? ''}
            disabled={busy || props.models.length === 0}
            onChange={(e) => props.onSelectModel(e.target.value)}
            title="切换对话模型"
          >
            {props.models.length === 0 && <option value="">模型未配置（.env 兜底）</option>}
            {props.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="topbar-tag">写入需确认</span>
        </div>
      </div>
      <div className="msglist">
        {state.messages.length === 0 && !state.draft && (
          <div className="welcome">
            <div className="welcome-title">有什么要记的或想问的？</div>
            <div className="welcome-sub">
              说「记一下…」会写入笔记（需确认）；说「X 是啥」会查笔记与导入资料
            </div>
          </div>
        )}
        {state.messages.map((m, i) => (
          <MessageItem key={i} m={m} />
        ))}
        {state.draft && (
          <>
            <div className="msg user">
              <div className="bubble">{state.draft.userText}</div>
            </div>
            <div className="msg assistant">
              {state.draft.model && <div className="msgmodel">{state.draft.model}</div>}
              {state.draft.notice && <div className="truncated-notice">{state.draft.notice}</div>}
              <ToolTimeline steps={state.draft.steps} aborted={state.draft.aborted} />
              {state.draft.proposals.map((p) => (
                <ProposalCard key={p.id} p={p} onRespond={respond} />
              ))}
              {state.draft.error && <div className="errorbanner">⚠ {state.draft.error}</div>}
              {state.draft.assistantText && (
                <div className="bubble md" dangerouslySetInnerHTML={{ __html: renderMd(state.draft.assistantText) }} />
              )}
            </div>
          </>
        )}
        <div ref={listEndRef} />
      </div>
      {state.sessionError && <div className="sessionerror">{state.sessionError}</div>}
      <div className="composer">
        <textarea
          value={input}
          placeholder={busy ? '对话进行中…' : '记一下… / 问点什么…'}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!busy) void send(input)
            }
          }}
        />
        <div className="composerbar">
          <span className="hint">Enter 发送 · Shift+Enter 换行</span>
          {busy ? (
            <button className="sendbtn stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="sendbtn" disabled={!input.trim()} onClick={() => void send(input)}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageItem({ m }: { m: Msg }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      {m.model && <div className="msgmodel">{m.model}</div>}
      {m.toolCalls.length > 0 && (
        <ToolTimeline
          steps={m.toolCalls.map((t) => ({ name: t.name, args: t.args, result: t.resultPreview }))}
        />
      )}
      {m.content && <div className="bubble md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />}
    </div>
  )
}
