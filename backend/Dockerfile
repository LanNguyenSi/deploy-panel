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
# Healthcheck timing is derived from the post-deploy gate windows, not left at
# Docker's defaults (no --start-interval: it needs Docker Engine 25+).
# Window constants: post-deploy-gate.ts verifyDeployHealth polls 4 x 5s
# (~15s base window) and grants 9 extra polls once when the last base poll is
# still "starting" (~60s combined window); deploy-recovery.ts runs
# RECOVERY_ATTEMPTS=5 x RECOVERY_INTERVAL_MS=12s with strict evidence (last
# poll ~48s), where "starting" is not a positive confirmation.
# Derived bounds for the flags below (interval 5s, timeout 3s, start-period
# 15s, retries 4):
#   healthy resolves by ~5s (first probe after one interval, a success marks
#     the container healthy even inside start-period), inside the ~15s base
#     window;
#   unhealthy resolves by 15 + 4 x 5 + 3 = 38s, inside the ~60s combined
#     window (failed probes in start-period do not count);
#   steady-state de-route after 4 x 5 = 20s of consecutive failures (>= 15s),
#     so a short blip does not make Traefik drop the container.
# backend/tests/dockerfile-healthcheck.test.ts guards these inequalities.
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=4 CMD wget -qO- http://localhost:3001/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "backend/dist/server.js"]
