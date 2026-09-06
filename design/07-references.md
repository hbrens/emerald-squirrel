# 07 · 参考对比

每个参考项目写：借鉴了什么 / 避开了什么 / 为什么。

## htwm-wiki（自己的现有实现）

源码：`/home/hbrens/Desktop/Project/coding/htwm-wiki/`

### 借鉴

- **分层结构**：apps/web + apps/server + docs/ 数据 + deploy/，本设计沿用（前端 + 后端 + 数据 + 部署）
- **工具集命名**：`list_docs / read_doc / search_docs / write_doc / record_note / delete_doc`，本设计改名 `notes` 但接口形态照搬
- **写入确认机制**：proposal → diff preview → 用户点确认 → 落盘（llm.ts:61 `requestConfirm`），本设计完全沿用
- **proposal 4 种 preview 类型**：diff / newFile / note / delete（llm.ts:70 `buildPreview`），本设计沿用
- **会话分组 UI**：今天 / 近 7 天 / 更早（App.tsx:36 `groupSessions`），本设计沿用
- **SSE 流式 + 工具循环**：chatStream 主循环（llm.ts:83），本设计沿用
- **路径安全**：`safeDocPath`（docs.ts:15）—— 本设计笔记层在 DB 无此需求，但人工编辑入口若加要参考
- **lineDiff 算法**：LCS（docs.ts:86），本设计沿用
- **systemd user service 部署**：deploy/htwm-wiki.service，本设计沿用形态

### 避开

- **git 自动 commit**：htwm-wiki 每次写入自动 commit（docs.ts:47），本设计已决定不用 git
- **碎 commit**：每次写一个 commit 污染 git log，本设计无此问题
- **SYSTEM_PROMPT 模糊**：htwm-wiki 的「合并进合适章节」太含糊（llm.ts:15-28），本设计在 04 重写成精确规则
- **零鉴权**：htwm-wiki 任何能访问 :3088 的人都能写文件，本设计局域网自用可接受但需标注（见 08）
- **会话只存纯文本**：htwm-wiki db.ts:21 只存 user/assistant，工具调用丢，本设计要持久化（见 02）
- **searchDocs 全量遍历**：每次查询读所有文件（docs.ts:35），本设计笔记层用 FTS5
- **markdown 文件存储**：本设计笔记层换 SQLite（Q1）

## open-webui

源码：`/tmp/open-webui-src/`

### 借鉴

- **notes 工具模式**：4 个工具 `search_notes / view_note / write_note / replace_note_content`（builtin.py），LLM 通过工具驱动笔记读写——本设计完全沿用此模式
- **notes DB schema**：note 表 + content.md 字段（models/notes.py:20），本设计的 notes 表结构照搬思路
- **search_notes SQL LIKE**：纯文本 LIKE 检索（builtin.py），验证笔记层不必上向量——本设计沿用（升级到 FTS5）
- **导入管线**：文件上传 → 文本提取 → 切分 → embedding → 向量索引 → 检索，本设计 Part 2 完全照搬此管线
- **proposal 持久化（如果有）**：open-webui 把 tool_calls 存进 messages（待核实），本设计参考

### 避开

- **向量用 Chroma/Qdrant**：open-webui 默认 Chroma，本设计用 sqlite-vec（单机最简）
- **多用户权限**：open-webui 是多用户 SaaS 形态，本设计局域网自用不需要
- **复杂配置面板**：open-webui 有大量 admin 配置，本设计极简
- **RAG 用在 notes**：open-webui 笔记也走 RAG，本设计笔记层用纯文本（量小、要算 diff）

## gptme

源码：github.com/gptme/gptme

### 借鉴

- **分层记忆**：journal / tasks / knowledge / lessons 四个目录，git-tracked "brain"——本设计的「笔记层 + inbox」简化版借鉴此结构
- **Lessons 情景化注入**：按关键词/工具/模式匹配自动注入到上下文——本设计暂不实现，但留作笔记层升级路径
- **server + webui 同源部署**：gptme-server 内含 web UI，同源无 CORS——本设计沿用此部署形态
- **bearer token 认证模型**：loopback 也强制鉴权（server 文档）——本设计局域网自用可降级，但模型可参考

