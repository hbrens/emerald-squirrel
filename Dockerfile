# syntax=docker/dockerfile:1

# ---- 阶段 1:安装 server 运行时依赖(含原生模块) ----
# 完整版镜像自带工具链(g++/make/python3),作为 prebuild-install 拉不到预编译绑定时的 node-gyp 兜底,免装系统包
FROM node:24 AS deps
RUN npm install -g pnpm@11.18.0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @emerald-squirrel/server \
    && cd apps/server \
    && node -e "const D=require('better-sqlite3');const db=new D(':memory:');import('sqlite-vec').then(v=>{v.load(db);db.exec('CREATE VIRTUAL TABLE t USING vec0(a FLOAT[4])');console.log('native deps ok')})"

# ---- 阶段 2:构建前端静态资源 ----
FROM node:24-slim AS webbuild
RUN npm install -g pnpm@11.18.0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/web/ apps/web/
RUN pnpm --filter @emerald-squirrel/web build

# ---- 阶段 3:运行时 ----
# server 无构建步骤:Node 24 直跑 TS;目录布局须保持 apps/server/src 与 apps/web/dist 的相对关系(index.ts 按 here/../../web/dist 托管静态资源)
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY apps/server/package.json /app/apps/server/package.json
COPY apps/server/src /app/apps/server/src
COPY --from=webbuild /app/apps/web/dist /app/apps/web/dist
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME /data
USER node
EXPOSE 3088
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3088)+'/api/notes').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
