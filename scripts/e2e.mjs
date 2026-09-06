// open-sesame API 层端到端验证
// 用法: node scripts/e2e.mjs   (服务需已在 localhost:3088 运行)
const BASE = process.env.BASE ?? 'http://localhost:3088'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function logEvent(ev) {
  const brief =
    ev.type === 'delta'
      ? null
      : ev.type === 'tool'
        ? `tool ${ev.name}`
        : ev.type === 'tool_result'
          ? `tool_result ${ev.name}`
          : ev.type === 'proposal'
            ? `proposal ${ev.tool} preview=${Object.keys(ev.preview ?? {})[0]}`
            : ev.type === 'proposal_done'
              ? `proposal_done approved=${ev.approved}`
              : ev.type === 'session'
                ? `session ${ev.sessionId?.slice(0, 8)}`
                : ev.type
  if (brief) console.log(`    [sse] ${brief}`)
}

// 发起一轮对话；onProposal 收到 proposal 时回调（返回 approve 布尔），默认自动批准
async function chat(content, { sessionId = null, onProposal, onEvent } = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content }),
  })
  if (!res.ok) throw new Error(`chat http ${res.status}: ${await res.text()}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  let text = ''
  let sid = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line.slice(6))
      } catch {
        continue
      }
      events.push(ev)
      logEvent(ev)
      onEvent?.(ev)
      if (ev.type === 'session') sid = ev.sessionId
      if (ev.type === 'delta') text += ev.text ?? ''
      if (ev.type === 'proposal') {
        const approve = onProposal ? await onProposal(ev) : true
        await fetch(`${BASE}/api/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ev.id, approve }),
        })
      }
    }
  }
  return { sessionId: sid, events, text }
}

const types = (events) => events.map((e) => e.type)
const toolNames = (events) => events.filter((e) => e.type === 'tool').map((e) => e.name)