### 避开

- **终端 CLI 为主入口**：gptme 终端优先，本设计要 web chat 入口
- **多 provider 路由**：gptme 支持 100+ 模型 + 路由，本设计单 endpoint 够用
- **过于复杂的工具集**：shell / ipython / browser / vision / tmux / computer / subagent / rag / gh —— 本设计只笔记 + 导入两类工具

## WeKnora

源码：github.com/Tencent/WeKnora

### 借鉴

- **前端视觉风格**：TDesign 设计系统、绿色品牌、扁平小圆角、衬线字标、工具竖向时间线、大圆角输入区——本设计前端高精度参考（Q11）
- **暗色模式 + 响应式**：本设计照搬

### 避开

- **后端架构**：WeKnora 是 Go + 复杂企业架构，本设计用 Hono + Node TS 极简
- **miniprogram / mcp-server / rerank_server** 等组件：本设计不需要

## khoj

源码：github.com/ai-khoj/khoj

### 借鉴

- **「AI second brain」定位**：聊天为主入口、检索 + 笔记——本设计核心定位同
- **多端客户端**：web / 桌面 / Obsidian 插件 / Emacs——本设计暂只 web，但留扩展空间
- **automations 定时整理**：定时把流水归档到主题——本设计的「整理收件箱」工具调用是手动版，未来可加定时

### 避开

- **全面 RAG 化**：khoj 笔记也走 embedding 检索，本设计笔记层用纯文本
- **PostgreSQL + pgvector**：本设计单机 SQLite，不引外部 DB
- **复杂多用户/订阅**：khoj 有 cloud 订阅，本设计局域网自用

## reor

源码：github.com/reorproject/reor（**已 archive，2026-03-07**）

### 借鉴

- **「self-organizing」理念**：自动链接相关笔记——本设计暂不做，但作为笔记层未来升级路径
- **markdown + 本地优先**：验证文件方案可行（但本设计选 DB，理由见 02）

### 避开

- **Electron 桌面应用**：本设计是 web
- **本地 embedding + 向量库**：本设计导入层才用向量，笔记层不用
- **项目已死**：不依赖其后续维护

## open-knowledge

源码：github.com/inkeep/open-knowledge

### 借鉴

- **MCP + agentic search 思路**：通过 MCP 暴露工具给 agent harness，搜索走 grep 而非向量——本设计笔记层同路线（FTS5 代替 grep，但都是「纯文本」哲学）
- **WYSIWYG 编辑 markdown**：本设计暂不做（人工编辑入口待定），但作为参考
- **starter packs**：知识库模板（LLM Wiki / second brain）——本设计未来可借鉴做笔记模板

### 避开

- **IDE 形态不是纯聊天入口**：open-knowledge 是编辑器 + 侧边 AI，本设计要纯聊天入口
- **依赖外部 agent harness**：open-knowledge 自己不带 AI，要接 Claude Code/Codex 等——本设计自带 LLM 调用，不依赖外部 harness

## 对比矩阵总览

| 维度 | 本设计 | htwm-wiki | open-webui | gptme | khoj | reor | open-knowledge |
|---|---|---|---|---|---|---|---|
| 主入口 | web chat | web chat | web chat | terminal | web chat | electron IDE | editor + sidebar |
| 笔记存储 | SQLite + md | md 文件 + git | SQLite + md | md 文件 + git | 多源 | md 文件 | md 文件 |
| 笔记检索 | FTS5 | 全量遍历 | SQL LIKE | grep | RAG | RAG | agentic search |
| 导入层 | SQLite + sqlite-vec | 无 | RAG + Chroma | 无 | RAG | 无 | 无 |
| 版本管理 | 无（DB） | git 自动 | 无 | git | 无 | git | git |
| 写入确认 | diff 卡片 | diff 卡片 | 无 | 无 | 无 | 无 | 无 |
| 写入纪律 | 强制规则（04） | 模糊 | 无 | 无 | 无 | 无 | 无 |
| 多用户 | 否 | 否 | 是 | 否 | 是 | 否 | 否 |
| 部署 | systemd | systemd | docker | systemd/docker | docker/self-host | 桌面 | npm |
