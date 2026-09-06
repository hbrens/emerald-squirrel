# 09 · API 契约

本篇定义所有 HTTP endpoint、SSE 事件协议、错误格式，以及服务端侧的边界场景语义。开发者可按本篇直接写路由代码。

- 工具的 function calling schema 见 [11-tool-schemas.md](11-tool-schemas.md)
- 前端如何消费这些接口见 [12-frontend-structure.md](12-frontend-structure.md)
- DB 字段定义见 [10-db-schema.md](10-db-schema.md)

## 通用约定

- 除上传外，请求/响应均为 `application/json; charset=utf-8`
- 所有 id 均为 uuid 字符串（服务端生成）
- 时间戳为 ISO 8601 字符串（`2026-09-06T12:00:00.000Z`）
- 无鉴权（局域网自用，风险见 08）

### 错误格式

所有非 2xx 响应统一返回：

```json
{ "error": { "code": "NOTE_NOT_FOUND", "message": "笔记不存在" } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` | 参数缺失/格式错误（message 说明具体字段） |
| 404 | `NOT_FOUND` | 资源不存在（笔记/会话/导入文档/proposal） |
| 409 | `SESSION_BUSY` | 该会话有进行中的 turn（见「多标签页 / pending 新 turn」） |
| 413 | `FILE_TOO_LARGE` | 上传超过 50 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 上传格式不在白名单 |
| 500 | `INTERNAL_ERROR` | 服务端错误（message 为人类可读描述，不含 stack trace） |
| 502 | `UPSTREAM_ERROR` | LLM 网关 / Ollama 不可达 |

`message` 面向用户可读；`code` 面向程序分支。

## Endpoint 总览

| 方法 | 路径 | 用途 | 服务需求 |
|---|---|---|---|
| POST | `/api/chat` | 发消息，SSE 流式返回（含工具循环） | #2 chat 主交互 |
| POST | `/api/confirm` | 批准/拒绝写入 proposal | #3 写入纪律 |
| GET | `/api/sessions` | 会话列表 | #2 |
| POST | `/api/sessions` | 新建会话 | #2 |
| GET | `/api/sessions/:id` | 会话详情（含消息 + 工具历史） | #2 |
| DELETE | `/api/sessions/:id` | 删除会话 | #2 |
| GET | `/api/notes` | 笔记列表（title + 一句话定位） | #3 笔记浏览 |
| GET | `/api/notes/:id` | 笔记全文 | #3 |
| GET | `/api/notes/search?q=` | 笔记搜索（人类 UI 用） | #3 |
| POST | `/api/imports/upload` | 上传文档（multipart） | #3 导入层 |
| GET | `/api/imports` | 导入文档列表 | #3 |
| GET | `/api/imports/:id` | 单文档详情（含 status/error） | #3 |
| DELETE | `/api/imports/:id` | 删除文档 + chunks + 向量 | #3 |

笔记层对**人类**只暴露读接口；写只能由 LLM 经工具 + 确认完成（需求：chat 为主要交互方式）。

## POST /api/chat

请求：

```json
{ "sessionId": "abc123 或 null", "content": "记一下 nginx 502 的排查" }
```

- `sessionId` 为 null → 服务端新建会话
- 响应：`Content-Type: text/event-stream`，事件协议见下节
- `sessionId` 不存在 → 404 `NOT_FOUND`
- 该会话已有进行中的 turn → 409 `SESSION_BUSY`（不返回 SSE）

## SSE 事件协议

继承 htwm-wiki 的 7 种事件（参考 htwm-wiki `apps/server/src/llm.ts:61-143`、`apps/web/src/App.tsx:12-19`），**新增 2 种**：`session`、`truncated`。

每条事件为一帧：`data: {json}\n\n`。

### 事件表

| type | 字段 | 时机 | 备注 |
|---|---|---|---|
| `session` | `{sessionId, title}` | 流开场第一帧 | **新增**：让前端尽早拿到新建会话的 id |
| `delta` | `{text}` | LLM 每次输出增量 | 追加到当前 assistant 气泡 |
| `tool` | `{name, args}` | LLM 发起一次工具调用 | args 截断到 ~200 字符展示 |
| `tool_result` | `{name, preview}` | 工具执行完 | preview 为结果 JSON 截断 ~200 字符 |
| `proposal` | `{id, tool, args, preview}` | 写工具触发确认 | preview 4 种形态见下 |
| `proposal_done` | `{id, approved}` | 确认被 resolve（含超时） | 前端卡片置终态 |
| `truncated` | `{dropped: number}` | 本轮发生上下文截断 | **新增**：dropped = 被省略的最早消息条数 |
| `error` | `{message}` | 服务端/上游错误 | 流内展示 ⚠，流随后结束 |
| `done` | `{sessionId}` | 流正常结束 | 最后一帧 |

### proposal.preview 四种形态

与 htwm-wiki `buildPreview`（`apps/server/src/llm.ts:70`）一致：

```typescript
type Preview =
  | { diff: { t: '+' | '-'; l: string }[] }  // write_note 改已有（line diff）
  | { newFile: string }                       // write_note 新建（前 600 字符）
  | { note: string }                          // record_inbox（前 300 字符）
  | { delete: string }                        // delete_note（笔记 title）
```

### 典型时序（记一下 X）

