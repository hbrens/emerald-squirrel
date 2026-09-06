import { NEEDS_CONFIRM, buildProposal, executeTool, TOOLS, type Proposal, type ToolArgs, type ToolName } from './tools.ts'
import {
  appendMessage,
  getMessages,
  setTitleFromFirstMessage,
  type StoredToolCall,
} from './sessions.ts'
import { logger } from './logger.ts'

export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://localhost:29005/v1'
export const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-5.6-sol'
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''

const MAX_ROUNDS = 10
const MAX_CONTEXT_MESSAGES = 30
const CONFIRM_TIMEOUT_MS = 120_000

type UpstreamMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type SseEvent =
  | 'session'
  | 'delta'
  | 'tool'
  | 'tool_result'
  | 'proposal'
  | 'proposal_done'
  | 'truncated'
  | 'error'
  | 'done'

export type Emit = (event: SseEvent, data: Record<string, unknown>) => Promise<void>

const SYSTEM_PROMPT = `你是知识库的维护助手。笔记层在 SQLite（通过工具调用读写）。

## 核心原则：写入即维护

用户交给你的任何信息，不能只随手一记，要当场放到它该在的地方：

1. 先 search_notes 查是否已有相关主题笔记（关键词从用户内容里抽 1-3 个核心词）
2. 命中同主题 → read_note(id) 读旧文 → 把新信息合并进合适章节 → write_note(id, 新全文)
3. 无命中 → write_note(id 传 null, content_md, title) 新建主题笔记
4. 多条相关信息 → 合并进同一笔记，不要为每条新建
5. 只有明显属于时间流水的内容（今天做了 X、临时备忘）才用 record_inbox

## 判断同主题

- title 涵盖新信息主题 → 同主题，走合并
- 新信息是命中笔记的延伸/补充/反例/修正 → 同主题，走合并
- 命中但完全不相关 → 不同主题，新建

## title 命名

- 中文优先
- 短句覆盖主题，例：「nginx 502 排查」「async 取消机制」
- 不要写「关于 X 的笔记」这种冗余前缀

## 其他

- 用户说「整理收件箱/归档」时：逐条检查收件箱（list_notes 返回不含收件箱，用 search_notes 搜收件箱内容或要求用户给条目），把主题性内容合并进 topics 笔记，处理完删除已合并的 inbox 条目
- 修改笔记前必须 read_note；回答问题前必须 search_notes 查证，不要编造
- 依赖用户上传资料的问题用 search_imports 检索，引用时注明出处文件名
- 中文回答，简洁。写入操作完成后用一句话说明放到了哪里
- 写入类操作会展示 diff 给用户确认，确认后才落盘`

// ---------- 确认机制 ----------

type PendingProposal = (ok: boolean) => void
const pendingProposals = new Map<string, PendingProposal>()

export function resolveConfirm(id: string, approve: boolean): boolean {
  const resolve = pendingProposals.get(id)
  if (!resolve) return false
  pendingProposals.delete(id)
  resolve(approve)
  return true
}

function waitConfirm(id: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish: PendingProposal = (ok) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      pendingProposals.delete(id)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS)
    const onAbort = () => finish(false)
    pendingProposals.set(id, finish)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------- 上下文截断 ----------

function truncateForContext(messages: UpstreamMessage[]): {
  msgs: UpstreamMessage[]
  dropped: number
} {
  const [system, ...rest] = messages
  if (rest.length <= MAX_CONTEXT_MESSAGES) return { msgs: messages, dropped: 0 }
  let start = rest.length - MAX_CONTEXT_MESSAGES
  while (
    start < rest.length &&
    (rest[start].role === 'tool' || rest[start].tool_calls?.length)
  ) {
    start++
  }
  return { msgs: [system, ...rest.slice(start)], dropped: start }
}

// ---------- 上游调用 ----------

type UpstreamToolCall = {
  index: number
  id?: string
  function: { name?: string; arguments?: string }
}

