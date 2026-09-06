# 12 · 前端结构

本篇定义组件树、聊天状态机、SSE 消费逻辑与前端侧边界场景。功能清单与风格基准见 [06-frontend.md](06-frontend.md)（WeKnora 高精度参考）；API 与事件协议见 [09-api-contract.md](09-api-contract.md)。本篇只写结构与逻辑，不写样式数据。

## 组件树

```
App
├─ Sidebar
│  ├─ Wordmark
│  ├─ NavTabs            （新对话 / 笔记 / 导入）
│  ├─ SessionList        （今天 / 近 7 天 / 更早 分组，参考 htwm-wiki App.tsx:36 groupSessions）
│  ├─ NoteList           （title + 一句话定位，按 title 排序）
│  ├─ ImportList         （filename + status 徽标）
│  └─ UserFooter
├─ ChatView（tab=chat，主入口）
│  ├─ TopBar             （会话标题 + 模型 tag）
│  ├─ MessageList
│  │  ├─ MessageItem     （user 气泡 / assistant markdown）
│  │  ├─ ToolTimeline    （竖向 step：icon + label + 摘要，WeKnora 风）
│  │  ├─ ProposalCard    （diff / newFile / note / delete 四种 preview + 确认/取消按钮）
│  │  ├─ TruncatedNotice （「更早消息已省略」提示条）
│  │  └─ ErrorBanner     （⚠ 流内错误）
│  └─ Composer
│     ├─ TextArea        （Enter 发送 / Shift+Enter 换行）
│     └─ ComposerBar     （「写入需确认」tag + 模型 tag + 发送/停止按钮）
├─ NotesView（tab=notes）
│  ├─ NoteSearchBox      （人类用搜索，GET /api/notes/search）
│  └─ DocView            （只读 markdown 渲染）
└─ ImportsView（tab=imports）
   ├─ UploadZone         （拖拽 + 点击，多文件）
   └─ ImportTable        （filename / size / status / chunks / uploadedAt / 删除）
```

markdown 渲染统一走 `marked + DOMPurify` sanitize（06/08 已定，防 XSS）。

## 聊天状态机

一次 chat turn 的状态流转（前端视角）：

```
idle ──send──▶ streaming ──proposal──▶ awaiting_confirm
                 ▲  ▲                     │ 用户点确认/取消 → POST /api/confirm
                 │  └──tool/tool_result───┘（LLM 继续输出，可能再次 proposal）
                 │
   error 事件 ──▶ error ──▶ done（收尾落盘）
   用户点停止 ──▶ aborted ──▶ done（AbortController 断连）
   done 事件 ──▶ idle
```

| 状态 | UI 表现 |
|---|---|
| `idle` | 输入框可用，发送按钮可用 |
| `streaming` | 发送按钮变「停止」；流式气泡逐帧追加；工具时间线实时增长 |
| `awaiting_confirm` | ProposalCard 显示确认/取消按钮；输入框禁用（09：pending 时新 turn 会被 409 拒绝，前端直接禁发） |
| `error` | ErrorBanner 展示 message；本轮内容保留；回到 idle |
| `aborted` | 已输出内容保留并入消息列表；时间线标记「已中止」 |

一次 turn 内 `streaming ⇄ awaiting_confirm` 可多次往返（一次对话可能有多个写工具）。

## SSE 消费逻辑

用 `fetch + ReadableStream`（POST 无法走 EventSource）。参考 htwm-wiki `App.tsx:119-142`，升级为带 abort 与全事件处理的版本：

```typescript
const abortRef = useRef<AbortController | null>(null)

async function send(text: string) {
  const ac = new AbortController()
  abortRef.current = ac
  dispatch({ type: 'TURN_START', text })

  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content: text }),
    signal: ac.signal,
  })
  if (resp.status === 409) { dispatch({ type: 'BUSY' }); return }   // 见边界场景
  if (!resp.ok || !resp.body) { dispatch({ type: 'ERROR', message: await resp.text() }); return }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        if (!frame.startsWith('data: ')) continue
        try { dispatch({ type: 'EVENT', ev: JSON.parse(frame.slice(6)) }) } catch { /* 不完整帧 */ }
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) dispatch({ type: 'ERROR', message: String(e) })  // aborted 是用户主动停止，不算错误
  }
  dispatch({ type: 'TURN_END' })
}

function stop() { abortRef.current?.abort() }   // 09：断连即中止，无单独 endpoint
```

### 事件 → 状态更新表

| SSE 事件 | reducer 行为 |
|---|---|
| `session` | 记录 sessionId/title（新建会话时尤为重要） |
| `delta` | 追加到当前流式气泡文本 |
| `tool` | ToolTimeline 追加一步（name + args 摘要） |
| `tool_result` | 回写时间线最后一步的结果摘要 |
| `proposal` | 追加 ProposalCard（pending 态）；状态 → `awaiting_confirm` |
| `proposal_done` | 对应卡片置终态（已写入/已取消）；无 pending 卡片则回 `streaming` |
| `truncated` | MessageList 顶部插 TruncatedNotice |
| `error` | ErrorBanner 展示；状态 → `error` |
| `done` | 流式气泡并入 messages；清时间线暂存；状态 → `idle`；刷新 SessionList/NoteList |

### 会话重开回放

`GET /api/sessions/:id` 返回的 messages 含 `toolCalls` 摘要（09/10），直接渲染为历史 ToolTimeline——当前轮与历史轮的时间线用同一组件，数据源不同而已（06 已定「会话重开展示历史工具时间线」）。

## 边界场景（前端行为）

服务端语义见 09 同名小节。

### 中止流式

- Composer 在 `streaming/awaiting_confirm` 时显示「停止」按钮 → `abort()` 断连
- 已输出的半截回复保留并入消息列表（服务端同样落盘，09）
- pending 的 ProposalCard 会收到服务端补发的 `proposal_done {approved:false}`，正常置终态

### proposal pending 时新 turn

- `awaiting_confirm` 期间禁用输入框与发送按钮（服务端 409 是兜底，不依赖用户不乱点）
- 若仍收到 409（极端时序）：ErrorBanner 提示「上一个写入还未确认」

### 多标签页同 session

- 发消息收到 409 → 展示「该对话正在另一个窗口进行中」
- proposal 重复确认：服务端 `ok:false` 不报错，卡片按 `proposal_done` 置终态即可
- 不做跨标签页同步（v1；用户切标签页后手动刷新会话即可）

### 上下文窗口溢出

- 收到 `truncated {dropped}` → 消息列表顶部显示「更早的 N 条消息已省略出上下文（历史仍完整保存）」
- 只影响 LLM 所见，不影响前端展示的完整历史

### Ollama 挂（导入失败）

- UploadZone 上传后轮询 `GET /api/imports/:id`（2s 间隔，最多 5 分钟）直到 `ready | failed`
- `failed` → 列表行内展示 error 文本 + 「重试」按钮（重发上传，走 09 的更新路径）
- `search_imports` 工具失败时 LLM 回复里会说明（11），前端无需特殊处理

### 重复上传去重 / 更新文档

- 上传响应 `dedup:true` → toast「该文件内容已存在，未重复导入」
- 同文件名不同内容 → 列表原条目 status 回到 `processing`，轮询至 `ready`（即「更新」语义，用户无感知）

## 数据流小结

- 读：普通 `fetch` REST（sessions / notes / imports 列表与详情）
- 写（用户侧）：仅 上传文件、点确认、发消息 三个动作
- 写（笔记内容）：永远由 LLM 工具 + 确认完成，前端无编辑器（06 待定项：人工编辑入口 v1 不加）
