# 11 · 工具 Schema（OpenAI function calling）

本篇给出 7 个工具的完整 function calling JSON schema，可直接粘进 `tools: [...]` 发给 LLM。语义层（什么时候调、调用顺序、纪律）见 [04-write-discipline.md](04-write-discipline.md) 与 [05-tools.md](05-tools.md)；本篇是 schema 层，是发给 LLM 的最终形态。

description 的措辞从 04 的纪律推导——description 是 LLM 行为的一部分，改 description 前先改 04。

## 与 05 的一处差异（显式标注）

`write_note` 补了 `title` 参数。05 的签名 `write_note(id, content_md)` 没有 title，但 04 新建流程第 1 步就是「决定 title」，DB 也有 `notes.title` 列（10）——title 必须由 LLM 在调用时给出。这是从需求正推的补全，不是新需求。

## 总览

| 工具 | 层 | 需确认 | 页内锚点 |
|---|---|---|---|
| `list_notes` | 笔记 | 否 | #list_notes |
| `read_note` | 笔记 | 否 | #read_note |
| `search_notes` | 笔记 | 否 | #search_notes |
| `write_note` | 笔记 | **是** | #write_note |
| `delete_note` | 笔记 | **是** | #delete_note |
| `record_inbox` | 笔记 | **是** | #record_inbox |
| `search_imports` | 导入 | 否 | #search_imports |

确认机制（proposal → diff → 用户点确认）由服务端拦截实现，schema 层无感知（05）。

## list_notes

```json
{
  "type": "function",
  "function": {
    "name": "list_notes",
    "description": "列出知识库全部笔记（id、title、一句话定位、更新时间），按 title 排序。需要了解库里有什么、或判断新信息是否已有归属主题时调用。",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
}
```

返回：

```json
{ "notes": [{ "id": "uuid", "title": "nginx 502 排查", "summary": "正文第一段截断约80字符…", "updated_at": "2026-09-06T12:00:00.000Z" }] }
```

## read_note

```json
{
  "type": "function",
  "function": {
    "name": "read_note",
    "description": "读取指定笔记的完整 markdown 内容。修改已有笔记前必须先调用本工具读旧文，禁止不读旧文直接 write_note。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "笔记 id（来自 search_notes 或 list_notes）" }
      },
      "required": ["id"]
    }
  }
}
```

返回：

```json
{ "id": "uuid", "title": "nginx 502 排查", "content_md": "# …", "created_at": "2026-09-06T12:00:00.000Z", "updated_at": "2026-09-06T12:00:00.000Z" }
```

错误：`{ "error": "笔记不存在: <id>" }`（LLM 收到后应重新 search_notes，04 失败行为）。

## search_notes

```json
{
  "type": "function",
  "function": {
    "name": "search_notes",
    "description": "全文搜索笔记标题与正文，返回命中片段（非全文）。写入新信息前必须先调用本工具查重：从用户内容里抽 1-3 个核心词作 query，不要把整句话当 query。需要全文再调 read_note。",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "1-3 个核心关键词" },
        "count": { "type": "integer", "description": "最多返回条数，默认 5", "default": 5, "minimum": 1, "maximum": 20 }
      },
      "required": ["query"]
    }
  }
}
```

返回：

```json
{ "hits": [{ "id": "uuid", "title": "nginx 502 排查", "snippet": "…命中前后约200字符…", "score": -1.23 }] }
```

`score` 为 FTS5 rank（越小越相关）。

## write_note

```json
{
  "type": "function",
  "function": {
    "name": "write_note",
    "description": "新建或整体重写一篇主题笔记（写入前会向用户展示 diff 并等待确认）。新建：id 传 null，title 必填（中文短句覆盖主题，如「nginx 502 排查」，不要「关于 X 的笔记」这类前缀）。更新：id 必填且必须先 read_note 读旧文，把新信息合并进旧文合适章节后提交新全文，不要只 append 到文末。仅时间流水内容不要用本工具，用 record_inbox。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": ["string", "null"], "description": "已有笔记 id；新建传 null" },
        "title": { "type": "string", "description": "笔记标题（新建必填；更新时可同时改标题）" },
        "content_md": { "type": "string", "description": "完整 markdown 正文（整体替换，非增量）" }
      },
      "required": ["id", "title", "content_md"]
    }
  }
}
```

返回（用户确认后）：

```json
{ "ok": true, "id": "uuid", "title": "nginx 502 排查" }
```

用户取消：`{ "error": "用户取消或未确认此操作" }`——LLM 不重试，输出「已取消」（04 失败行为）。

## delete_note

```json
{
  "type": "function",
  "function": {
    "name": "delete_note",
    "description": "删除一篇笔记（会向用户展示将删除的标题并等待确认）。典型场景：整理收件箱时删除已合并进主题笔记的 inbox 条目。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "笔记 id" }
      },
      "required": ["id"]
    }
  }
}
```

返回：`{ "ok": true, "id": "uuid", "title": "删除前快照" }`

## record_inbox

```json
{
  "type": "function",
  "function": {
    "name": "record_inbox",
    "description": "快速记一条时间流水到收件箱（会向用户展示内容并等待确认）。仅用于「今天做了 X」「临时备忘」这类没有未来翻查需求的流水；主题性知识必须走 write_note。",
    "parameters": {
      "type": "object",
      "properties": {
        "content": { "type": "string", "description": "流水内容（自动带时间戳）" }
      },
      "required": ["content"]
    }
  }
}
```

返回：`{ "ok": true, "id": "uuid", "timestamp": "2026-09-06T12:00:00.000Z" }`

实现上即写 `notes` 表 `kind='inbox'` 的记录（10），title 由服务端取 content 前 24 字符。

## search_imports

```json
{
  "type": "function",
  "function": {
    "name": "search_imports",
    "description": "在用户上传的导入文档（只读参考资料）中做语义检索，返回相关片段与出处。导入层不可写；回答依赖上传资料的问题时调用。每个结果只有片段，没有全文。",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "自然语言检索问题" },
        "top_k": { "type": "integer", "description": "返回片段数，默认 5", "default": 5, "minimum": 1, "maximum": 10 }
      },
      "required": ["query"]
    }
  }
}
```

返回：

```json
{ "hits": [{
    "doc_title": "design-spec.pdf",
    "chunk_text": "…chunk 原文截断约500字符…",
    "score": 0.87,
    "source_path": "design-spec.pdf",
    "chunk_index": 3
}] }
```

Ollama 不可达时：`{ "error": "embedding 服务不可达，导入层暂不可检索" }`（LLM 应如实告知用户，不要编造答案）。

## 通用错误格式

工具执行失败一律返回 `{ "error": "人类可读描述" }`（05 已定），禁止 stack trace。LLM 收到 error 后的纠错路径见 04「失败行为」。

## 组装示例

```typescript
import tools from './tools.json'  // 本篇 7 个 schema 原样存为 JSON

const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  body: JSON.stringify({ model, messages, tools, stream: true }),
})
```

服务端在解析到 `tool_calls` 后按 05 的流程执行：读工具直接跑；`NEEDS_CONFIRM = { write_note, delete_note, record_inbox }` 先走 proposal 确认（09）。
