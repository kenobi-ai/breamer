# syntax=docker/dockerfile:1

ARG BREAMER_TARGETPLATFORM=linux/amd64

FROM --platform=$BREAMER_TARGETPLATFORM oven/bun:1-debian AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts \
  && bun install --ignore-scripts --no-save @rollup/rollup-linux-x64-gnu@4.61.1

FROM deps AS build
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN bun run build

FROM --platform=$BREAMER_TARGETPLATFORM oven/bun:1-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOST=0.0.0.0 \
    PORT=3000 \
    HEADLESS=true \
    PAGE_TIMEOUT_MS=300000 \
    CHROME_HEAP_SIZE_MB=4096 \
    CHROME_DEBUG_PORT=9222 \
    BROWSER_WIDTH=1440 \
    BROWSER_HEIGHT=900 \
    BROWSER_DEVICE_SCALE_FACTOR=1 \
    BROWSER_LOCALE=en-US,en \
    CDP_PROXY=true \
    CDP_PROXY_PATH=/cdp \
    SHUTDOWN_PATH=/shutdown \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fontconfig \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    fonts-freefont-ttf \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    xdg-utils \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit optional --ignore-scripts \
  && rm -rf /root/.bun/install/cache

COPY --from=build /app/dist ./dist

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const token = process.env.ACCESS_TOKEN; const headers = token ? { authorization: 'Bearer ' + token } : undefined; fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', { headers }).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "dist/container.js"]
