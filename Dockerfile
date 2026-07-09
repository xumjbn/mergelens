FROM node:20-alpine

WORKDIR /app

# 代理/镜像环境可覆盖：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
ARG NPM_REGISTRY=https://registry.npmjs.org

COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

# 数据（审查记录/反馈/日志）挂卷持久化：-v mergelens-data:/app/data
VOLUME /app/data

CMD ["node", "dist/cli.js", "serve", "--port", "3000"]
