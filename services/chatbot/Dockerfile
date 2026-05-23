FROM oven/bun:1.3.13-slim

WORKDIR /app
ENV NODE_ENV=production

COPY services/chatbot/package.json services/chatbot/bun.lock ./
RUN bun install --frozen-lockfile

COPY services/chatbot/ ./

EXPOSE 3002
ENV PORT=3002
CMD ["bun", "src/index.ts"]
