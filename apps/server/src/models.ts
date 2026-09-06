import { randomUUID } from 'node:crypto'
import { db } from './db.ts'

export type ModelRow = {
  id: string
  name: string
  base_url: string
  api_key: string
  model_id: string
  is_default: number
  created_at: string
  updated_at: string
}

export type ModelInput = {
  name: string
  baseUrl: string
  apiKey?: string
  modelId: string
}

export type ResolvedModel = {
  baseUrl: string
  apiKey: string
  modelId: string
  // 展示名快照（写入 messages.model）；.env 兜底时等于 modelId
  name: string
}

function now(): string {
  return new Date().toISOString()
}

export function listModels(): ModelRow[] {
  return db
    .prepare('SELECT * FROM model_configs ORDER BY is_default DESC, created_at ASC')
    .all() as ModelRow[]
}

export function getModel(id: string): ModelRow | undefined {
  return db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id) as ModelRow | undefined
}

export function nameExists(name: string, excludeId?: string): boolean {
  const row = excludeId
    ? db.prepare('SELECT id FROM model_configs WHERE name = ? AND id != ?').get(name, excludeId)
    : db.prepare('SELECT id FROM model_configs WHERE name = ?').get(name)
  return row !== undefined
}

function clearOtherDefaults(id: string): void {
  db.prepare('UPDATE model_configs SET is_default = 0 WHERE id != ?').run(id)
  db.prepare('UPDATE model_configs SET is_default = 1 WHERE id = ?').run(id)
}

export function createModel(input: ModelInput & { isDefault?: boolean }): ModelRow {
  const row: ModelRow = {
    id: randomUUID(),
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey ?? '',
    model_id: input.modelId,
    is_default: 0,
    created_at: now(),
    updated_at: now(),
  }
  db.transaction(() => {
    // 首个模型自动成为默认
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM model_configs').get() as { n: number }
    row.is_default = input.isDefault || n === 0 ? 1 : 0
    db.prepare(
      `INSERT INTO model_configs (id, name, base_url, api_key, model_id, is_default, created_at, updated_at)
       VALUES (@id, @name, @base_url, @api_key, @model_id, @is_default, @created_at, @updated_at)`
    ).run(row)
    if (row.is_default) clearOtherDefaults(row.id)
  })()
  return row
}

export function updateModel(
  id: string,
  patch: Partial<ModelInput> & { isDefault?: boolean }
): ModelRow | undefined {
  const existing = getModel(id)
  if (!existing) return undefined
  db.transaction(() => {
    db.prepare(
      `UPDATE model_configs SET name = @name, base_url = @base_url, api_key = @api_key,
       model_id = @model_id, updated_at = @updated_at WHERE id = @id`
    ).run({
      id,
      name: patch.name ?? existing.name,
      base_url: patch.baseUrl ?? existing.base_url,
      api_key: patch.apiKey ?? existing.api_key,
      model_id: patch.modelId ?? existing.model_id,
      updated_at: now(),
    })
    if (patch.isDefault) clearOtherDefaults(id)
  })()
  return getModel(id)
}

export function deleteModel(id: string): boolean {
  return db.transaction(() => {
    const existing = getModel(id)
    if (!existing) return false
    db.prepare('DELETE FROM model_configs WHERE id = ?').run(id)
    if (existing.is_default) {
      // 默认被删时把最早剩余的一个顶上，保持始终有默认
      const first = db
        .prepare('SELECT id FROM model_configs ORDER BY created_at ASC LIMIT 1')
        .get() as { id: string } | undefined
      if (first) db.prepare('UPDATE model_configs SET is_default = 1 WHERE id = ?').run(first.id)
    }
    return true
  })()
}

export function resolveModel(modelId?: string | null): ResolvedModel | undefined {
  if (modelId) {
    const row = getModel(modelId)
    if (!row) return undefined
    return { baseUrl: row.base_url, apiKey: row.api_key, modelId: row.model_id, name: row.name }
  }
  const def = db
    .prepare('SELECT * FROM model_configs WHERE is_default = 1')
    .get() as ModelRow | undefined
  if (def) return { baseUrl: def.base_url, apiKey: def.api_key, modelId: def.model_id, name: def.name }
  // 未配置任何模型：沿用 .env（与旧版行为一致）
  const envModel = process.env.LLM_MODEL ?? 'gpt-5.6-sol'
  return {
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:29005/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    modelId: envModel,
    name: envModel,
  }
}

export async function testModelConfig(input: {
  baseUrl: string
  apiKey?: string
  modelId: string
}): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now()
  try {
    const res = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      return { ok: false, error: `上游响应 ${res.status} ${detail}` }
    }
    return { ok: true, latencyMs: Date.now() - started }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
