# 后端 API。前端是静态文件，由宿主机上的 nginx 直接托管，不进这个镜像。
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY data ./data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
