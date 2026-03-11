FROM node:20-slim AS base

# Install Playwright Chromium system dependencies + curl for healthcheck
RUN apt-get update && apt-get install -y \
    curl \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests for install layer caching
COPY package.json package-lock.json turbo.json ./
COPY packages/types/package.json packages/types/
COPY apps/agent/package.json apps/agent/

# Install all workspace dependencies from root (resolves @verifai/types symlink)
RUN npm ci --workspace=packages/types --workspace=apps/agent

# Copy source
COPY packages/types/ packages/types/
COPY apps/agent/ apps/agent/

# Install Playwright Chromium
RUN cd apps/agent && npx playwright install chromium

# Build TypeScript
RUN cd apps/agent && npm run build

EXPOSE 8080

# Health check — uses PORT env var (Cloud Run injects 8080, local default 3001)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1

CMD ["node", "apps/agent/dist/index.js"]
