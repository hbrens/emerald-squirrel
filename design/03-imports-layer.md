# 03 · Part 2 导入层

导入层是用户上传原始文档、LLM 只检索不写的部分。借 open-webui 的成熟检索管线，但简化到局域网单机部署。

## 总览

```
用户上传文件
    ↓
[文本提取]  PDF/DOCX/MD/TXT/HTML → 纯文本
    ↓
[切分]      递归字符切分 chunk ~800 token, overlap ~100
    ↓
[Embedding] Ollama nomic-embed-text（本地）
    ↓
[向量存储]  SQLite + sqlite-vec
    ↓
[检索]      search_imports(query, top_k) 返回片段 + 出处
```

LLM 调 `search_imports` 拿到片段就能引用，不返回全文（避免上下文爆炸）。

## Q4 上传接口与格式支持

**决策**：先支持 PDF / DOCX / MD / TXT / HTML，按需扩展

### 接口

- `POST /api/imports/upload`：multipart/form-data，字段 `file`
- MIME 白名单：`application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/markdown`, `text/plain`, `text/html`
- 大小限制：单文件 50 MB（可调）
- 返回：`{id, filename, size, status: "processing" | "ready" | "failed"}`

### 列表 / 删除

- `GET /api/imports`：返回所有已上传文档（id, filename, size, status, uploaded_at, chunks_count）
- `DELETE /api/imports/:id`：删文档 + 关联 chunks + 向量

### 暂不支持的格式

- PPT / XLS / EPUB / 图片 OCR：后续按需加

## Q5 文本提取

**决策**：每格式独立提取器

| 格式 | 库 | 备注 |
|---|---|---|
| PDF | `pdf-parse` 或 `pdfjs-dist` | pdf-parse 简单；pdfjs-dist 更稳但重 |
| DOCX | `mammoth` | 转为 HTML 后去标签 |
| MD/TXT | 原文本 | 直接读 |
| HTML | `cheerio` 去标签 | 保留 `pre` / `code` 内容 |

### 提取流程

1. 后端收到文件 → 存到 `data/uploads/<uuid>.<ext>`（保留原始文件，可选）
2. 调对应提取器 → 得到纯文本
3. 调切分函数 → 得到 chunks 数组
4. 调 embedding（Q7）→ 得到向量数组
5. 写入 SQLite（chunks 表 + 向量表）

### 失败处理

- 提取失败（PDF 加密 / 格式损坏）：状态置 `failed`，错误信息入库
- 不阻塞其他上传

## Q6 切分策略

**决策**：递归字符切分，chunk size ~800 token，overlap ~100

### 实现

参考 LangChain RecursiveCharacterTextSplitter 思路：

1. 优先按 `\n\n`（段落）切
2. 段落仍超 chunk size，按 `\n` 切
3. 还超，按句号 `。` / `.` 切
4. 最后按字符兜底

每个 chunk 保留 ~100 token overlap，避免切断语义。

### 中文处理

- 中文按段落 + 句号兜底即可
- 不上 jieba 分词（embedding 模型自己处理）

### Chunk 元数据

每个 chunk 存：

```sql
CREATE TABLE import_chunks (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,        -- 关联 imports 表
  chunk_index INTEGER,            -- 第几块
  text TEXT NOT NULL,             -- 原文本
  embedding BLOB,                 -- 向量（sqlite-vec 索引）
  token_count INTEGER,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  status TEXT,                    -- processing/ready/failed
  error TEXT,
  uploaded_at INTEGER,
  total_chunks INTEGER
);
```

## Q7 Embedding 模型

**决策**：可配置，默认 Ollama 本地 `nomic-embed-text`

### 理由

- 局域网自用，无外部 API 依赖
- htwm-wiki AGENTS.md 提过 Ollama 由用户管理（已在跑），可直接复用
- `nomic-embed-text` 768 维，性能/质量平衡好

### 配置

环境变量：

```bash
EMBEDDING_BASE_URL=http://127.0.0.1:11434  # Ollama 默认
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIM=768
```

### 备选

- OpenAI `text-embedding-3-small`：要外网，要付费
- 其他 Ollama 模型：`bge-m3`（多语言强）、`mxbai-embed-large`

## Q8 向量存储

**决策**：SQLite + sqlite-vec 扩展

### 理由

- 与笔记层 / 会话层同 SQLite，单机部署最简
- 不引入额外服务（Qdrant/pgvector 都要多一个进程）
- sqlite-vec 是 SQLite 官方推荐的向量扩展，纯 C，安装简单

### 安装

```bash
# Node 绑定
npm install sqlite-vec
# 或 better-sqlite3 + 加载扩展
```

### 索引

```sql
-- sqlite-vec 虚拟表
CREATE VIRTUAL TABLE import_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);
```

### 检索 SQL（伪）

```sql
SELECT chunk_id, distance
FROM import_chunks_vec
WHERE embedding MATCH ?  -- 用户查询的向量
ORDER BY distance
LIMIT 5;
```

然后 join `import_chunks` 拿原文。

## Q9 检索接口

**决策**：`search_imports(query, top_k=5)` 返回 `{doc_title, chunk_text, score, source_path}`

### 工具定义

```python
search_imports(query: str, top_k: int = 5) -> {
  hits: [{
    doc_title: str,           -- 原文档名
    chunk_text: str,          -- chunk 原文（截断到 ~500 字符）
    score: float,             -- 相似度分数
    source_path: str,         -- 原文件名 / 内部 id
    chunk_index: int          -- 第几块（可选）
  }]
}
```

### 流程

1. LLM 调 `search_imports(query)`
2. 后端：`query` → Ollama embedding → 向量
3. sqlite-vec 检索 top_k chunks
4. join imports 表拿 filename
5. 返回结构化结果

### 不返回全文

每个 chunk 只返回 ~500 字符截断 + 出处。LLM 想看全文？暂不提供（避免上下文爆炸）。如果真需要，未来加 `read_import_chunk(id)` 工具。

## 与 open-webui 的对比

| 维度 | open-webui | 本设计 |
|---|---|---|
| 文档存储 | DB + 文件 | DB + 文件（同） |
| 提取库 | unstructured / tika | pdf-parse / mammoth / cheerio（更轻） |
| 切分 | LangChain RecursiveCharacterTextSplitter | 自实现简化版 |
| Embedding | OpenAI / Ollama | Ollama（默认） |
| 向量库 | Chroma / Qdrant / pgvector | sqlite-vec（单机最简） |
| 检索接口 | RAG pipeline 内嵌 | LLM 工具 `search_imports` |
| 用户操作 | Web 上传 UI | Web 上传 UI（同） |

## 待定项

- **是否保留原始文件**：导入后是否删 `data/uploads/` 里的原文件？倾向保留（用于重新切分），但占空间。可加配置项 `KEEP_ORIGINAL=true/false`。
- **重新切分**：如果切分策略改了，已导入的文档要不要重跑？需要个 admin 接口（暂不做）。
- **删除时清理**：删 import 时 cascade 删 chunks + 向量 + 原文件（如果保留）。
