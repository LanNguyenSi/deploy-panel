FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci --workspace=frontend

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY frontend/ frontend/
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
#   unhealthy: Docker starts the next probe one interval after the previous
#     one COMPLETES, so a refused probe (fails fast) is reported by about
#     15 + 4 x 5 = ~31s, and the worst case (hung probe, every counted probe
#     hits the timeout) by 15 + 4 x (5 + 3) + 3 = 50s, inside the ~60s
#     combined window (failed probes in start-period do not count);
#   steady-state de-route after 4 x 5 = 20s of consecutive failures (>= 15s),
#     so a short blip does not make Traefik drop the container.
# backend/tests/dockerfile-healthcheck.test.ts guards these inequalities.
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=4 CMD node -e "fetch('http://localhost:3000').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
