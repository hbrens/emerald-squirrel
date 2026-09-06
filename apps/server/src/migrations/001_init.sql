PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'topic'
             CHECK (kind IN ('topic', 'inbox')),
  meta       TEXT NOT NULL DEFAULT '{}'
             CHECK (json_valid(meta)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content_md,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'trigram'
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

CREATE TABLE imports (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'ready', 'failed')),
  error        TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  uploaded_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX imports_sha256 ON imports(sha256);
CREATE UNIQUE INDEX imports_filename ON imports(filename);
CREATE INDEX imports_status ON imports(status);

CREATE TABLE import_chunks (
  id          TEXT PRIMARY KEY,
  import_id   TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX chunks_import ON import_chunks(import_id, chunk_index);

CREATE VIRTUAL TABLE import_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL
               CHECK (role IN ('user', 'assistant', 'tool')),
  content      TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX messages_session ON messages(session_id, seq);
