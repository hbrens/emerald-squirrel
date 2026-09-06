# 05 · 工具接口规范

LLM 通过 function calling 调用工具。本篇定义所有工具的接口、安全机制、确认机制。

## 工具总览

| 工具 | 层 | 读写 | 需确认 |
|---|---|---|---|
| `list_notes` | 笔记 | 读 | 否 |
| `read_note` | 笔记 | 读 | 否 |
| `search_notes` | 笔记 | 读 | 否 |
| `write_note` | 笔记 | 写 | **是** |
| `delete_note` | 笔记 | 写 | **是** |
| `record_inbox` | 笔记（流水） | 写 | **是** |
| `search_imports` | 导入 | 读 | 否 |

**关键边界**：导入层只有 `search_imports` 一个工具，无写工具——LLM 物理上无法修改导入文档。

## 笔记层工具定义

### list_notes

```python
list_notes() -> {
  notes: [{
    id: str,
    title: str,
    summary: str,        # 正文第一段截断 ~80 字符
    updated_at: int
  }]
}
```

按 title 排序返回。代替 index.md（详见 04）。

### read_note

```python
read_note(id: str) -> {
  id: str,
  title: str,
  content_md: str,       # 完整 markdown
  created_at: int,
  updated_at: int
}
```

### search_notes

```python
search_notes(query: str, count: int = 5) -> {
  hits: [{
    id: str,
    title: str,
    snippet: str,         # 命中片段 ~200 字符
    score: float          # FTS5 rank
  }]
}
```

不返回全文，LLM 想看全文调 `read_note(id)`。

### write_note

```python
write_note(id: str | null, content_md: str) -> {
  ok: bool,
  id: str,                # 新建时生成
  path: str               # 笔记逻辑路径（如 "topics/nginx-502-排查"）
}
```

- `id = null` → 新建
- `id` 存在 → 整体替换（merge 由 LLM 在 prompt 层处理，工具层只做整体替换）

**需确认**：proposal → diff preview → 用户点确认 → 执行。

### delete_note

```python
delete_note(id: str) -> {
  ok: bool,
  id: str,
  title: str              # 删除前快照
}
```

**需确认**：proposal → 显示要删的 title → 用户点确认。

### record_inbox

```python
record_inbox(content: str) -> {
  ok: bool,
  id: str,
  timestamp: str
}
```

写 inbox_notes 表，自动带时间戳。**需确认**（流水也是写入）。

## 导入层工具定义

### search_imports

```python
search_imports(query: str, top_k: int = 5) -> {
  hits: [{
    doc_title: str,       # 原文档名
    chunk_text: str,      # chunk 原文截断 ~500 字符
    score: float,
    source_path: str,     # 原文件名 + 内部 id
    chunk_index: int
  }]
}
```

详见 [03-imports-layer.md](03-imports-layer.md)。

## 路径安全

笔记层在 DB 里，没有「路径越界」问题——`write_note(id, content)` 用 id 定位，不接受路径参数。

**例外**：如果未来加 `read_note_by_path` 或人工编辑文件接口，需路径安全检查（参考 htwm-wiki `safeDocPath`）。

当前设计无此需求，不引入。

## 确认机制

### 流程

```
LLM 调 write_note / delete_note / record_inbox
    ↓
后端拦截，发 proposal 给前端
    ↓
前端展示 diff / newFile / delete preview
    ↓
用户点「确认」or「取消」
    ↓
后端 resolveConfirm(id, approve)
    ↓
批准 → 执行工具；拒绝 → 返回"用户取消"给 LLM
```

### Proposal 数据结构

```typescript
type Proposal = {
  id: string,              // uuid
  tool: 'write_note' | 'delete_note' | 'record_inbox',
  args: Record<string, unknown>,
  preview: {
    diff?: { t: '+' | '-', l: string }[],   // write_note 改已有
    newFile?: string,                         // write_note 新建
    note?: string,                            // record_inbox
    delete?: string                           // delete_note（title）
  }
}
```

### 超时

120s 未确认自动拒绝（参考 htwm-wiki llm.ts:11 `CONFIRM_TIMEOUT_MS`）。

### diff 算法

LCS（最长公共子序列），参考 htwm-wiki docs.ts:86 `lineDiff`。文本量大时降级为「全删 + 全加」展示。

## 错误回喂

工具执行失败时，结果格式：

```python
{ error: "错误描述" }
```

LLM 收到后能自我纠错（如 id 不存在 → 重新 search）。

**禁止**：把 stack trace 喂给 LLM（污染上下文）。只回喂人类可读的 error message。

## 工具循环

参考 htwm-wiki llm.ts:83 `chatStream`，最多 10 轮工具调用。每轮：

1. LLM 输出（可能含 tool_calls）
2. 解析 tool_calls，串行执行（写工具需确认）
3. tool result 喂回 LLM
4. 进入下一轮
5. LLM 不再调工具 → 输出最终回复 → 结束

## 上下文截断

参考 htwm-wiki 当前 `slice(-30)`，但本设计要持久化 tool_calls + 结果（决策 1 配套），所以截断要按**工具回合边界**：

- 一次工具回合 = assistant(tool_calls) + tool(result) + assistant(总结)
- 截断时遇到 tool_calls 必须保留对应的 tool result
- naive slice 会切出孤儿 tool_calls，OpenAI API 会报错

**实现**：从尾部往前数 30 条消息，遇到 tool_calls/tool 不在边界切断；如果切断点是 tool_calls 但下一条不是 tool，回退到 tool_calls 之前。

## 扩展原则

### 新增写入类工具

- 必须加入 `NEEDS_CONFIRM` 集合
- 必须实现 `buildPreview` 生成 diff/preview
- 必须考虑路径安全（如果接受路径参数）

### 新增读类工具

- 直接加，无需确认
- 注意返回大小（不返回全文，避免上下文爆炸）

## 未来候选工具（不实施，仅记录）

- `fetch_url(url)`：抓取网页正文 → 转 markdown → 调 write_note 落库。补 htwm-wiki 缺的 URL 抓取能力。
- `move_note(id, new_title)`：重命名笔记。
- `read_import_chunk(chunk_id)`：LLM 想看导入文档某个 chunk 的全文。
- `list_imports()`：列导入文档（参考 open-webui 的 files 接口）。

加任何工具前，先回 [04-write-discipline.md](04-write-discipline.md) 检查是否影响写入纪律。
