import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations, UPLOADS_DIR } from './db.ts'
import { logger } from './logger.ts'
import { chatTurn, makeSafeEmit, resolveConfirm } from './llm.ts'
import { createSession, deleteSession, getSession, getMessages, listSessions } from './sessions.ts'
import { getNote, listInbox, listNotes, searchNotes } from './notes.ts'
import { MIME_WHITELIST, deleteImport, getImportSummary, listImports, saveUpload } from './imports.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 61127)
const MAX_FILE_SIZE = 50 * 1024 * 1024

runMigrations()
logger.info('db migrated')

const app = new Hono()

type ApiStatus = 400 | 404 | 409 | 413 | 415 | 500

function apiError(c: import('hono').Context, status: ApiStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

app.onError((err, c) => {
  logger.error({ error: err.message, path: c.req.path }, 'unhandled error')
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500)
})

// ---------- chat ----------

const busySessions = new Set<string>()

app.post('/api/chat', async (c) => {
  const body = await c.req.json<{ sessionId?: string | null; content?: string }>().catch(() => null)
  const content = body?.content?.trim()
  if (!content) return apiError(c, 400, 'BAD_REQUEST', 'content 不能为空')

  let session = body?.sessionId ? getSession(body.sessionId) : undefined
  if (body?.sessionId && !session) return apiError(c, 404, 'NOT_FOUND', '会话不存在')
  if (!session) session = createSession()
  if (busySessions.has(session.id)) return apiError(c, 409, 'SESSION_BUSY', '该会话有进行中的对话，请稍候')

  busySessions.add(session.id)
  logger.info({ sessionId: session.id }, 'chat turn start')

  return streamSSE(c, async (stream) => {
    const ac = new AbortController()
    stream.onAbort(() => ac.abort())
    const emit = makeSafeEmit(
      (event, data) =>
        stream.writeSSE({ event, data: JSON.stringify({ type: event, ...data }) }),
      ac.signal
    )
    try {
      await emit('session', { sessionId: session!.id, title: session!.title })
      await chatTurn(session!.id, content, emit, ac.signal)
      await emit('done', { sessionId: session!.id })
      logger.info({ sessionId: session!.id }, 'chat turn done')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ sessionId: session!.id, error: message }, 'chat turn failed')
      await emit('error', { message })
    } finally {
      busySessions.delete(session!.id)
    }
  })
})

app.post('/api/confirm', async (c) => {
  const body = await c.req.json<{ id?: string; approve?: boolean }>().catch(() => null)
  if (!body?.id || typeof body.approve !== 'boolean') {
    return apiError(c, 400, 'BAD_REQUEST', '需要 id 与 approve 字段')
  }
  const ok = resolveConfirm(body.id, body.approve)
  return c.json({ ok })
})

// ---------- sessions ----------

app.get('/api/sessions', (c) => c.json(listSessions()))

app.post('/api/sessions', (c) => {
  const s = createSession()
  return c.json({ id: s.id, title: s.title, createdAt: s.created_at, updatedAt: s.updated_at }, 201)
})

app.get('/api/sessions/:id', (c) => {
  const s = getSession(c.req.param('id'))
  if (!s) return apiError(c, 404, 'NOT_FOUND', '会话不存在')
  return c.json({
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    messages: getMessages(s.id),
  })
})

app.delete('/api/sessions/:id', (c) => {
  if (!deleteSession(c.req.param('id'))) return apiError(c, 404, 'NOT_FOUND', '会话不存在')
  return c.json({ ok: true })
})

// ---------- notes（人类只读） ----------

app.get('/api/notes', (c) => c.json(listNotes()))
app.get('/api/notes/search', (c) => {
  const q = c.req.query('q') ?? ''
  return c.json(searchNotes(q, 20))
})
app.get('/api/notes/inbox', (c) => c.json(listInbox()))
app.get('/api/notes/:id', (c) => {
  const note = getNote(c.req.param('id'))
  if (!note) return apiError(c, 404, 'NOT_FOUND', '笔记不存在')
  return c.json({
    id: note.id,
    title: note.title,
    content_md: note.content_md,
    kind: note.kind,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  })
})

// ---------- imports ----------

app.post('/api/imports/upload', async (c) => {
  const body = await c.req.parseBody().catch(() => null)
  const file = body?.['file']
  if (!(file instanceof File)) return apiError(c, 400, 'BAD_REQUEST', '需要 multipart 字段 file')
  if (file.size > MAX_FILE_SIZE) return apiError(c, 413, 'FILE_TOO_LARGE', '文件超过 50 MB')
  const i = file.name.lastIndexOf('.')
  const ext = i >= 0 ? file.name.slice(i).toLowerCase() : ''
  const mime = MIME_WHITELIST[ext]
  if (!mime) {
    return apiError(c, 415, 'UNSUPPORTED_MEDIA_TYPE', `不支持的格式 ${ext || '(无扩展名)'}，仅支持 PDF/DOCX/XLSX/PPTX/图片/MD/TXT/HTML`)
  }
  const buf = Buffer.from(await file.arrayBuffer())
  const outcome = saveUpload(file.name, mime, buf)
  logger.info({ filename: file.name, dedup: outcome.dedup }, 'upload accepted')
  return c.json(
    { ...outcome.summary, dedup: outcome.dedup },
    outcome.status
  )
})

app.get('/api/imports', (c) => c.json(listImports()))
app.get('/api/imports/:id', (c) => {
  const s = getImportSummary(c.req.param('id'))
  if (!s) return apiError(c, 404, 'NOT_FOUND', '导入文档不存在')
  return c.json(s)
})
app.delete('/api/imports/:id', (c) => {
  if (!deleteImport(c.req.param('id'))) return apiError(c, 404, 'NOT_FOUND', '导入文档不存在')
  return c.json({ ok: true })
})

logger.info({ uploadsDir: UPLOADS_DIR }, 'imports ready')

// ---------- 静态资源（生产） ----------

const distDir = join(here, '..', '..', 'web', 'dist')
if (existsSync(distDir)) {
  app.use('*', serveStatic({ root: distDir }))
  app.get('*', (c) => {
    const index = join(distDir, 'index.html')
    if (!existsSync(index)) return c.notFound()
    return c.html(readFileSync(index, 'utf8'))
  })
  logger.info({ distDir }, 'serving web dist')
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`emerald-squirrel server listening on http://localhost:${info.port}`)
})