async function main() {
  console.log('== 准备：服务健康检查 ==')
  const health = await fetch(`${BASE}/api/notes`)
  check('GET /api/notes 200', health.ok)

  console.log('== 阶段 1：新建笔记（查重→新建→确认落盘） ==')
  const r1 = await chat(
    '记一下：nginx 502 常见原因是 upstream 挂了，先检查后端进程，再确认 upstream 地址配置，最后配 proxy_next_upstream 做重试。'
  )
  check('返回 sessionId', Boolean(r1.sessionId))
  check('有 session 事件', types(r1.events)[0] === 'session')
  check('调用了 search_notes 查重', toolNames(r1.events).includes('search_notes'))
  check('出现 write_note proposal', r1.events.some((e) => e.type === 'proposal' && e.tool === 'write_note'))
  const p1 = r1.events.find((e) => e.type === 'proposal' && e.tool === 'write_note')
  check('新建笔记 preview 为 newFile 形态', p1 && 'newFile' in p1.preview)
  check('确认后落盘', r1.events.some((e) => e.type === 'proposal_done' && e.approved === true))
  const notes1 = await (await fetch(`${BASE}/api/notes`)).json()
  const topic1 = notes1.find((n) => (n.title ?? '').includes('502'))
  check('笔记列表出现 502 主题笔记', Boolean(topic1), `got ${notes1.map((n) => n.title).join(',')}`)

  console.log('== 阶段 2：合并写入（查重命中→读旧文→diff 确认） ==')
  const r2 = await chat(
    '补充一点：nginx 502 也可能是 proxy_buffers 太小导致响应放不下，把这条合并进之前的 502 笔记。',
    { sessionId: r1.sessionId }
  )
  const p2 = r2.events.find((e) => e.type === 'proposal' && e.tool === 'write_note')
  check('再次 search_notes 查重', toolNames(r2.events).includes('search_notes'))
  check('调用了 read_note 读旧文', toolNames(r2.events).includes('read_note'))
  if (!p2) {
    check('更新笔记 preview 为 diff 形态', false, '未出现 write_note proposal')
  } else {
    check('更新笔记 preview 为 diff 形态', 'diff' in p2.preview, JSON.stringify(Object.keys(p2.preview)))
    const noteAfter2 = await (await fetch(`${BASE}/api/notes/${p2.args.id}`)).json()
    check(
      '合并后正文同时含旧信息与新信息',
      (noteAfter2.content_md ?? '').includes('proxy_next_upstream') &&
        (noteAfter2.content_md ?? '').includes('proxy_buffers')
    )
  }

  console.log('== 阶段 3：提问（检索不写入） ==')
  const r3 = await chat('nginx 502 该怎么排查来着？', { sessionId: r1.sessionId })
  check('调用了 search_notes', toolNames(r3.events).includes('search_notes'))
  check('没有写入 proposal', !r3.events.some((e) => e.type === 'proposal'))
  check('回答非空', r3.text.trim().length > 10)

  console.log('== 阶段 4：取消写入 ==')
  // 注意：不能用「不许落盘/不要写」类话术（08 已知坑：LLM 会拒绝调工具），用中性话术
  const r4 = await chat('记一下：临时备忘条目 ZZZZZ，标记为测试取消流程用的。', {
    sessionId: r1.sessionId,
    onProposal: async () => false,
  })
  check('出现 proposal', r4.events.some((e) => e.type === 'proposal'))
  check('proposal_done approved=false', r4.events.some((e) => e.type === 'proposal_done' && e.approved === false))
  const inboxAfterCancel = await (await fetch(`${BASE}/api/notes/inbox`)).json()
  check(
    '取消后收件箱没有该条目',
    !inboxAfterCancel.some((n) => (n.summary ?? '').includes('ZZZZZ'))
  )

  console.log('== 阶段 5：pending 时新 turn → 409 ==')
  let sid5 = null
  const turnA = chat('记一下：临时备忘条目 QQQQQ，标记为占用会话测试用的。', {
    onEvent: (ev) => {
      if (ev.type === 'session') sid5 = ev.sessionId
    },
    onProposal: async () => {
      // proposal 挂起期间对同一会话发起第二个 turn，应得到 409
      const resB = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid5, content: '这条消息应该被 409 拒绝' }),
      })
      check('并发第二个 turn 返回 409', resB.status === 409, `got ${resB.status}`)
      await resB.body?.cancel().catch(() => {})
      return false // 然后取消，尽快结束 turn A
    },
  })
  await turnA
  check('turn A 正常结束', true)

  console.log('== 阶段 6：上传导入 + 去重 + 语义检索 ==')
  const docContent = [
    '# 内部部署手册 v2',
    '',
    '## 邮件服务配置',
    '公司邮件服务器使用 postfix，中继地址为 relay.corp.local:25。',
    '员工邮箱配额为 20GB，超出后只收不发。',
    '',
    '## VPN 配置',
    'VPN 使用 WireGuard，端口 51820，客户端配置文件在内网门户下载。',
    '两步验证使用 TOTP，重置需要联系 IT 服务台。',
    '',
    '## 打印机',
    '三楼打印机型号 HP LaserJet M405，驱动在内网门户 → IT 工具 → 打印驱动下载。',
  ].join('\n')
  const fd = new FormData()
  fd.append('file', new Blob([docContent], { type: 'text/markdown' }), '部署手册.md')
  const up1 = await (await fetch(`${BASE}/api/imports/upload`, { method: 'POST', body: fd })).json()
  check('上传返回 processing/ready', ['processing', 'ready'].includes(up1.status), up1.status)

  let ready = null
  for (let i = 0; i < 60; i++) {
    ready = await (await fetch(`${BASE}/api/imports/${up1.id}`)).json()
    if (ready.status !== 'processing') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check('导入管线完成 ready', ready?.status === 'ready', JSON.stringify(ready))
  check('产生切片', (ready?.chunksCount ?? 0) >= 1, `chunks=${ready?.chunksCount}`)

  const fd2 = new FormData()
  fd2.append('file', new Blob([docContent], { type: 'text/markdown' }), '部署手册.md')
  const up2 = await (await fetch(`${BASE}/api/imports/upload`, { method: 'POST', body: fd2 })).json()
  check('重复上传 dedup=true', up2.dedup === true, JSON.stringify(up2))

  const fd3 = new FormData()
  fd3.append('file', new Blob([docContent + '\n\n## 更新：邮箱配额上调到 50GB。'], { type: 'text/markdown' }), '部署手册.md')
  const up3 = await (await fetch(`${BASE}/api/imports/upload`, { method: 'POST', body: fd3 })).json()
  check('同名不同内容视为更新（同 id）', up3.id === up1.id && up3.dedup !== true, JSON.stringify(up3))
  for (let i = 0; i < 60; i++) {
    const s = await (await fetch(`${BASE}/api/imports/${up3.id}`)).json()
    if (s.status !== 'processing') {
      check('更新后重新就绪', s.status === 'ready', JSON.stringify(s))
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const r6 = await chat('公司 VPN 用的是什么？从导入资料里查一下告诉我。')
  check('调用了 search_imports', toolNames(r6.events).includes('search_imports'))
  check('回答提到 WireGuard', r6.text.includes('WireGuard'), r6.text.slice(0, 120))

  console.log('== 阶段 7：笔记 FTS5 中文检索 ==')
  const search = await (await fetch(`${BASE}/api/notes/search?q=${encodeURIComponent('502 排查')}`)).json()
  check('搜索命中 502 笔记', Array.isArray(search) && search.some((h) => (h.title ?? '').includes('502')), JSON.stringify(search))

  console.log('== 阶段 8：新格式导入（XLSX / PPTX / 图片 / 扫描版 PDF） ==')
  const { createRequire } = await import('node:module')
  const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url))

  async function uploadAndPoll(name, mime, buf) {
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: mime }), name)
    const up = await (await fetch(`${BASE}/api/imports/upload`, { method: 'POST', body: fd })).json()
    if (!up.id) throw new Error(`上传失败: ${JSON.stringify(up)}`)
    let s = up
    for (let i = 0; i < 90; i++) {
      s = await (await fetch(`${BASE}/api/imports/${up.id}`)).json()
      if (s.status !== 'processing') break
      await new Promise((r) => setTimeout(r, 2000))
    }
    return s
  }

  // 8a. XLSX（SheetJS 生成，含 Q3 预算数据）
  const XLSX = serverRequire('xlsx')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['季度', '预算（万元）'], ['Q1', 100], ['Q2', 200], ['Q3', 350]]), '预算')
  const xlsxStatus = await uploadAndPoll('季度预算.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  check('XLSX 提取就绪', xlsxStatus.status === 'ready', JSON.stringify(xlsxStatus))
  check('XLSX 产生切片', (xlsxStatus.chunksCount ?? 0) >= 1, `chunks=${xlsxStatus.chunksCount}`)

  // 8b. PPTX（最小 zip：ppt/slides/slideN.xml）
  const JSZip = serverRequire('jszip')
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld><p:txBody><a:p><a:r><a:t>会议室使用规范</a:t></a:r></a:p><a:p><a:r><a:t>投影仪 HDMI 接口在讲台右侧</a:t></a:r></a:p></p:txBody></p:sld>')
  zip.file('ppt/slides/slide2.xml', '<p:sld><p:txBody><a:p><a:r><a:t>打印机 IP 是 192.168.3.21</a:t></a:r></a:p></p:txBody></p:sld>')
  const pptxStatus = await uploadAndPoll('会议室说明.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', await zip.generateAsync({ type: 'nodebuffer' }))
  check('PPTX 提取就绪', pptxStatus.status === 'ready', JSON.stringify(pptxStatus))

  // 8c. 图片（canvas 画文字 → 视觉模型提取）
  const { createCanvas } = serverRequire('@napi-rs/canvas')
  const canvas = createCanvas(560, 140)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 560, 140)
  ctx.fillStyle = '#111111'
  ctx.font = '28px sans-serif'
  ctx.fillText('VPN 服务器地址: vpn.corp.local:51820', 24, 60)
  ctx.fillText('客户端配置在内网门户下载', 24, 104)
  const imgStatus = await uploadAndPoll('vpn说明.png', 'image/png', canvas.toBuffer('image/png'))
  check('图片视觉提取就绪', imgStatus.status === 'ready', JSON.stringify(imgStatus))

  // 8d. 扫描版 PDF（pdf-lib 把 PNG 包进 PDF，无文本层 → 触发栅格化 + 视觉兜底）
  const { PDFDocument } = serverRequire('pdf-lib')
  const pdfDoc = await PDFDocument.create()
  const embedded = await pdfDoc.embedPng(canvas.toBuffer('image/png'))
  const page = pdfDoc.addPage([620, 260])
  page.drawImage(embedded, { x: 30, y: 60, width: 560, height: 140 })
  const pdfStatus = await uploadAndPoll('扫描版说明.pdf', 'application/pdf', await pdfDoc.save())
  check('扫描版 PDF 视觉兜底就绪', pdfStatus.status === 'ready', JSON.stringify(pdfStatus))
  check('扫描版 PDF 产生切片', (pdfStatus.chunksCount ?? 0) >= 1, `chunks=${pdfStatus.chunksCount}`)

  // 8e. 文本型 PDF（pdf-lib 写入真实文本层 → 应走 pdfjs 直提，而非视觉兜底）
  const { PDFDocument: PDFDocument2, StandardFonts } = serverRequire('pdf-lib')
  const textDoc = await PDFDocument2.create()
  const helv = await textDoc.embedFont(StandardFonts.Helvetica)
  const textPage = textDoc.addPage([500, 200])
  textPage.drawText('Nginx buffer tuning: proxy_buffers 8 16k; proxy_busy_buffers_size 32k', {
    x: 30, y: 100, size: 11, font: helv,
  })
  const textPdfStatus = await uploadAndPoll('buffer-tuning.pdf', 'application/pdf', Buffer.from(await textDoc.save()))
  check('文本型 PDF 直提就绪', textPdfStatus.status === 'ready', JSON.stringify(textPdfStatus))
  check('文本型 PDF 产生切片', (textPdfStatus.chunksCount ?? 0) >= 1, `chunks=${textPdfStatus.chunksCount}`)

  // 8f. 新格式内容可被检索回答
  const r8a = await chat('公司 Q3 的预算是多少？从导入资料里查。')
  check('XLSX 内容被检索', toolNames(r8a.events).includes('search_imports') && r8a.text.includes('350'), r8a.text.slice(0, 120))
  const r8b = await chat('会议室打印机的 IP 是多少？从导入资料里查。')
  check('PPTX 内容被检索', toolNames(r8b.events).includes('search_imports') && r8b.text.includes('192.168.3.21'), r8b.text.slice(0, 120))
  const r8c = await chat('VPN 服务器地址是什么？从导入资料里查。')
  check('图片内容被检索', toolNames(r8c.events).includes('search_imports') && (r8c.text.includes('vpn.corp.local') || r8c.text.includes('51820')), r8c.text.slice(0, 120))

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 异常终止:', e)
  process.exit(1)
})
