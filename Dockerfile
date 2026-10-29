FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/build ./build
COPY spotify-config.json ./
EXPOSE 8000
ENV MCP_TRANSPORT=http
ENV PORT=8000
CMD ["node", "build/index.js"]
