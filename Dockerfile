# syntax=docker/dockerfile:1

ARG BREAMER_TARGETPLATFORM=linux/amd64

FROM --platform=$BREAMER_TARGETPLATFORM oven/bun:1-debian AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY Dockerfile tsconfig.json tsconfig.worker.json wrangler.jsonc ./
COPY src ./src
RUN bun run typecheck

FROM --platform=$BREAMER_TARGETPLATFORM oven/bun:1-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOST=0.0.0.0 \
    PORT=3000 \
    HEADLESS=true \
    CHROME_DEBUG_PORT=9222 \
    CDP_PROXY=true \
    CDP_PROXY_PATH=/cdp \
    SHUTDOWN_PATH=/shutdown \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fontconfig \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libegl1 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libgl1 \
    libgles2 \
    libgtk-3-0 \
    libharfbuzz0b \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libvulkan1 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    mesa-vulkan-drivers \
    xdg-utils \
  && curl -fsSL -o /tmp/google-chrome-stable.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb \
  && rm -f /tmp/google-chrome-stable.deb \
  && font_packages=" \
    fonts-cascadia-code \
    fonts-croscore \
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    fonts-firacode \
    fonts-font-awesome \
    fonts-fork-awesome \
    fonts-hack \
    fonts-inter \
    fonts-liberation2 \
    fonts-material-design-icons-iconfont \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-noto-core \
    fonts-noto-ui-core \
    fonts-open-sans \
    fonts-roboto \
    fonts-symbola \
    fonts-texgyre \
    fonts-urw-base35 \
  " \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $font_packages \
  && rm -rf /var/lib/apt/lists/*

COPY docker/fontconfig/breamer.conf /etc/fonts/conf.d/50-breamer-browser-fonts.conf
RUN fc-cache -f

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit optional --ignore-scripts \
  && rm -rf /root/.bun/install/cache

COPY --from=build /app/src ./src

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const token = process.env.ACCESS_TOKEN; const headers = token ? { authorization: 'Bearer ' + token } : undefined; fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', { headers }).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "src/server.ts"]
