#
# 石家庄旅游助手 —— 单镜像生产构建(issue #36 PR1/3)
#
# 本项目是"单源托管"架构:NestJS server 同时托管 client 构建产物(client/dist),
# 因此一个镜像即包含 server + client 两部分,无需独立 client 镜像/反向代理。
# 详见 docs/deploy.md。
#
# 构建:  docker build -t shijiazhuang-agent .
# 运行:  docker run --rm -p 3000:3000 shijiazhuang-agent
# 验收:  curl http://localhost:3000/api/version 且浏览器打开 http://localhost:3000

# ---------- 1) 全量依赖层(含 dev):供构建阶段使用 ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund

# ---------- 2) 生产依赖层:同 lockfile 但 --omit=dev,运行期只带这份 ----------
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 3) 构建层:shared → client → server(根 build 脚本已按序编排) ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 4) 运行层:仅带生产依赖与构建产物 ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app

# 根 package.json 保留:workspace 依赖解析需要(node_modules 内有指向 packages/* 的软链)
COPY --from=prod-deps --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/client/dist ./client/dist
# 语料随镜像走,生产可用只读卷覆盖(换语料不必重建镜像)
COPY --from=build --chown=node:node /app/data ./data

USER node
EXPOSE 3000

# /api/version 是轻量只读端点,适合存活探测(compose / K8s 均可复用)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/version || exit 1

CMD ["node", "server/dist/main.js"]
