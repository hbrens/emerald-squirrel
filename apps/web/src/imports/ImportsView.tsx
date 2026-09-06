import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteJSON, formatBytes, getJSON, postFormData, type ImportSummary } from '../api'

const ACCEPT = '.pdf,.docx,.xlsx,.xls,.pptx,.png,.jpg,.jpeg,.webp,.gif,.md,.txt,.html,.htm'

export default function ImportsView() {
  const [items, setItems] = useState<ImportSummary[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const filesRef = useRef<Map<string, File>>(new Map())
  const timersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set())

  const refresh = useCallback(() => {
    getJSON<ImportSummary[]>('/api/imports')
      .then(setItems)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    return () => {
      for (const t of timersRef.current) clearInterval(t)
    }
  }, [refresh])

  const patchItem = useCallback((summary: ImportSummary) => {
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === summary.id)
      if (i < 0) return [summary, ...prev]
      const next = [...prev]
      next[i] = summary
      return next
    })
  }, [])

  const poll = useCallback(
    (id: string) => {
      let tries = 0
      const timer = setInterval(() => {
        tries++
        getJSON<ImportSummary>(`/api/imports/${id}`)
          .then((s) => {
            patchItem(s)
            if (s.status === 'ready' || s.status === 'failed' || tries > 150) {
              clearInterval(timer)
              timersRef.current.delete(timer)
            }
          })
          .catch(() => {
            clearInterval(timer)
            timersRef.current.delete(timer)
          })
      }, 2000)
      timersRef.current.add(timer)
    },
    [patchItem]
  )

  const upload = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        try {
          const fd = new FormData()
          fd.append('file', file)
          const summary = await postFormData<ImportSummary>('/api/imports/upload', fd)
          patchItem(summary)
          if (summary.dedup) {
            setNotice(`「${summary.filename}」内容已存在，未重复导入`)
          } else {
            filesRef.current.set(summary.id, file)
            poll(summary.id)
          }
        } catch (e) {
          setNotice(`「${file.name}」上传失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    },
    [patchItem, poll]
  )

  const retry = useCallback(
    (item: ImportSummary) => {
      const file = filesRef.current.get(item.id)
      if (!file) {
        setNotice('找不到原始文件，请重新上传')
        return
      }
      void upload([file])
    },
    [upload]
  )

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm('删除该导入文档及其全部切片？')) return
      try {
        await deleteJSON(`/api/imports/${id}`)
        filesRef.current.delete(id)
        setItems((prev) => prev.filter((x) => x.id !== id))
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

  return (
    <div className="importsview">
      <div
        className={`uploadzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files)
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="upload-main">拖拽文件到这里，或点击选择</div>
        <div className="upload-sub">支持 PDF / DOCX / XLSX / PPTX / 图片（走视觉模型）/ MD / TXT / HTML，单文件 50 MB</div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}（点击关闭）
        </div>
      )}
      <table className="importtable">
        <thead>
          <tr>
            <th>文件名</th>
            <th>大小</th>
            <th>状态</th>
            <th>切片</th>
            <th>上传时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td className="filename">{it.filename}</td>
              <td>{formatBytes(it.size)}</td>
              <td>
                <span className={`status ${it.status}`}>
                  {it.status === 'processing' ? '处理中' : it.status === 'ready' ? '就绪' : '失败'}
                </span>
                {it.error && <div className="importerror">{it.error}</div>}
              </td>
              <td>{it.chunksCount}</td>
              <td>{new Date(it.uploadedAt).toLocaleString('zh-CN')}</td>
              <td className="rowactions">
                {it.status === 'failed' && (
                  <button className="btn small" onClick={() => retry(it)}>
                    重试
                  </button>
                )}
                <button className="btn small danger" onClick={() => void remove(it.id)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <div className="empty-hint">还没有导入文档</div>}
    </div>
  )
}
