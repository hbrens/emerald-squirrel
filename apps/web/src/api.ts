export type SessionSummary = { id: string; title: string; updatedAt: string }

export type NoteSummary = {
  id: string
  title: string
  summary: string
  kind: 'topic' | 'inbox'
  updatedAt: string
}

export type ImportSummary = {
  id: string
  filename: string
  mimeType: string
  size: number
  status: 'processing' | 'ready' | 'failed'
  error: string | null
  chunksCount: number
  uploadedAt: string
  dedup?: boolean
}

export type ToolCallSummary = { name: string; args: string; resultPreview: string }

export type HistoryMessage = {
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCallSummary[]
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let code = 'INTERNAL_ERROR'
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error) {
      code = body.error.code ?? code
      message = body.error.message ?? message
    }
  } catch {
    // 非 JSON 错误体
  }
  throw new ApiError(res.status, code, message)
}

export function getJSON<T>(url: string): Promise<T> {
  return fetch(url).then((r) => unwrap<T>(r))
}

export function postJSON<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => unwrap<T>(r))
}

export function deleteJSON<T>(url: string): Promise<T> {
  return fetch(url, { method: 'DELETE' }).then((r) => unwrap<T>(r))
}

export function postFormData<T>(url: string, form: FormData): Promise<T> {
  return fetch(url, { method: 'POST', body: form }).then((r) => unwrap<T>(r))
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function groupSessions(sessions: SessionSummary[]): {
  today: SessionSummary[]
  week: SessionSummary[]
  earlier: SessionSummary[]
} {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000
  const groups = { today: [], week: [], earlier: [] } as {
    today: SessionSummary[]
    week: SessionSummary[]
    earlier: SessionSummary[]
  }
  for (const s of sessions) {
    const t = new Date(s.updatedAt).getTime()
    if (t >= startOfToday) groups.today.push(s)
    else if (t >= weekAgo) groups.week.push(s)
    else groups.earlier.push(s)
  }
  return groups
}