```
→ session        {sessionId, title}
→ delta          （若干帧，LLM 边想边说）
→ tool           {name:"search_notes", ...}
→ tool_result    {name:"search_notes", ...}
→ tool           {name:"read_note", ...}
→ tool_result    {name:"read_note", ...}
→ proposal       {id, tool:"write_note", preview:{diff:[...]}}
   … 用户点确认（POST /api/confirm，独立于本 SSE 流）…
→ proposal_done  {id, approved:true}
→ tool_result    {name:"write_note", ...}
→ delta          （一句话总结）
→ done           {sessionId}
```

## POST /api/confirm

```json
请求:  { "id": "proposal-uuid", "approve": true }
响应:  { "ok": true }
```

- `ok: false` 表示 proposal 不存在或已 resolve（幂等：重复点击/超时后点击不报错）
- 参考 htwm-wiki `resolveConfirm`（`apps/server/src/llm.ts:55`）
- 超时 120s 未确认自动拒绝，服务端补发 `proposal_done {approved:false}`（05 已定）

## Sessions

```json
GET  /api/sessions
→ [{ "id", "title", "updatedAt" }]            // 按 updatedAt 降序

POST /api/sessions
→ { "id", "title": "新对话", "createdAt", "updatedAt" }

GET  /api/sessions/:id
→ { "id", "title", "createdAt", "updatedAt",
    "messages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "...", "toolCalls": [
          { "name": "search_notes", "args": "...", "resultPreview": "..." }
      ]}
    ]}

DELETE /api/sessions/:id → { "ok": true }
```

- 消息持久化含 tool_calls + 结果摘要（决策：01 架构「messages 表存 tool_calls + 结果」），会话重开可回放工具时间线（06 已定）
- 首条用户消息前 24 字符自动设为 title（沿用 htwm-wiki 行为）

## Notes（人类只读）

```json
GET /api/notes
→ [{ "id", "title", "summary", "kind": "topic|inbox", "updatedAt" }]   // 按 title 排序

GET /api/notes/:id
→ { "id", "title", "content_md", "kind", "createdAt", "updatedAt" }

GET /api/notes/search?q=nginx
→ [{ "id", "title", "snippet", "score" }]
```

检索实现与 `search_notes` 工具共用（FTS5，见 02/10）。

## Imports

```json
POST /api/imports/upload     (multipart/form-data, 字段名 file)
→ 201 { "id", "filename", "size", "status": "processing", "dedup": false }
→ 200 { "id", "filename", "size", "status": "ready", "dedup": true }   // 内容已存在

GET  /api/imports
→ [{ "id", "filename", "size", "status", "chunksCount", "uploadedAt" }]

GET  /api/imports/:id
→ { "id", "filename", "mimeType", "size", "status", "error", "chunksCount", "uploadedAt" }

DELETE /api/imports/:id → { "ok": true }
```

- MIME 白名单与大小限制见 03（PDF/DOCX/MD/TXT/HTML，单文件 50 MB）
- `status`: `processing | ready | failed`；failed 时 `error` 为人类可读原因

## 边界场景（服务端语义）

前端对应行为见 12。

### 重复上传去重

- 上传时计算文件 sha256；`imports.sha256` 有唯一索引（见 10）
- 同 hash 已存在 → 不重建，返回 `200 + dedup:true` + 已有记录
- 依据：导入层只读、内容即身份（03）

### 更新已导入文档

- 同文件名不同 hash → 视为**更新**：事务内删除旧 chunks + 向量，重新提取/切分/embedding，`uploadedAt` 刷新
- 全新文件名 → 新建记录
- 依据：用户心智里「这个文件的新版」应替换旧版，而非并存两份同名文档

### 上下文窗口溢出

- 发送前按工具回合边界截断历史（05 已定：tool_calls 必须与对应 tool result 同留同去）
- 截断发生时本轮 SSE 发一次 `truncated {dropped}`，前端展示「更早消息已省略」
- 截断只影响发给 LLM 的上下文，**DB 里的完整历史不动**

### Ollama 上传时挂（embedding 不可达）

- 导入管线是异步任务：upload 立即返回 `processing`，后台执行 提取→切分→embedding→入库
- embedding 请求失败（连接拒绝/超时 30s）→ 该文档 `status=failed`，`error` 入库（如「Ollama 不可达： ECONNREFUSED 127.0.0.1:11434」）
- 不阻塞其他上传；用户修复 Ollama 后重新上传同文件即可（走「更新」路径）
- 依据：03「失败处理：不阻塞其他上传」

### 中止流式

- 前端 AbortController 断开 `/api/chat` 连接即中止，**无单独 abort endpoint**
- 服务端监听连接关闭：中断上游 LLM 请求 + 工具循环；pending 的 proposal 立即按拒绝处理（发 `proposal_done {approved:false}`）
- 已产生的 assistant 内容照常落盘（半截回复保留在会话历史，符合用户对「断流」的直觉）

### proposal pending 时新 turn

- 同 session 同时只允许一个进行中的 turn（含等待确认的时段）
- pending 期间对该 session 再发 `/api/chat` → 409 `SESSION_BUSY`
- 依据：串行化避免「确认还没点，LLM 又发起第二个写」造成的交错

### 多标签页同 session

- 与上同一条规则：标签页 B 在标签页 A 的 turn 进行中发消息 → 409
- proposal 确认是幂等的：两个标签页都点了确认，先到的生效，后到的 `ok:false`（前端把卡片置终态即可，不报错）
- 不做跨标签页 SSE 广播（v1 单流，够用）

## 不提供的接口

- 无人工写笔记接口（写入一律走 chat + 确认；06「人工编辑入口」为待定项）
- 无导入文档全文读取接口（03 已定：不返回全文，防上下文爆炸）
- 无鉴权接口（08 已标注风险与缓解路径）
