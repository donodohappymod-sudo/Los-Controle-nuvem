FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund --prefer-online

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app /app
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10000
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/sql ./sql
COPY --from=builder /app/scripts ./scripts
RUN mkdir -p /var/data/generated /var/data/uploads
EXPOSE 10000
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
