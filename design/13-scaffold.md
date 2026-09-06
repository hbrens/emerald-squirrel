# 13 · 脚手架

本篇给出 monorepo 目录树、各 package.json、配置文件与开发命令，可直接照抄建项目。部署（systemd / 环境变量 / 备份）见 [08-operations.md](08-operations.md)，本篇不重复。

组织结构：**pnpm workspace monorepo**（已确认），形态沿用 htwm-wiki（`apps/*` 两包 + `deploy/`）。

## 目录树

```
emerald-squirrel/
├─ package.json                 # 根：workspace 声明 + 根脚本
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ server/                   # @emerald-squirrel/server — Hono 后端
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ src/
│  │  │  ├─ index.ts            # 入口：Hono 路由 + 静态资源（09 全部 endpoint）
│  │  │  ├─ llm.ts              # LLM 流式 + 工具循环 + 确认（05/09）
│  │  │  ├─ tools.json          # 7 个 function calling schema（11）
│  │  │  ├─ tools.ts            # 工具执行器 + buildPreview + lineDiff
│  │  │  ├─ db.ts               # better-sqlite3 连接 + PRAGMA（10）
│  │  │  ├─ notes.ts            # 笔记层 CRUD + FTS5 检索
│  │  │  ├─ imports.ts          # 导入管线：提取/切分/embedding/向量（03）
│  │  │  ├─ sessions.ts         # 会话 + messages 持久化（10）
│  │  │  ├─ migrations/
│  │  │  │  └─ 001_init.sql     # 10 的全部 DDL
│  │  │  └─ logger.ts           # pino（08 决策：结构化日志）
│  │  └─ data/                  # SQLite + 上传原文件（.gitignore，备份对象见 08）
│  └─ web/                      # @emerald-squirrel/web — React 前端
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ vite.config.ts
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx
│        ├─ App.tsx             # shell + tab 切换（12 组件树）
│        ├─ chat/               # ChatView / MessageList / ToolTimeline / ProposalCard / Composer
│        ├─ notes/              # NotesView / DocView / NoteSearchBox
│        ├─ imports/            # ImportsView / UploadZone / ImportTable
│        ├─ sse.ts              # SSE 消费 + reducer（12）
│        └─ md.ts               # marked + DOMPurify
└─ deploy/
   └─ emerald-squirrel.service       # systemd user service（形态见 08）
```

## package.json

### 根 `package.json`

```json
{
  "name": "emerald-squirrel",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "pnpm --parallel --filter @emerald-squirrel/server --filter @emerald-squirrel/web dev",
    "build": "pnpm --filter @emerald-squirrel/web build",
    "start": "pnpm --filter @emerald-squirrel/server start"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
onlyBuiltDependencies:
  - esbuild
  - better-sqlite3
```

### `apps/server/package.json`

```json
{
  "name": "@emerald-squirrel/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.ts",
    "start": "node src/index.ts"
  },
  "dependencies": {
    "hono": "^4.9.0",
    "@hono/node-server": "^1.14.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0",
    "pdf-parse": "^1.1.1",
    "mammoth": "^1.8.0",
    "cheerio": "^1.0.0",
    "pino": "^9.0.0"
  }
}
```

server 无构建步骤：Node 24 直跑 TS（沿用 htwm-wiki 形态，`node --watch src/index.ts`）。

### `apps/web/package.json`

```json
{
  "name": "@emerald-squirrel/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "marked": "^12.0.2",
    "dompurify": "^3.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/dompurify": "^3.0.5",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.7"
  }
}
```

### 依赖 → 需求追溯

| 依赖 | 服务什么 |
|---|---|
| `hono` + `@hono/node-server` | 后端框架 + SSE（01 选型） |
| `better-sqlite3` | DB 客户端；`loadExtension` 加载 sqlite-vec（10/08 已知坑） |
| `sqlite-vec` | 导入层向量索引（03 Q8） |
| `pdf-parse` / `mammoth` / `cheerio` | 文本提取（03 Q5） |
| `pino` | 结构化日志（08） |
| `marked` + `dompurify` | markdown 渲染 + XSS sanitize（06/08） |
| `react` / `vite` | 前端（01 选型） |

无 embedding 客户端依赖：Ollama 走 HTTP fetch（08 环境变量 `EMBEDDING_BASE_URL`）。

## 配置

### `apps/server/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### `apps/web/vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:61127' },   // 08：PORT 默认 61127
  },
})
```

## 开发 / 运行

```bash
pnpm install          # 首次
pnpm dev              # 并行起 server(61127) + vite(5173，代理 /api)
pnpm build            # 构建前端到 apps/web/dist
pnpm start            # 生产形态：server 直跑 + 托管 dist（同 htwm-wiki index.ts 的静态资源段）
```

生产部署、systemd unit、备份 timer 照 08 执行，service 文件放 `deploy/emerald-squirrel.service`。

## 建项目顺序

1. 本目录树 + 3 个 package.json + workspace yaml → `pnpm install`
2. `migrations/001_init.sql`（10 的 DDL）+ `db.ts` 连接与 migration 执行器
3. `tools.json`（11 的 7 个 schema 原样落盘）
4. `llm.ts` 工具循环 + SSE（09 事件协议）
5. `notes.ts` / `imports.ts` / `sessions.ts`
6. 前端按 12 组件树逐块实现，样式实施期扒 WeKnora（06）
