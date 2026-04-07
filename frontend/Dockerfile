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
# Copy standalone output (includes server.js + node_modules with next)
COPY --from=builder /app/frontend/.next/standalone ./
# Copy static assets
COPY --from=builder /app/frontend/.next/static .next/static/
# For workspace monorepos, standalone may place next in node_modules/ or frontend/node_modules/
# Ensure node_modules from build are available as fallback
COPY --from=builder /app/node_modules/next node_modules/next/
USER app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000 || exit 1
CMD ["node", "server.js"]
