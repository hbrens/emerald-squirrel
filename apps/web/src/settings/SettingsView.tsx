import { useState } from 'react'
import { deleteJSON, postJSON, putJSON, type ModelConfig } from '../api'
import ConfirmDialog from '../ui/ConfirmDialog'

type FormState = { name: string; baseUrl: string; apiKey: string; modelId: string }

const EMPTY_FORM: FormState = { name: '', baseUrl: '', apiKey: '', modelId: '' }

export default function SettingsView(props: { models: ModelConfig[]; onChange: () => void }) {
  const [form, setForm] = useState<FormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ModelConfig | null>(null)

  const startCreate = () => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM })
    setTestResult(null)
  }

  const startEdit = (m: ModelConfig) => {
    setEditingId(m.id)
    setForm({ name: m.name, baseUrl: m.baseUrl, apiKey: m.apiKey, modelId: m.modelId })
    setTestResult(null)
  }

  const closeForm = () => {
    setForm(null)
    setEditingId(null)
  }

  const save = async () => {
    if (!form) return
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
      setNotice('名称、Base URL、模型 ID 不能为空')
      return
    }
    try {
      if (editingId) {
        await putJSON(`/api/models/${editingId}`, form)
      } else {
        await postJSON('/api/models', form)
      }
      closeForm()
      props.onChange()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const test = async () => {
    if (!form) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await postJSON<{ ok: boolean; latencyMs?: number; error?: string }>(
        '/api/models/test',
        { baseUrl: form.baseUrl, apiKey: form.apiKey, modelId: form.modelId }
      )
      setTestResult(r.ok ? `连接成功（${r.latencyMs} ms）` : `连接失败：${r.error}`)
    } catch (e) {
      setTestResult(`连接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  const remove = async (m: ModelConfig) => {
    try {
      await deleteJSON(`/api/models/${m.id}`)
      props.onChange()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const setDefault = async (m: ModelConfig) => {
    try {
      await putJSON(`/api/models/${m.id}`, { isDefault: true })
      props.onChange()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="settingsview">
      <div className="settings-head">
        <div>
          <div className="settings-title">模型设置</div>
          <div className="settings-sub">
            管理对话用的大模型；embedding 与图片提取模型仍由 .env 配置。未添加任何模型时，对话走 .env 兜底。
          </div>
        </div>
        {form === null && (
          <button className="btn primary" onClick={startCreate}>
            ＋ 添加模型
          </button>
        )}
      </div>
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}（点击关闭）
        </div>
      )}

      {form !== null && (
        <div className="modelform">
          <label>
            显示名称
            <input
              value={form.name}
              placeholder="如 gpt-5.6-sol"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              value={form.baseUrl}
              placeholder="OpenAI 兼容地址，如 http://…/v1"
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={form.apiKey}
              placeholder="留空表示不携带鉴权头"
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </label>
          <label>
            模型 ID
            <input
              value={form.modelId}
              placeholder="上游 /chat/completions 的 model 参数"
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </label>
          <div className="modelform-actions">
            <button
              className="btn"
              disabled={testing || !form.baseUrl.trim() || !form.modelId.trim()}
              onClick={() => void test()}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && <span className="testresult">{testResult}</span>}
            <span className="spacer" />
            <button className="btn" onClick={closeForm}>
              取消
            </button>
            <button className="btn primary" onClick={() => void save()}>
              {editingId ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      )}

      <div className="modellist">
        {props.models.map((m) => (
          <div key={m.id} className="modelcard">
            <div className="modelcard-main">
              <div className="modelcard-name">
                {m.name}
                {m.isDefault && <span className="defaultbadge">默认</span>}
              </div>
              <div className="modelcard-meta">
                {m.modelId} · {m.baseUrl}
              </div>
            </div>
            <div className="rowactions">
              {!m.isDefault && (
                <button className="btn small" onClick={() => void setDefault(m)}>
                  设为默认
                </button>
              )}
              <button className="btn small" onClick={() => startEdit(m)}>
                编辑
              </button>
              <button className="btn small danger" onClick={() => setPendingDelete(m)}>
                删除
              </button>
            </div>
          </div>
        ))}
        {props.models.length === 0 && form === null && (
          <div className="empty-hint">还没有添加模型，当前使用 .env 兜底配置</div>
        )}
      </div>
      {pendingDelete && (
        <ConfirmDialog
          message={`删除模型「${pendingDelete.name}」？正在进行的对话不受影响。`}
          onConfirm={() => {
            void remove(pendingDelete)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
