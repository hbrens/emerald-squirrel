import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createNote,
  deleteNote,
  getNote,
  listInbox,
  listNotes,
  searchNotes,
  updateNote,
  type NoteRow,
} from './notes.ts'
import { searchImportsAsync } from './imports.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const TOOLS = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8')) as unknown[]

export type ToolArgs = Record<string, unknown>
export type ToolResult = Record<string, unknown>

export type ProposalPreview =
  | { diff: { t: '+' | '-'; l: string }[] }
  | { newFile: string }
  | { note: string }
  | { delete: string }

export type Proposal = {
  id: string
  tool: ToolName
  args: ToolArgs
  preview: ProposalPreview
}

export type ToolName =
  | 'list_notes'
  | 'read_note'
  | 'search_notes'
  | 'write_note'
  | 'delete_note'
  | 'record_inbox'
  | 'search_imports'

export const NEEDS_CONFIRM: ReadonlySet<string> = new Set(['write_note', 'delete_note', 'record_inbox'])

// ---------- lineDiff（LCS） ----------

export function lineDiff(oldText: string, newText: string): { t: '+' | '-'; l: string }[] {
  const A = oldText.split('\n')
  const B = newText.split('\n')
  const ops: { t: '+' | '-'; l: string }[] = []
  if (A.length * B.length > 1_000_000) {
    for (const l of A) ops.push({ t: '-', l })
    for (const l of B) ops.push({ t: '+', l })
    return ops
  }
  const m = A.length
  const n = B.length
  const width = n + 1
  const dp = new Uint32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] =
        A[i] === B[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ t: '-', l: A[i++] })
    } else {
      ops.push({ t: '+', l: B[j++] })
    }
  }
  while (i < m) ops.push({ t: '-', l: A[i++] })
  while (j < n) ops.push({ t: '+', l: B[j++] })
  return ops
}

// ---------- 参数解析 ----------

function str(args: ToolArgs, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`参数 ${key} 缺失或不是字符串`)
  return v
}

function optionalId(args: ToolArgs): string | null {
  const v = args['id']
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || !v) throw new Error('参数 id 必须是非空字符串或 null')
  return v
}

// ---------- 执行器 ----------

export async function executeTool(name: ToolName, args: ToolArgs): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_notes':
        return { notes: listNotes() }
      case 'read_note': {
        const note = getNote(str(args, 'id'))
        if (!note) return { error: `笔记不存在: ${args['id']}` }
        return {
          id: note.id,
          title: note.title,
          content_md: note.content_md,
          created_at: note.created_at,
          updated_at: note.updated_at,
        }
      }
      case 'search_notes': {
        const count = typeof args['count'] === 'number' ? args['count'] : 5
        return { hits: searchNotes(str(args, 'query'), count) }
      }
      case 'write_note': {
        const id = optionalId(args)
        const title = str(args, 'title')
        const content = str(args, 'content_md')
        let note: NoteRow | undefined
        if (id === null) {
          note = createNote(title, content, 'topic')
        } else {
          note = updateNote(id, { title, content_md: content })
          if (!note) return { error: `笔记不存在: ${id}` }
        }
        return { ok: true, id: note.id, title: note.title }
      }
      case 'delete_note': {
        const deleted = deleteNote(str(args, 'id'))
        if (!deleted) return { error: `笔记不存在: ${args['id']}` }
        return { ok: true, id: deleted.id, title: deleted.title }
      }
      case 'record_inbox': {
        const content = str(args, 'content')
        const note = createNote(content.slice(0, 24), content, 'inbox')
        return { ok: true, id: note.id, timestamp: note.created_at }
      }
      case 'search_imports': {
        const topK = typeof args['top_k'] === 'number' ? args['top_k'] : 5
        try {
          return { hits: await searchImportsAsync(str(args, 'query'), topK) }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return { error: `embedding 服务不可达，导入层暂不可检索（${message}）` }
        }
      }
      default:
        return { error: `未知工具: ${name}` }
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- proposal / preview ----------

export async function buildProposal(name: ToolName, args: ToolArgs): Promise<Proposal | null> {
  const id = crypto.randomUUID()
  let preview: ProposalPreview
  if (name === 'write_note') {
    const noteId = optionalId(args)
    const content = typeof args['content_md'] === 'string' ? args['content_md'] : ''
    const old = noteId ? getNote(noteId) : undefined
    if (noteId && !old) return null
    if (old) {
      preview = {
        diff: lineDiff(old.content_md, content).slice(0, 400),
      }
    } else {
      preview = { newFile: content.slice(0, 600) }
    }
  } else if (name === 'record_inbox') {
    const content = typeof args['content'] === 'string' ? args['content'] : ''
    preview = { note: content.slice(0, 300) }
  } else if (name === 'delete_note') {
    const note = getNote(typeof args['id'] === 'string' ? args['id'] : '')
    if (!note) return null
    preview = { delete: note.title }
  } else {
    return null
  }
  return { id, tool: name, args, preview }
}

export function inboxCount(): number {
  return listInbox().length
}