async function callUpstream(
  messages: UpstreamMessage[],
  emit: Emit,
  signal: AbortSignal
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: LLM_MODEL, messages, tools: TOOLS, stream: true }),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`LLM 网关响应 ${res.status} ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  const calls = new Map<number, { id: string; name: string; arguments: string }>()

  const handleChunk = (payload: string): void => {
    if (payload === '[DONE]') return
    let chunk: {
      choices?: { delta?: { content?: string | null; tool_calls?: UpstreamToolCall[] } }[]
    }
    try {
      chunk = JSON.parse(payload)
    } catch {
      return
    }
    const delta = chunk.choices?.[0]?.delta
    if (!delta) return
    if (delta.content) {
      content += delta.content
      void emit('delta', { text: delta.content })
    }
    for (const tc of delta.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', arguments: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.arguments += tc.function.arguments
      calls.set(tc.index, cur)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        handleChunk(line.slice(5).trim())
      }
    }
  } catch (e) {
    if (!signal.aborted) throw e
    // 用户中止：返回已积累的部分内容（半截回复照常落盘）
  }
  return {
    content,
    toolCalls: [...calls.values()].filter((c) => c.id && c.name),
  }
}

// ---------- 主循环 ----------

export async function chatTurn(
  sessionId: string,
  content: string,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  appendMessage(sessionId, 'user', content)
  setTitleFromFirstMessage(sessionId, content)

  const history: UpstreamMessage[] = getMessages(sessionId)
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  const messages: UpstreamMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content },
  ]

  let truncatedEmitted = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { msgs, dropped } = truncateForContext(messages)
    if (dropped > 0 && !truncatedEmitted) {
      truncatedEmitted = true
      await emit('truncated', { dropped })
    }

    const { content: text, toolCalls } = await callUpstream(msgs, emit, signal)

    if (toolCalls.length === 0) {
      appendMessage(sessionId, 'assistant', text)
      return
    }

    messages.push({ role: 'assistant', content: text, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })) })

    const summaries: StoredToolCall[] = []
    const toolMsgs: UpstreamMessage[] = []

    for (const tc of toolCalls) {
      let args: ToolArgs = {}
      try {
        args = tc.arguments ? (JSON.parse(tc.arguments) as ToolArgs) : {}
      } catch {
        // arguments 不是合法 JSON → 作为失败喂回
      }
      const name = tc.name as ToolName
      await emit('tool', { name, args: tc.arguments.slice(0, 200) })

      let result: Record<string, unknown>
      let approved: boolean | undefined
      if (NEEDS_CONFIRM.has(name)) {
        const proposal = await buildProposal(name, args).catch(() => null)
        if (!proposal) {
          result = { error: '无法构建确认信息（笔记可能不存在）' }
        } else {
          await emit('proposal', proposal as unknown as Record<string, unknown>)
          approved = await waitConfirm(proposal.id, signal)
          await emit('proposal_done', { id: proposal.id, approved })
          result = approved ? await executeTool(name, args) : { error: '用户取消或未确认此操作' }
        }
      } else {
        result = await executeTool(name, args)
      }

      const preview = JSON.stringify(result).slice(0, 200)
      await emit('tool_result', { name, preview })
      summaries.push({ name, args: tc.arguments.slice(0, 200), resultPreview: preview })
      toolMsgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 8000),
      })
      logger.info({ sessionId, tool: name, approved }, 'tool executed')
    }

    appendMessage(sessionId, 'assistant', text, summaries)
    messages.push(...toolMsgs)
  }

  appendMessage(sessionId, 'assistant', '⚠️ 工具调用轮次已达上限，本轮结束。')
}

export function makeSafeEmit(emit: Emit, signal: AbortSignal): Emit {
  return async (event, data) => {
    if (signal.aborted) return
    try {
      await emit(event, data)
    } catch {
      // 连接已断开，忽略
    }
  }
}

export type { Proposal }
