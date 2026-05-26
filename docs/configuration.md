# Configuration

deploy-panel is configured entirely via environment variables. The backend and frontend each load their own values; in local dev, both pick up `.env` at the repo root (see `.env.example`).

## Prerequisites

- Node.js 20+
- Docker (for the local PostgreSQL container)
- A reachable [agent-relay](https://github.com/LanNguyenSi/agent-relay) instance per VPS you want to manage

## Environment variables

| Variable                | Required | Default                          | Description                          |
|-------------------------|----------|----------------------------------|--------------------------------------|
| `DATABASE_URL`          | Yes      | (none)                           | PostgreSQL connection string         |
| `SESSION_SECRET`        | Yes      | (none)                           | Session signing secret, min 16 chars |
| `PANEL_TOKEN`           | No       | (none)                           | Bearer token for `/api/v1` (CI/CD) endpoints |
| `PORT`                  | No       | `3001`                           | Backend port                         |
| `CORS_ORIGINS`          | No       | `http://localhost:3000`          | Allowed CORS origins (comma-separated) |
| `FRONTEND_URL`          | No       | `http://localhost:3000`          | Frontend URL (used for redirects, CSRF) |
| `BACKEND_URL`           | No       | `http://localhost:3001`          | Absolute backend URL, used to build the OAuth callback redirect |
| `NODE_ENV`              | No       | `development`                    | Node environment                     |
| `GITHUB_CLIENT_ID`      | No       | (empty)                          | GitHub OAuth App client ID. When unset (or `GITHUB_CLIENT_SECRET` unset), `/api/auth/github/*` returns 503 and the frontend hides the button |
| `GITHUB_CLIENT_SECRET`  | No       | (empty)                          | GitHub OAuth App client secret. Pair with `GITHUB_CLIENT_ID` to enable the standalone GitHub login flow |
| `ALLOWED_GITHUB_LOGINS` | No       | (empty)                          | Comma-separated GitHub logins allowed via the identity-broker endpoint. Empty means "any verified GitHub user" (back-compat) |
| `NEXT_PUBLIC_API_URL`   | No       | `http://localhost:3001`          | API URL the frontend calls           |
| `POSTGRES_USER`         | No       | `deploy_panel`                   | PostgreSQL user (Docker)             |
| `POSTGRES_PASSWORD`     | No       | `deploy_panel`                   | PostgreSQL password (Docker)         |
| `POSTGRES_DB`           | No       | `deploy_panel`                   | PostgreSQL database name (Docker)    |
| `FRONTEND_PORT`         | No       | `3000`                           | Host port for the frontend container |

`PANEL_TOKEN` is optional in dev but required for any `/api/v1` traffic; without it, all v1 endpoints return 401. Treat it like a service account token.

## Authentication

deploy-panel supports two GitHub-backed paths to a panel session, on top of the email/password flow that ships out of the box:

1. **Standalone GitHub OAuth login.** Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a [GitHub OAuth App](https://github.com/settings/developers); set `BACKEND_URL` for any non-localhost deployment so the callback URL resolves to the public host. The callback URL registered on the OAuth App must be `${BACKEND_URL}/api/auth/github/callback`. With client ID/secret unset, `/api/auth/github/*` returns 503 and the frontend hides the "Sign in with GitHub" button.
2. **Identity-broker registration.** A trusted upstream like [project-pilot](https://github.com/LanNguyenSi/project-pilot) calls `POST /api/auth/register-from-project-pilot` with a user's GitHub access token; deploy-panel re-verifies the token against `api.github.com/user` (it does not blindly trust the broker) and mints a `dp_...` API token.

`ALLOWED_GITHUB_LOGINS` applies to both paths: if set, the verified GitHub login must appear in the comma-separated list, otherwise the broker request is rejected with 403 and the OAuth callback redirects to `/login?error=forbidden_github_login`. Leave it empty to allow any verified user (back-compat).

Both paths share the same `SESSION_SECRET` and underlying user record, so a user can sign in via either path and end up on the same account.

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
