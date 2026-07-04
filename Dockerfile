# ============ DREINNIFY DOCKERFILE ============
FROM node:20-bookworm-slim

# Установка системных зависимостей: ffmpeg, canvas, sqlite, python
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    sqlite3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ставим зависимости отдельным слоем для кеширования
COPY package.json ./
RUN npm install --omit=dev --unsafe-perm

# Копируем весь код (кроме .env — он монтируется на стороне хостинга)
COPY server.js ./
COPY views ./views
COPY public ./public

# Создаём тома для базы и загрузок (перезаписываются volume-ом хоста)
RUN mkdir -p /app/data /app/public/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
