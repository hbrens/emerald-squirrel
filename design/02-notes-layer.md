# 02 · Part 1 笔记层

笔记层是 LLM 可读写的部分，类似 htwm-wiki 的 docs/ 或 open-webui 的 notes。这层承载「写入即维护」纪律（详见 04）。

## 存储选型（Q1）

**决策**：SQLite + markdown 字符串字段（open-webui notes 路线）

### 表结构（草案）

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,           -- uuid
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,      -- markdown 正文
  meta JSON,                     -- {tags, kind, ...} 可选
  created_at INTEGER,            -- epoch ns
  updated_at INTEGER
);

CREATE TABLE inbox_notes (       -- 收件箱（流水性内容）
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER
);
```

或者更简单——只一个 `notes` 表，用 `meta.kind` 区分 `topic` / `inbox`。倾向后者，避免双表。

### 为什么选 DB 而不是文件

| 维度 | DB | 文件 + git |
|---|---|---|
| LLM 写入 | 工具调 `write_note(id, content)` 直接收口 | LLM 写文件，要路径安全 + 防穿越 |
| Line diff | DB 拿旧 content 算 diff，纯内存 | 同样要读旧文件，IO 成本 |
| Undo（已决定不用 git） | 自建 revision 表（保留前 N 版） | .trash/ 备份 |
| 多笔记结构化查询（按 tag 等） | SQL 天然支持 | 全量扫描模拟 |
| 人工直接编辑 | 需要管理后台（前端 DocView 只读，要加编辑） | vim/Obsidian 直接改 |
| 可移植（VitePress 等消费） | 需要导出 | 文件直接吃 |

**取舍说明**：

- 用户已说「不强制 md 存储」+「不用 git」——文件方案的两个核心优势（diff/undo、人工编辑）都退化了
- DB 便于结构化查询（笔记层是 LLM 写入高频场景，未来可能加 tag/分类）
- 人工编辑入口：当前设计是 LLM 通过 chat 写，人工想改的话用前端编辑器（待补，详见 06）；或者后端加导出/导入接口

### 备选方案（不推荐）

- markdown 文件 + .trash/ undo（htwm-wiki 路线）：与「不用 git」一致，但和「笔记层不强制 md」相悖——除非用户改主意
- 纯文件无 undo：太激进，丢后悔药

## 检索策略（Q2）

**决策**：纯文本搜索（SQLite LIKE 或 FTS5），不上向量

### 实现

- **LIKE**：`WHERE title LIKE '%q%' OR content_md LIKE '%q%'`，简单，无需额外扩展
- **FTS5**：建虚拟表 `notes_fts`，触发器同步；中文分词需要 `simple` 或自定义 tokenizer

**推荐 FTS5**——笔记量增长后 LIKE 性能差，FTS5 是 SQLite 原生支持的全文索引，不引入额外服务。中文分词用 `unicode61` + `tokenchars='-'` 兜底，或后续接 jieba。

### 工具接口

```python
search_notes(query: str, count: int = 5) -> {
  hits: [{id, title, snippet, score}]
}
```

返回片段（snippet）而非全文，避免上下文爆炸。LLM 拿到 id + title + 片段后，需要全文再调 `read_note(id)`。

### 为什么笔记层不上 RAG

- 笔记量小（百-千条），FTS5 性能完全够
- LLM 写入频繁，每次写入要重算 embedding 不值
- Line diff 是写入确认的核心 UI，纯文本天然可算
- 笔记是 LLM 自己写的，召回用 SQL 已经准确

## 写入纪律挂钩点

本层只挂存储和检索的钩子，纪律的语义详见 [04-write-discipline.md](04-write-discipline.md)。

| 钩子 | 触发点 | 行为 |
|---|---|---|
| 查重 | LLM 调 write_note 前 | 强制先 search_notes（写在 SYSTEM_PROMPT，详见 04） |
| 合并 | 命中已有同主题 | LLM 调 read_note → 输出新全文 → write_note(id, new_content) |
| 新建 | 无命中 | LLM 调 write_note(null, content)（null id 表示新建） |
| 收件箱 | 流水内容 | LLM 调 record_inbox(content) → 写 inbox_notes |
| 确认 | write_note / delete_note / record_inbox | 后端发 proposal → 前端点确认 → 落盘 |

## 与参考实现的对比

| 维度 | htwm-wiki docs/ | open-webui notes | 本设计 |
|---|---|---|---|
| 存储 | markdown 文件 + git | SQLite + JSON 字段（content.md） | SQLite + markdown 字段 |
| 检索 | 全量文件遍历 | SQL LIKE | FTS5 |
| LLM 工具 | list/read/search/write/record/delete | search/view/write/replace_content | list/read/search/write/record/delete |
| 写入纪律 | SYSTEM_PROMPT 模糊（"合并进合适章节"） | 无 | 强制规则（详见 04） |
| 写入确认 | proposal + diff 卡片 | 无 | proposal + diff 卡片（参考 htwm-wiki） |
| 版本管理 | git 自动 commit | 无 | 不用 git，可选 revision 表 undo |

## 笔记组织（目录结构）

笔记层在 DB 里，但**逻辑上有组织**（写在 SYSTEM_PROMPT，详见 04）：

- **topics**：主题性文档（如「nginx 502 排查」「async 取消机制」），有 title、有结构
- **inbox**：流水性记录（如「今天做了 X」），按日期聚合或单条入库
- **index**：是否需要？htwm-wiki 维护 `docs/index.md` 作为目录。DB 方案下，可以让 LLM 通过 `list_notes` 工具代替 index——或者保留一个 `notes_index` 表，LLM 写入时同步更新

**倾向**：不要 index 表，让 `list_notes` 工具按 title 排序返回。LLM 调一次工具即得全目录，比维护一个 index 表简单。如果 list_notes 返回项太多（>50），再加 tag 过滤。

## 待定项

- **是否引入 frontmatter（meta 字段）**：当前倾向不引入，无明确需求。如果未来要按 tag 过滤再加。
- **笔记编辑器**：前端 DocView 当前只读；要不要加人工编辑入口？详见 [06-frontend.md](06-frontend.md)。
- **undo 机制**：是否需要 revision 表保留前 N 版？等用户确认。
