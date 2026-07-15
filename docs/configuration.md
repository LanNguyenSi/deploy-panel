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
| `APP_SECRETS_KEY`       | No*      | (dev-only insecure fallback)     | Encryption key for per-app secrets stored in the panel's own DB (see "App secrets" below). Running the backend directly on the host (`make dev`) falls back to a fixed, insecure key with a console warning when unset; the backend throws on first use if unset with `NODE_ENV=production`. `docker-compose.yml` has no fallback default for this var at all (unlike `SESSION_SECRET`), so an unset key fails the WHOLE backend's startup validation under `docker compose up`, not just secret operations — see "App secrets" below. Independent of `SESSION_SECRET` on purpose — rotating the session secret must not brick stored app secrets. |
| `NEXT_PUBLIC_API_URL`   | No       | `http://localhost:3001`          | API URL the frontend calls           |
| `POSTGRES_USER`         | No       | `deploy_panel`                   | PostgreSQL user (Docker)             |
| `POSTGRES_PASSWORD`     | No       | `deploy_panel`                   | PostgreSQL password (Docker)         |
| `POSTGRES_DB`           | No       | `deploy_panel`                   | PostgreSQL database name (Docker)    |
| `FRONTEND_PORT`         | No       | `3000`                           | Host port for the frontend container |

`PANEL_TOKEN` is one of the Bearer credentials accepted on `/api/v1` (a `dp_` API key is the other, and is what the bundled GitHub Action uses). It is optional in development, where the backend falls through as admin when no token is set. In production it is effectively required: with no `PANEL_TOKEN` set, the auth middleware has no configured secret and rejects every request to an authenticated route with a 500 before any credential is checked. Treat it like a service account token.

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
make setup       # installs deps, brings up the Docker stack, prisma generate + db push
make dev         # backend on :3001, frontend on :3000
```

`make setup` is idempotent: rerunning it is the way to pick up a fresh schema after pulling. For a deeper reset, `make clean && make setup` wipes `node_modules` and `dist` first.

## Docker deployment

The `docker-compose.yml` runs PostgreSQL, the backend, and the frontend as containers. Multi-stage builds use Node 22 Alpine; the backend runs `prisma db push` to sync the schema on startup via its entrypoint script.

```bash
cp .env.example .env
# at minimum, set:
#   SESSION_SECRET to a real 32+ char value
#   APP_SECRETS_KEY to a generated value (openssl rand -hex 32) — REQUIRED
#     for docker compose specifically: unlike SESSION_SECRET, this var has
#     no fallback default in docker-compose.yml, so the backend refuses to
#     start at all without it (see "App secrets" below)
#   NEXT_PUBLIC_API_URL to the public URL where the backend will be reachable
#   PANEL_TOKEN if you want CI/CD endpoints

docker compose up -d --build
```

Container behaviour:

- `db`: PostgreSQL 16 Alpine, persistent volume `pgdata`, healthcheck via `pg_isready`.
- `backend`: multi-stage build, runs `prisma db push` to sync the schema on startup, exposes `:3001` internally. Healthcheck hits `/api/health`. Not published to the host by default.
- `frontend`: multi-stage build with Next.js standalone output, published on `${FRONTEND_PORT:-3000}`.

The backend waits for the db health check before starting, and the frontend waits for the backend health check. Put a real reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front of the frontend container for TLS.

## App secrets

Per-app secrets (e.g. an app's `METRICS_API_TOKEN`) are stored encrypted in the panel's own database, not in the app's untracked `.env` on the VPS — that file is wiped by `git clean -fdx` / re-clone, which is exactly the failure mode this replaces (see the 2026-06-07 triologue-health-dashboard incident: a required token was never provisioned outside a hand-written `.env`, so a clean re-deploy silently crashlooped).

- `PUT /api/servers/:serverId/apps/:name/secrets/:key` with `{ "value": "..." }` sets (or updates) one secret. Write-only: no route ever returns a value once set, only the key name and whether it's set (`GET .../secrets`).
- `PUT /api/servers/:serverId/apps/:name/required-env-keys` with `{ "keys": [...] }` declares which env keys the app requires to run.
- Every **deploy** (panel button, bulk-deploy, `/api/v1/deploy`, and scheduled deploys — all of them funnel through the same `streamDeploy()`) re-applies the app's stored secrets into the relay's `.env` before compose runs (idempotent — a no-op write if nothing changed), then hard-fails the deploy (and `GET .../preflight`) if a declared-required key still resolves empty/unset.
- **Rollback is exempt.** `POST /api/servers/:serverId/apps/:name/rollback` and `POST /api/v1/rollback` do NOT provision secrets or run the required-env gate — a rollback restarts a previously-deployed commit's containers in place, reusing whatever `.env` is already on disk, rather than pulling a new git ref and re-running compose from a possibly-cleaned working tree. If a rollback target predates when a required key was declared, provisioning it is out of scope for this mechanism; re-run a forward deploy to provision and gate.

## Production checklist

- `SESSION_SECRET` set to a strong random value (not the placeholder).
- `APP_SECRETS_KEY` set to a strong random value if you use per-app secrets (see above) — without it the backend refuses to store or read them.
- `NEXT_PUBLIC_API_URL` points at the public backend URL, not `localhost`.
- `CORS_ORIGINS` lists exactly the origins you want to allow (comma-separated, no trailing slashes).
- `PANEL_TOKEN` set if any CI/CD pipeline calls `/api/v1`.
- TLS terminated at the reverse proxy.
- `scripts/smoke-check.sh` runs green against the deployed URL (see README "Development" section).
