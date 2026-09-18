FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY tests ./tests
COPY .env.example ./
RUN mkdir -p /var/data
ENV NODE_ENV=production PORT=10000 STORAGE_ROOT=/var/data
EXPOSE 10000
CMD ["node","server.js"]
