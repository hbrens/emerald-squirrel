# open-sesame

对话式知识库:chat 为主要交互方式,两层知识库(笔记可写 + 导入只读)。设计文档见 [`design/`](design/README.md)。

## 结构

```
apps/server  # Hono + better-sqlite3 + sqlite-vec,Node 直跑 TS
apps/web     # React + Vite
deploy/      # systemd user service
scripts/     # e2e.mjs API 端到端验证
```

## 开发

```bash
pnpm install
pnpm rebuild better-sqlite3   # 原生模块(若安装后未编译)
pnpm dev                      # server :3088 + vite :5173(代理 /api)
pnpm build                    # 构建前端 dist,server 生产模式直接托管
pnpm start                    # 生产形态
node scripts/e2e.mjs          # API 端到端验证(需服务已启动 + LLM 网关可用)
```

## 环境变量(.env,见 .env)

`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `PORT` / `DATA_DIR`

默认:LLM 网关 `http://localhost:29005/v1`(gpt-5.6-sol),Ollama `qwen3-embedding:0.6b`(1024 维)。图片与扫描版 PDF 走视觉模型提取(`IMAGE_MODEL`,默认 gpt-5.6-sol)。

## 支持的导入格式

PDF(文本型直提取;扫描版自动栅格化走视觉模型)/ DOCX / XLSX / XLS / PPTX / PNG / JPG / WEBP / GIF / MD / TXT / HTML。

## 验证状态

- 服务端/前端 `tsc --noEmit` 通过,前端 `vite build` 通过
- `scripts/e2e.mjs` 29 项断言全部通过(查重→新建/合并→diff 确认→取消→409→上传→去重→更新→语义检索→FTS5 中文检索)
