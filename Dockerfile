# ============================================================
# dsh-cost-cloud 镜像
# 零 npm 运行时依赖：只需 Node 内置模块（node:http / node:sqlite / node:crypto）
# ============================================================
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_OPTIONS=--no-warnings

WORKDIR /app

# 仅复制运行所需文件（无 node_modules、无构建步骤）
COPY package.json ./
COPY src ./src
COPY web ./web
COPY docs ./docs
COPY scripts ./scripts

RUN mkdir -p /data && addgroup -S dshc && adduser -S dshc -G dshc && chown -R dshc:dshc /data /app
USER dshc

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "src/main.js", "start"]
