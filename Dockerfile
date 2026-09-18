FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY tests ./tests
COPY .env.example ./
RUN mkdir -p /var/data
ENV NODE_ENV=production PORT=10000 STORAGE_ROOT=/var/data
EXPOSE 10000
CMD ["node","server.js"]
