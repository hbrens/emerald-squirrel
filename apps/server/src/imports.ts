import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPLOADS_DIR, db, EMBEDDING_DIM } from './db.ts'
import { logger } from './logger.ts'

export type ImportRow = {
  id: string
  filename: string
  mime_type: string
  size: number
  sha256: string
  status: 'processing' | 'ready' | 'failed'
  error: string | null
  total_chunks: number
  uploaded_at: string
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
}

export const MIME_WHITELIST: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_VISION_PAGES = 30

const MAX_FILE_SIZE = 50 * 1024 * 1024

function now(): string {
  return new Date().toISOString()
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i).toLowerCase() : ''
}

function rowToSummary(r: ImportRow): ImportSummary {
  return {
    id: r.id,
    filename: r.filename,
    mimeType: r.mime_type,
    size: r.size,
    status: r.status,
    error: r.error,
    chunksCount: r.total_chunks,
    uploadedAt: r.uploaded_at,
  }
}

function getImport(id: string): ImportRow | undefined {
  return db.prepare('SELECT * FROM imports WHERE id = ?').get(id) as ImportRow | undefined
}

export function getImportSummary(id: string): ImportSummary | undefined {
  const r = getImport(id)
  return r ? rowToSummary(r) : undefined
}

export function listImports(): ImportSummary[] {
  const rows = db
    .prepare('SELECT * FROM imports ORDER BY uploaded_at DESC')
    .all() as ImportRow[]
  return rows.map(rowToSummary)
}

// ---------- 文本提取 ----------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

async function extractViaVision(buf: Buffer, mime: string, pageHint?: string): Promise<string> {
  const base = process.env.LLM_BASE_URL ?? 'http://localhost:29005/v1'
  const model = process.env.IMAGE_MODEL ?? 'gpt-5.6-sol'
  const key = process.env.LLM_API_KEY ?? ''
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
  const prompt =
    '请把这张图片中的全部文字内容完整提取为 markdown（保留标题、列表、表格结构），不要解读和评论，不要遗漏。如果图中没有文字，用一句话描述图片内容。' +
    (pageHint ? `（这是文档的${pageHint}）` : '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`视觉模型（${model}）响应 ${res.status} ${detail}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('视觉模型返回空内容')
  return content
}

async function extractText(buf: Buffer, ext: string): Promise<string> {
  switch (ext) {
    case '.pdf': {
      // pdfjs 提取文本层（按页）
      let text = ''
      try {
        const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any
        const doc = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          useSystemFonts: true,
          isEvalSupported: false,
        }).promise
        const pageTexts: string[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          const tc = await page.getTextContent()
          let pageText = ''
          for (const item of tc.items) {
            if ('str' in item) pageText += item.str + (item.hasEOL ? '\n' : ' ')
          }
          if (pageText.trim()) pageTexts.push(`## 第 ${i} 页\n\n${pageText.trim()}`)
          page.cleanup()
        }
        await doc.destroy()
        text = pageTexts.join('\n\n')
      } catch {
        // 文本层提取失败（扫描版/损坏）→ 视觉兜底
      }
      if (text.trim().length >= 50) return text
      // 扫描版 PDF：栅格化逐页送视觉模型
      const { pdf: pdfToImg } = await import('pdf-to-img')
      const doc = await pdfToImg(buf, { scale: 2 })
      const pages: string[] = []
      const total = Math.min(doc.length, MAX_VISION_PAGES)
      for (let i = 1; i <= total; i++) {
        const page = await doc.getPage(i)
        pages.push(`## 第 ${i} 页\n\n${await extractViaVision(page, 'image/png', `第 ${i} 页`)}`)
      }
      await doc.destroy()
      if (total === 0) throw new Error('未能从 PDF 中提取到内容')
      if (doc.length > MAX_VISION_PAGES) {
        pages.push(`\n\n（共 ${doc.length} 页，仅提取前 ${MAX_VISION_PAGES} 页）`)
      }
      return pages.join('\n\n')
    }
    case '.docx': {
      const mammoth = await import('mammoth')
      const { value: html } = await mammoth.convertToHtml({ buffer: buf })
      const cheerio = await import('cheerio')
      const $ = cheerio.load(html)
      $('script,style').remove()
      return $('body').text() ?? ''
    }
    case '.xlsx':
    case '.xls': {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buf, { type: 'buffer' })
      const sections: string[] = []
      for (const name of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: '\t' }).trim()
        if (csv) sections.push(`## 工作表：${name}\n\n${csv}`)
      }
      if (sections.length === 0) throw new Error('表格中没有内容')
      return sections.join('\n\n')
    }
    case '.pptx': {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
      const slideFiles = Object.keys(zip.files)
        .map((f) => (/^ppt\/slides\/slide(\d+)\.xml$/.exec(f) ? { f, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(f)![1]) } : null))
        .filter((x): x is { f: string; n: number } => x !== null)
        .sort((a, b) => a.n - b.n)
      if (slideFiles.length === 0) throw new Error('PPTX 中没有幻灯片内容')
      const sections: string[] = []
      for (const { f, n } of slideFiles) {
        const xml = await zip.files[f].async('string')
        const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]).trim()).filter(Boolean)
        if (texts.length > 0) sections.push(`## 第 ${n} 页\n\n${texts.join('\n')}`)
      }
      if (sections.length === 0) throw new Error('PPTX 幻灯片中没有文字')
      return sections.join('\n\n')
    }
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
      return extractViaVision(buf, MIME_WHITELIST[ext])
    case '.html':
    case '.htm': {
      const cheerio = await import('cheerio')
      const $ = cheerio.load(buf.toString('utf8'))
      $('script,style').remove()
      return $('body').text() ?? ''
    }
    default:
      return buf.toString('utf8')
  }
}

