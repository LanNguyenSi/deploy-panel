FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci --workspace=frontend

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY frontend/ frontend/
# next 15.5.x no longer hoists to the workspace root node_modules,
# so the binary lives at frontend/node_modules/.bin/next. Copy the
# nested workspace deps AFTER `COPY frontend/ frontend/` so the
# source copy does not stomp the just-installed modules.
COPY --from=deps /app/frontend/node_modules frontend/node_modules/
COPY package.json ./
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace=frontend

FROM node:22-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/frontend/.next/standalone ./
COPY --from=builder /app/frontend/.next/static .next/static/
COPY --from=builder /app/frontend/public public/
# Standalone in workspace monorepo needs full node_modules
COPY --from=deps /app/node_modules node_modules/
USER app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
