import { randomUUID } from 'node:crypto'
import { db } from './db.ts'

export type NoteRow = {
  id: string
  title: string
  content_md: string
  kind: 'topic' | 'inbox'
  meta: string
  created_at: string
  updated_at: string
}

export type NoteSummary = {
  id: string
  title: string
  summary: string
  kind: 'topic' | 'inbox'
  updatedAt: string
}

function now(): string {
  return new Date().toISOString()
}

function firstParagraph(content: string, max = 80): string {
  const line = content
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0)
  return (line ?? '').slice(0, max)
}

export function listNotes(): NoteSummary[] {
  const rows = db
    .prepare(`SELECT * FROM notes WHERE kind = 'topic' ORDER BY title COLLATE NOCASE`)
    .all() as NoteRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: firstParagraph(r.content_md),
    kind: r.kind,
    updatedAt: r.updated_at,
  }))
}

export function listInbox(): NoteSummary[] {
  const rows = db
    .prepare(`SELECT * FROM notes WHERE kind = 'inbox' ORDER BY created_at DESC`)
    .all() as NoteRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: firstParagraph(r.content_md),
    kind: r.kind,
    updatedAt: r.updated_at,
  }))
}

export function getNote(id: string): NoteRow | undefined {
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
}

export function searchNotes(query: string, count = 5): { id: string; title: string; snippet: string; score: number }[] {
  const q = query.trim()
  if (!q) return []
  // trigram tokenizer 只认 ≥3 字符的词；短词（或 FTS 语法异常）回退 LIKE
  const terms = q.split(/\s+/).filter((t) => t.length >= 3)
  if (terms.length > 0) {
    try {
      const match = terms
        .map((t) => `"${t.replaceAll('"', '""')}"`)
        .join(' OR ')
      const rows = db
        .prepare(
          `SELECT n.id, n.title,
                  snippet(notes_fts, 1, '', '', '…', 32) AS snippet,
                  rank AS score
           FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
           WHERE notes_fts MATCH @q
           ORDER BY rank LIMIT @limit`
        )
        .all({ q: match, limit: count }) as {
        id: string
        title: string
        snippet: string
        score: number
      }[]
      if (rows.length > 0) return rows
    } catch {
      // fall through to LIKE
    }
  }
  const like = `%${q.replaceAll('%', '').replaceAll('_', '')}%`
  return db
    .prepare(
      `SELECT id, title,
              substr(content_md, max(1, instr(content_md, @like) - 40), 200) AS snippet,
              0 AS score
       FROM notes
       WHERE title LIKE @like OR content_md LIKE @like
       ORDER BY updated_at DESC LIMIT @limit`
    )
    .all({ like, limit: count }) as {
    id: string
    title: string
    snippet: string
    score: number
  }[]
}

export function createNote(title: string, contentMd: string, kind: 'topic' | 'inbox' = 'topic'): NoteRow {
  const row: NoteRow = {
    id: randomUUID(),
    title,
    content_md: contentMd,
    kind,
    meta: '{}',
    created_at: now(),
    updated_at: now(),
  }
  db.prepare(
    `INSERT INTO notes (id, title, content_md, kind, meta, created_at, updated_at)
     VALUES (@id, @title, @content_md, @kind, @meta, @created_at, @updated_at)`
  ).run(row)
  return row
}

export function updateNote(id: string, fields: { title?: string; content_md?: string }): NoteRow | undefined {
  const existing = getNote(id)
  if (!existing) return undefined
  const title = fields.title ?? existing.title
  const content = fields.content_md ?? existing.content_md
  db.prepare(`UPDATE notes SET title = ?, content_md = ?, updated_at = ? WHERE id = ?`).run(
    title,
    content,
    now(),
    id
  )
  return getNote(id)
}

export function deleteNote(id: string): NoteRow | undefined {
  const existing = getNote(id)
  if (!existing) return undefined
  db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  return existing
}

export function noteCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c
}