// ---------- 切分 ----------

const SEPARATORS = ['\n\n', '\n', '。', '.', '；', ';', '，', ',', ' ', '']

// nomic 类 tokenizer 的近似：CJK 约 1 字 1 token，其余约 4 字符 1 token
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x3000 && cp <= 0x9fff) cjk++
    else if (cp >= 0xff00 && cp <= 0xffef) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

function splitSmall(text: string, size: number, seps: string[]): string[] {
  if (estimateTokens(text) <= size) return text ? [text] : []
  const [sep, ...rest] = seps
  if (sep === '' || sep === undefined) {
    const out: string[] = []
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
    return out
  }
  const parts = text.split(sep)
  if (parts.length === 1) return splitSmall(text, size, rest)
  const out: string[] = []
  parts.forEach((p, i) => {
    const piece = i < parts.length - 1 ? p + sep : p
    if (piece) out.push(...splitSmall(piece, size, rest))
  })
  return out
}

function tailChars(text: string, overlapTokens: number): string {
  // CJK 1 字 ≈ 1 token，近似取 2 倍字符数做 overlap，从边界处截起
  const tail = text.slice(-overlapTokens * 2)
  const nl = tail.indexOf('\n')
  return nl >= 0 ? tail.slice(nl + 1) : tail
}

export function chunkText(text: string, size = 800, overlap = 100): string[] {
  const pieces = splitSmall(text, size, SEPARATORS)
  const chunks: string[] = []
  let cur = ''
  let curTokens = 0
  for (const p of pieces) {
    const t = estimateTokens(p)
    if (curTokens + t > size && cur) {
      chunks.push(cur.trim())
      cur = tailChars(cur, overlap)
      curTokens = estimateTokens(cur)
    }
    cur += p
    curTokens += t
  }
  if (cur.trim()) chunks.push(cur.trim())
  return chunks
}

