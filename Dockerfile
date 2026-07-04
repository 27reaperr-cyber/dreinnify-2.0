# === Dreinnify Docker образ ===
FROM node:20-bookworm-slim

# Системные пакеты: ffmpeg для аудио, canvas-зависимости, sqlite runtime
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
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Устанавливаем зависимости отдельным слоем — кешируется до изменений package.json
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Код проекта (без .env — он монтируется хостингом)
COPY server.js ./
COPY public ./public

# Персистентное хранилище БД + генерируемых картинок
RUN mkdir -p /app/data /app/public/generated
VOLUME ["/app/data", "/app/public/generated"]

EXPOSE 3000

# Non-root запуск
RUN useradd -u 1001 -m dreinnify && chown -R dreinnify:dreinnify /app
USER dreinnify

CMD ["node", "server.js"]
