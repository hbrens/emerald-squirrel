-- 模型配置：设置页管理的对话 LLM（名称唯一，至多一个默认）
CREATE TABLE model_configs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  base_url   TEXT NOT NULL,
  api_key    TEXT NOT NULL DEFAULT '',
  model_id   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 每条 assistant 消息记录生成它的模型名快照（可空：旧数据与 .env 兜底轮次不追溯）
ALTER TABLE messages ADD COLUMN model TEXT;