// ---------- Embedding ----------

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const base = process.env.EMBEDDING_BASE_URL ?? 'http://127.0.0.1:11434'
  const model = process.env.EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b'
  const res = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`embedding 服务响应 ${res.status}（${base}）`)
  const data = (await res.json()) as { embeddings: number[][] }
  if (!data.embeddings?.length) throw new Error('embedding 服务返回空结果')
  if (data.embeddings[0].length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding 维度不匹配：模型返回 ${data.embeddings[0].length}，schema 为 ${EMBEDDING_DIM}`
    )
  }
  return data.embeddings.map((e) => Float32Array.from(e))
}

// ---------- 管线 ----------

function deleteChunksOfImport(importId: string): void {
  const ids = db
    .prepare('SELECT id FROM import_chunks WHERE import_id = ?')
    .all(importId) as { id: string }[]
  const delVec = db.prepare('DELETE FROM import_chunks_vec WHERE chunk_id = ?')
  db.transaction(() => {
    for (const { id } of ids) delVec.run(id)
    db.prepare('DELETE FROM import_chunks WHERE import_id = ?').run(importId)
  })()
}

export async function processImport(id: string): Promise<void> {
  const row = getImport(id)
  if (!row) return
  const ext = extOf(row.filename)
  try {
    const buf = readFileSync(join(UPLOADS_DIR, id + ext))
    const text = (await extractText(buf, ext)).trim()
    if (!text) throw new Error('未能从文件中提取到文本')
    const chunks = chunkText(text)

    deleteChunksOfImport(id)
    const insertChunk = db.prepare(
      'INSERT INTO import_chunks (id, import_id, chunk_index, text, token_count) VALUES (?, ?, ?, ?, ?)'
    )
    const insertVec = db.prepare(
      'INSERT INTO import_chunks_vec (chunk_id, embedding) VALUES (?, ?)'
    )
    const BATCH = 16
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH)
      const vectors = await embedBatch(batch)
      db.transaction(() => {
        batch.forEach((text2, j) => {
          const chunkId = randomUUID()
          insertChunk.run(chunkId, id, i + j, text2, estimateTokens(text2))
          insertVec.run(chunkId, Buffer.from(vectors[j].buffer))
        })
      })()
    }
    db.prepare('UPDATE imports SET status = ?, error = NULL, total_chunks = ? WHERE id = ?').run(
      'ready',
      chunks.length,
      id
    )
    logger.info({ importId: id, chunks: chunks.length }, 'import ready')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    db.prepare('UPDATE imports SET status = ?, error = ?, total_chunks = 0 WHERE id = ?').run(
      'failed',
      message,
      id
    )
    logger.warn({ importId: id, error: message }, 'import failed')
  }
}

export type UploadOutcome =
  | { status: 201; summary: ImportSummary; dedup: false }
  | { status: 200; summary: ImportSummary; dedup: true }

export function saveUpload(filename: string, mime: string, buf: Buffer): UploadOutcome {
  const sha = createHash('sha256').update(buf).digest('hex')
  const ext = extOf(filename)

  const bySha = db.prepare('SELECT * FROM imports WHERE sha256 = ?').get(sha) as
    | ImportRow
    | undefined
  if (bySha) return { status: 200, summary: rowToSummary(bySha), dedup: true }

  const existing = db.prepare('SELECT * FROM imports WHERE filename = ?').get(filename) as
    | ImportRow
    | undefined

  let id: string
  if (existing) {
    // 同名不同内容 = 更新：复用记录，重跑管线
    id = existing.id
    db.prepare(
      'UPDATE imports SET mime_type = ?, size = ?, sha256 = ?, status = ?, error = NULL, total_chunks = 0, uploaded_at = ? WHERE id = ?'
    ).run(mime, buf.length, sha, 'processing', now(), id)
  } else {
    id = randomUUID()
    try {
      db.prepare(
        'INSERT INTO imports (id, filename, mime_type, size, sha256, status, total_chunks, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
      ).run(id, filename, mime, buf.length, sha, 'processing', now())
    } catch {
      // 并发同名上传撞 filename 唯一索引 → 降级为更新路径
      const race = db.prepare('SELECT * FROM imports WHERE filename = ?').get(filename) as ImportRow | undefined
      if (!race) throw new Error('同名上传并发冲突且记录缺失')
      id = race.id
      db.prepare(
        'UPDATE imports SET mime_type = ?, size = ?, sha256 = ?, status = ?, error = NULL, total_chunks = 0, uploaded_at = ? WHERE id = ?'
      ).run(mime, buf.length, sha, 'processing', now(), id)
    }
  }
  writeFileSync(join(UPLOADS_DIR, id + ext), buf)
  const summary = rowToSummary(getImport(id)!)
  void processImport(id)
  return { status: 201, summary, dedup: false }
}

export function deleteImport(id: string): ImportSummary | undefined {
  const row = getImport(id)
  if (!row) return undefined
  deleteChunksOfImport(id)
  db.prepare('DELETE FROM imports WHERE id = ?').run(id)
  try {
    unlinkSync(join(UPLOADS_DIR, id + extOf(row.filename)))
  } catch {
    // 原文件已不存在，忽略
  }
  return rowToSummary(row)
}

// ---------- 检索 ----------

export async function searchImportsAsync(query: string, topK = 5) {
  const [vec] = await embedBatch([query])
  const hits = db
    .prepare(
      'SELECT chunk_id, distance FROM import_chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance'
    )
    .all(Buffer.from(vec.buffer), topK) as { chunk_id: string; distance: number }[]
  const chunkRow = db.prepare(
    `SELECT c.chunk_index, c.text, i.filename
     FROM import_chunks c JOIN imports i ON i.id = c.import_id
     WHERE c.id = ? AND i.status = 'ready'`
  )
  return hits.flatMap((h) => {
    const c = chunkRow.get(h.chunk_id) as
      | { chunk_index: number; text: string; filename: string }
      | undefined
    if (!c) return []
    return [
      {
        doc_title: c.filename,
        chunk_text: c.text.slice(0, 500),
        score: 1 - h.distance,
        source_path: c.filename,
        chunk_index: c.chunk_index,
      },
    ]
  })
}
