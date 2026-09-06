# AGENTS.md · emerald-squirrel(htwm-app)

对话式知识库:chat 为主要交互方式,两层知识库(笔记层可写 + 导入层只读)。项目文档与注释以中文为主,代码/字段名/路径用英文。

## 结构

```
apps/server   # Hono + better-sqlite3 + sqlite-vec,Node 直跑 TS(无构建步骤)
apps/web      # React 18 + Vite 6(vite dev 代理 /api → :61127)
design/       # 设计文档集(权威规格,先于代码;改动敏感区前先读对应篇)
scripts/      # e2e.mjs API 端到端验证(约 40 项断言)
deploy/       # systemd user service(非容器部署方式)
data/         # 生产数据(DB + 上传原件),gitignore,不进构建上下文
```

## 常用命令

```bash
pnpm install
pnpm rebuild better-sqlite3   # 原生模块(若安装后未编译)
pnpm dev                      # server :61127 + vite :5173 并行
pnpm check                    # 根级类型检查 = 两个包各跑 tsc --noEmit
pnpm build                    # 只构建前端 dist(server 无构建)
pnpm start                    # 生产形态(server 直接托管 apps/web/dist)
node scripts/e2e.mjs          # e2e 验证:需服务已在 :61127 且宿主机 LLM 网关 / Ollama 可用
docker compose up -d --build  # 容器部署/更新(见下)
```

## ⚠️ 改完代码必须拉起容器

代码被打进镜像(server 源码 + web dist),**`docker compose restart` 不会加载新代码**。任何源码改动(含 `apps/server/src`、`apps/web/src`、依赖、Dockerfile、compose 配置)完成后,一律:

```bash
docker compose up -d --build
```

然后用 `docker compose ps`(healthy)与 `docker compose logs -f` 确认起来;涉及 API/工具行为的改动再跑 `node scripts/e2e.mjs`。

## 架构边界(server)

- `index.ts` 路由 + SSE;`llm.ts` chat 轮次循环(OpenAI 兼容 `/chat/completions` + function calling,MAX_ROUNDS=10);`tools.ts` 工具分发 + 提案/确认;`notes.ts` 笔记层;`imports.ts` 导入管线(提取/切分/embedding);`sessions.ts` 会话;`db.ts` SQLite(WAL) + 迁移
- 迁移:`src/migrations/*.sql` 按 `NNN_` 前缀 + `user_version` 顺序执行,只增不改
- 写入纪律:笔记写操作走两阶段(生成 proposal → 前端确认 → `/api/confirm` 执行,120s 超时);导入层对 LLM 严格只读
- 每会话同时只允许一轮对话进行中(否则 409 SESSION_BUSY);错误统一 `{error:{code,message}}`

## 关键约定与坑

- **server 直跑 TS**:imports 必须带 `.ts` 扩展名;`erasableSyntaxOnly`(禁 enum/namespace/参数属性);Node ≥ 24
- **静态托管靠相对路径**:`index.ts` 按 `here/../../web/dist` 找前端产物,`apps/server/src` 与 `apps/web/dist` 的目录关系不能动(镜像内同样依赖此布局)
- **EMBEDDING_DIM 必须与建表 `FLOAT[N]` 一致**:换 embedding 模型需全量重建向量
- **容器内网络**:`localhost` 指容器自身,宿主机 LLM 网关/Ollama 经 `host.docker.internal`(compose 已改写 `LLM_BASE_URL`/`EMBEDDING_BASE_URL`;宿主机端口变了只改 compose 的 environment)
- **端口唯一来源是根 .env 的 PORT**:compose 端口映射(`${PORT:-61127}` 插值)、vite 代理(`loadEnv` 读根 .env)、e2e 默认地址都自动跟随;`index.ts` 与 Dockerfile healthcheck 里的 61127 仅为缺省兜底
- **数据与属主**:容器以 uid 1000 运行,挂载 `./data:/data`;属主不符需 `chown 1000:1000 data`;备份/恢复即打包 `data/`(建议停服时)
- **.env** 在仓库根,server 用 `--env-file-if-exists=../../.env` 读取;模板见 `.env.example`
- 导入白名单 MIME 见 `imports.ts` 的 `MIME_WHITELIST`;上传上限 50MB;图片/扫描 PDF 走视觉模型(`IMAGE_MODEL`)
- LLM 工具 schema 在 `apps/server/src/tools.json`(发给 LLM 的 function calling 定义),与 `design/11-tool-schemas.md` 对应

## 改敏感区前先读

- 笔记写入纪律 / 查重合并:`design/04-write-discipline.md`
- 工具与确认机制:`design/05-tools.md`、`design/11-tool-schemas.md`
- API 与 SSE 事件协议:`design/09-api-contract.md`
- 前端结构与 SSE 消费:`design/12-frontend-structure.md`
- 运维与已知坑:`design/08-operations.md`
