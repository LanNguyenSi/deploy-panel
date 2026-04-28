# Configuration

deploy-panel is configured entirely via environment variables. The backend and frontend each load their own values; in local dev, both pick up `.env` at the repo root (see `.env.example`).

## Prerequisites

- Node.js 20+
- Docker (for the local PostgreSQL container)
- A reachable [agent-relay](https://github.com/LanNguyenSi/agent-relay) instance per VPS you want to manage

## Environment variables

| Variable             | Required | Default                          | Description                          |
|----------------------|----------|----------------------------------|--------------------------------------|
| `DATABASE_URL`       | Yes      | (none)                           | PostgreSQL connection string         |
| `SESSION_SECRET`     | Yes      | (none)                           | Session signing secret, min 16 chars |
| `PANEL_TOKEN`        | No       | (none)                           | Bearer token for `/api/v1` (CI/CD) endpoints |
| `PORT`               | No       | `3001`                           | Backend port                         |
| `CORS_ORIGINS`       | No       | `http://localhost:3000`          | Allowed CORS origins (comma-separated) |
| `FRONTEND_URL`       | No       | `http://localhost:3000`          | Frontend URL (used for redirects, CSRF) |
| `NODE_ENV`           | No       | `development`                    | Node environment                     |
| `NEXT_PUBLIC_API_URL`| No       | `http://localhost:3001`          | API URL the frontend calls           |
| `POSTGRES_USER`      | No       | `deploy_panel`                   | PostgreSQL user (Docker)             |
| `POSTGRES_PASSWORD`  | No       | `deploy_panel`                   | PostgreSQL password (Docker)         |
| `POSTGRES_DB`        | No       | `deploy_panel`                   | PostgreSQL database name (Docker)    |
| `FRONTEND_PORT`      | No       | `3000`                           | Host port for the frontend container |

`PANEL_TOKEN` is optional in dev but required for any `/api/v1` traffic; without it, all v1 endpoints return 401. Treat it like a service account token.

## Local development

The `.env.example` already wires everything to the docker-compose defaults; for local dev you typically only edit `SESSION_SECRET` to something non-default and (if you want CI/CD endpoints) `PANEL_TOKEN`.

```bash
cp .env.example .env
make setup       # installs deps, brings up PostgreSQL, prisma generate + db push
make dev         # backend on :3001, frontend on :3000
```

`make setup` is idempotent: rerunning it is the way to pick up a fresh schema after pulling. For a deeper reset, `make clean && make setup` wipes `node_modules` and `dist` first.

## Docker deployment

The `docker-compose.yml` runs PostgreSQL, the backend, and the frontend as containers. Multi-stage builds use Node 22 Alpine; the backend runs Prisma migrations on startup via its entrypoint script.

```bash
cp .env.example .env
# at minimum, set:
#   SESSION_SECRET to a real 32+ char value
#   NEXT_PUBLIC_API_URL to the public URL where the backend will be reachable
#   PANEL_TOKEN if you want CI/CD endpoints

docker compose up -d --build
```

Container behaviour:

- `db`: PostgreSQL 16 Alpine, persistent volume `pgdata`, healthcheck via `pg_isready`.
- `backend`: multi-stage build, runs Prisma migrations on startup, exposes `:3001` internally. Healthcheck hits `/api/health`. Not published to the host by default.
- `frontend`: multi-stage build with Next.js standalone output, published on `${FRONTEND_PORT:-3000}`.

The backend waits for the db health check before starting, and the frontend waits for the backend health check. Put a real reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front of the frontend container for TLS.

## Production checklist

- `SESSION_SECRET` set to a strong random value (not the placeholder).
- `NEXT_PUBLIC_API_URL` points at the public backend URL, not `localhost`.
- `CORS_ORIGINS` lists exactly the origins you want to allow (comma-separated, no trailing slashes).
- `PANEL_TOKEN` set if any CI/CD pipeline calls `/api/v1`.
- TLS terminated at the reverse proxy.
- `scripts/smoke-check.sh` runs green against the deployed URL (see README "Development" section).
