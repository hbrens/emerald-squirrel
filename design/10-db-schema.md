# 10 · 数据库 Schema

本篇给出完整 SQLite DDL、索引与 migration 策略，可直接执行。字段语义见 [02-notes-layer.md](02-notes-layer.md)（笔记）与 [03-imports-layer.md](03-imports-layer.md)（导入）。

- 单库文件：`data/open-sesame.db`（笔记 + 导入 + 会话同库，01 已定）
- Node 侧用 `better-sqlite3`（需要 `loadExtension` 加载 sqlite-vec，见 08 已知坑）

## PRAGMA

```sql
PRAGMA journal_mode = WAL;      -- 读写并发（SSE 长连接 + 后台导入任务）
PRAGMA foreign_keys = ON;       -- cascade 删除依赖
PRAGMA user_version = 1;        -- migration 版本号
```

## 表总览

| 表 | 层 | 服务需求 |
|---|---|---|
| `notes` | 笔记层 | #3 笔记可写（topic + inbox 单表，02 已倾向） |
| `notes_fts` | 笔记层 | #3 检索（FTS5，02 已定） |
| `imports` | 导入层 | #3 导入只读 |
| `import_chunks` | 导入层 | #3 切分结果 |
| `import_chunks_vec` | 导入层 | #3 向量索引（sqlite-vec） |
| `sessions` | 会话层 | #2 chat 主交互 |
| `messages` | 会话层 | #2（存 tool_calls + 结果，01 已定） |

## 笔记层

```sql
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,            -- uuid
  title      TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'topic'
             CHECK (kind IN ('topic', 'inbox')),
  meta       TEXT NOT NULL DEFAULT '{}'   -- JSON，留位（tags 等，02 待定项）
             CHECK (json_valid(meta)),
  created_at TEXT NOT NULL,               -- ISO 8601
  updated_at TEXT NOT NULL
);

-- 全文索引（FTS5，内容随 notes 同步）
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content_md,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content_md)
  VALUES (new.rowid, new.title, new.content_md);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content_md)
  VALUES ('delete', old.rowid, old.title, old.content_md);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content_md)
  VALUES ('delete', old.rowid, old.title, old.content_md);
  INSERT INTO notes_fts(rowid, title, content_md)
  VALUES (new.rowid, new.title, new.content_md);
END;
```

说明：

- `kind` 区分 topic / inbox（02「单表 + meta.kind 区分」的定案；不建 `inbox_notes` 第二表）
- 检索 SQL：`SELECT n.id, n.title, snippet(notes_fts, 1, '', '', '…', 32) AS snippet, rank FROM notes_fts f JOIN notes n ON n.rowid = f.rowid WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`
- 中文分词用 `unicode61` 兜底，召回不足时换 `trigram`（08 已知坑，实施期验证）

## 导入层

```sql
CREATE TABLE imports (
  id           TEXT PRIMARY KEY,          -- uuid
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,             -- 内容 hash，去重依据（09）
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'ready', 'failed')),
  error        TEXT,                      -- failed 时的人类可读原因
  total_chunks INTEGER NOT NULL DEFAULT 0,
  uploaded_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX imports_sha256 ON imports(sha256);   -- 同内容只存一份
CREATE UNIQUE INDEX imports_filename ON imports(filename); -- 同名视为更新（09）
CREATE INDEX imports_status ON imports(status);            -- 列表按状态过滤

CREATE TABLE import_chunks (
  id          TEXT PRIMARY KEY,           -- uuid
  import_id   TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX chunks_import ON import_chunks(import_id, chunk_index);

-- 向量索引（sqlite-vec 虚拟表，768 维 = nomic-embed-text）
CREATE VIRTUAL TABLE import_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);
```

说明：

- 删除文档：`DELETE FROM imports WHERE id = ?` → chunks 级联删；vec 表手动 `DELETE FROM import_chunks_vec WHERE chunk_id IN (SELECT id FROM import_chunks WHERE import_id = ?)`（先删 vec 再删 imports）
- 「更新已导入文档」（09）：同事务内删旧 chunks + vec，插新 chunks + vec，更新 `sha256 / status / total_chunks / uploaded_at`
- 换 embedding 模型需全量重建（08 已知坑）；`EMBEDDING_DIM` 与 `FLOAT[768]` 必须对齐

## 会话层

```sql
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,            -- uuid 短码
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,          -- uuid
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,          -- 会话内单调递增
  role         TEXT NOT NULL
               CHECK (role IN ('user', 'assistant', 'tool')),
  content      TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,                      -- JSON：assistant 消息携带的工具调用及结果摘要
  created_at   TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX messages_session ON messages(session_id, seq);
```

说明：

- 独立 `messages` 表替代 htwm-wiki 的 JSON blob（htwm-wiki `db.ts:17` 的 `messages TEXT` 是要避开的，见 07）
- `tool_calls` JSON 形态：`[{"name":"search_notes","args":"...","resultPreview":"..."}]`——存**摘要**而非完整 tool result（完整结果只在当轮上下文里需要，落盘为时间线回放服务，06 已定）
- 截断按工具回合边界在应用层做（05/09），DB 永远存全量

## Migration 策略

- 版本号存 `PRAGMA user_version`
- 迁移文件：`apps/server/src/migrations/001_init.sql`、`002_xxx.sql`…按序执行
- 启动时：`user_version < N` 则在**单事务**内执行缺失迁移并更新版本号
- v1 即上文全部 DDL（`001_init.sql`）
- 向后只加不改：新列用 `ALTER TABLE ... ADD COLUMN ... DEFAULT`，不重建表

## 显式不建的表

| 候选 | 不建理由 |
|---|---|
| `note_revisions`（undo） | 02 待定项；08 已有每日 tar 备份兜底。未来要加：单表 `(note_id, content_md, created_at)` 保留前 N 版，不影响现有 schema |
| `notes_index`（目录） | 02 已定：`list_notes` 工具代替 index，不维护 |
| `users` / 权限表 | 局域网自用（README 需求） |
