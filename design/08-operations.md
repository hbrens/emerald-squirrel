# 08 · 运维

## 部署

参考 htwm-wiki 的 systemd user service 形态（`deploy/htwm-wiki.service`）。

### systemd 用户服务

```ini
# ~/.config/systemd/user/htwm-wiki.service
[Unit]
Description=htwm-wiki chat + doc tools
After=network.target

[Service]
ExecStart=/usr/bin/node --env-file=/path/to/.env src/index.ts
Environment=PORT=61127
WorkingDirectory=/path/to/apps/server
Restart=always

[Install]
WantedBy=default.target
```

参考 htwm-wiki `deploy/htwm-wiki.service`（已是 user service）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:29004/v1` | LLM 网关 |
| `LLM_API_KEY` | — | LLM API key |
| `LLM_MODEL` | `gpt-5.6-luna` | 对话模型 |
| `EMBEDDING_BASE_URL` | `http://127.0.0.1:11434` | Ollama |
| `EMBEDDING_MODEL` | `nomic-embed-text` | embedding 模型 |
| `EMBEDDING_DIM` | `768` | 向量维度 |
| `PORT` | `61127` | 服务端口 |
| `DATA_DIR` | `apps/server/data` | SQLite + 上传文件目录 |

### Ollama（外部依赖）

- 由用户手动管理，不在本项目 systemd 里
- 必须监听 `0.0.0.0:11434`（如果跑容器）或 `127.0.0.1`（同机）
- 模型 `nomic-embed-text` 需 `ollama pull nomic-embed-text`

参考 htwm-wiki AGENTS.md「Ollama 须监听 0.0.0.0 才能被容器访问」。

## 备份

**不依赖 git 后，备份策略变为**：

### SQLite 备份

- 每日 tar `data/` 目录（含 `wiki.db` + 上传的原始文件）
- systemd timer 触发，参考：

```ini
# ~/.config/systemd/user/htwm-wiki-backup.timer
[Unit]
Description=Daily htwm-wiki backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# ~/.config/systemd/user/htwm-wiki-backup.service
[Unit]
Description=Backup htwm-wiki data

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'tar czf ~/backup/htwm-wiki-$(date +%F).tar.gz -C /path/to/apps/server data/ && find ~/backup -name "htwm-wiki-*.tar.gz" -mtime +30 -delete'
```

### 保留周期

- 30 天的每日备份
- 超过自动删（`find -mtime +30 -delete`）

## 鉴权

### 当前现状

htwm-wiki 是**零鉴权**——任何能访问 :3088 的人都能聊天 + 点确认 = 任意写文件。

### 本设计立场

局域网自用，鉴权降级为「以后再说」。但要在文档里**显式标注风险**：

- 任何能 ping 到服务器的人都能：
  - 调 `/api/chat` 消耗 LLM 配额
  - 调 `/api/confirm` 批准任意写入
  - 删笔记 / 删导入文档

### 缓解措施（不实施，仅记录）

- 服务器防火墙只允许特定 IP 访问 :61127
- 或加 nginx 反代 + basic auth
- 或加 bearer token（参考 gptme-server）

未来如果上多用户或暴露公网，必须做。

## 日志

### 当前现状

htwm-wiki 后端**无任何 console.log/error**，错误靠 SSE 流给前端，本机不留痕。AGENTS.md「已知坑」纯靠人脑记。

### 本设计立场

加结构化日志（决策 5）：

- 用 `pino`（轻量、结构化 JSON 输出）
- 写到 stderr，systemd 自动收进 journalctl
- 关键事件：LLM 调用 / 工具调用 / 写入操作（含 proposal id + 是否确认）/ 错误

### journalctl 查询示例

```bash
journalctl --user -u htwm-wiki -n 100      # 最近 100 行
journalctl --user -u htwm-wiki -f          # 实时跟随
journalctl --user -u htwm-wiki --since "1 hour ago"
```

## 已知坑（从 htwm-wiki AGENTS.md 迁移 + 剔除已纠正项）

### 已纠正（不再是坑）

- ❌ SQLite snake_case 别名映射（本设计 schema 重新定义，避免）
- ❌ git 碎 commit（本设计不用 git）
- ❌ 会话只存纯文本（本设计持久化 tool_calls + 结果，决策 1）

### 仍需注意

- **前端改动后必须 `pnpm --filter @htwm/web build` 并重启服务**——浏览器可能缓存旧 index.html
- **React.lazy 必须配 Suspense**（曾因此整树白屏）
- **React 自动 JSX 运行时不注入 `React` 变量**，用了就要显式 import
- **给 LLM 的话术影响测试结果**：测取消流程要用中性话术，不能说「这条不要落盘」（LLM 会拒绝调工具）
- **自动化浏览器（CDP）合成按键不产生默认换行**：Shift+Enter 换行无法脚本验证，只能验证「不误发」
- **Ollama 须监听 0.0.0.0** 才能被容器访问
- **DOMPurify sanitize**：marked + dangerouslySetInnerHTML 必须 sanitize，防 LLM 输出 / 笔记内容里的 XSS（参考 htwm-wiki App.tsx:4 当前**没做** sanitize，是已知风险）

### 新增坑（本设计引入）

- **孤儿 tool_calls**：截断时切到 tool_calls 但丢对应 tool result，OpenAI API 报错。必须按工具回合边界截断（见 05）
- **sqlite-vec 扩展加载**：Node SQLite 客户端要支持加载扩展（`better-sqlite3` 的 `loadExtension`），需验证
- **FTS5 中文分词**：默认 `unicode61` 对中文不友好，可能需要 `trigram` tokenizer 或 jieba
- **Ollama embedding 维度**：`nomic-embed-text` 768 维，schema 要对齐；换模型要重新嵌入全部 chunks

## 验收要求（沿用 htwm-wiki）

改完前端/功能必须**逐页真实浏览器走查并截图核对**，写入类流程要落到磁盘（DB 查询 / 数据检查）双重核实后才算完成。

WeKnora 部署在 `:8801` 可作视觉对照（htwm-wiki AGENTS.md 提过，已归档但服务可能仍在）。
