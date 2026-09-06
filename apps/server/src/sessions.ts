import { randomUUID } from 'node:crypto'
import { db } from './db.ts'

export type SessionRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export type StoredToolCall = { name: string; args: string; resultPreview: string }

export type MessageRow = {
  id: string
  session_id: string
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls: string | null
  created_at: string
}

export type DisplayMessage = {
  role: 'user' | 'assistant'
  content: string
  toolCalls: StoredToolCall[]
}

export type SessionSummary = { id: string; title: string; updatedAt: string }

function now(): string {
  return new Date().toISOString()
}

export function createSession(): SessionRow {
  const row: SessionRow = { id: randomUUID(), title: '新对话', created_at: now(), updated_at: now() }
  db.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (@id, @title, @created_at, @updated_at)'
  ).run(row)
  return row
}

export function getSession(id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
}

export function listSessions(): SessionSummary[] {
  return (
    db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]
  ).map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }))
}

export function deleteSession(id: string): boolean {
  const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  return res.changes > 0
}

function touchSession(id: string): void {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id)
}

function nextSeq(sessionId: string): number {
  const row = db
    .prepare('SELECT MAX(seq) AS m FROM messages WHERE session_id = @sid')
    .get({ sid: sessionId }) as { m: number | null } | undefined
  return (row?.m ?? 0) + 1
}

export function setTitleFromFirstMessage(sessionId: string, content: string): void {
  const session = getSession(sessionId)
  if (!session || session.title !== '新对话') return
  const title = content.trim().slice(0, 24) || '新对话'
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

export function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  toolCalls?: StoredToolCall[]
): void {
  const row = {
    id: randomUUID(),
    session_id: sessionId,
    seq: nextSeq(sessionId),
    role,
    content,
    tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
    created_at: now(),
  }
  db.prepare(
    `INSERT INTO messages (id, session_id, seq, role, content, tool_calls, created_at)
     VALUES (@id, @session_id, @seq, @role, @content, @tool_calls, @created_at)`
  ).run(row)
  touchSession(sessionId)
}

export function getMessages(sessionId: string): DisplayMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = @sid ORDER BY seq')
    .all({ sid: sessionId }) as MessageRow[]
  const out: DisplayMessage[] = []
  for (const r of rows) {
    if (r.role === 'tool') continue
    out.push({
      role: r.role,
      content: r.content,
      toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as StoredToolCall[]) : [],
    })
  }
  return out
}
