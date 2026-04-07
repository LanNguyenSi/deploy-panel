FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY backend/prisma/ backend/prisma/
RUN npm ci --workspace=backend && npx prisma generate --schema=backend/prisma/schema.prisma
COPY backend/tsconfig.json backend/
COPY backend/src/ backend/src/
RUN npm run build --workspace=backend

FROM node:22-alpine
RUN apk add --no-cache openssl
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY backend/prisma/ backend/prisma/
RUN npm ci --workspace=backend --omit=dev && npx prisma generate --schema=backend/prisma/schema.prisma && npm cache clean --force
COPY --from=builder /app/backend/dist backend/dist/
COPY backend/backend-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3001/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "backend/dist/server.js"]
