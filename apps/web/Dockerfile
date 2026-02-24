FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json turbo.json ./
COPY packages/types/package.json packages/types/
COPY apps/web/package.json apps/web/

RUN npm ci --workspace=packages/types --workspace=apps/web

COPY packages/types/ packages/types/
COPY apps/web/ apps/web/

RUN cd apps/web && npm run build

FROM node:20-slim AS runner
WORKDIR /app

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
