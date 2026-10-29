# Configuration

deploy-panel is configured entirely via environment variables. Neither the backend nor the frontend load `.env` themselves when run on the host (`make dev`, `npm run dev`, or the bare Prisma CLI from inside `backend/`): the shell running them needs the repo-root `.env` (see `.env.example`) already exported, for example `set -a; . ./.env; set +a`, or a tool like direnv. Running the Prisma CLI from the repo root with `--schema backend/prisma/schema.prisma` is the one exception: Prisma's own dotenv loading then picks up the root `.env` file directly, without a shell export (see "Local development" below). `docker compose` reads the repo-root `.env` only to fill the `${...}` placeholders in the compose file; a container receives only the variables listed under its `environment:` key (see "Docker deployment" below).

## Prerequisites

- Node.js 20+
- Docker (for the local PostgreSQL container)
- A reachable [agent-relay](https://github.com/LanNguyenSi/agent-relay) instance per VPS you want to manage

## Environment variables

| Variable                | Required | Default                          | Description                          |
|-------------------------|----------|----------------------------------|--------------------------------------|
| `DATABASE_URL`          | Yes      | (none)                           | PostgreSQL connection string         |
| `SESSION_SECRET`        | No       | (none)                           | Reserved; nothing reads it at present, so startup does not require it. GitHub sessions are random tokens stored hashed in the `sessions` table, and the admin `panel_session` cookie carries the `PANEL_TOKEN` itself. When set it must be at least 16 characters (a shorter value fails the startup config check); an empty value counts as unset |
| `PANEL_TOKEN`           | No       | (none)                           | Admin credential (an empty value fails startup validation, so leave it unset rather than empty): the UI login token and a Bearer token for the authenticated API routes, including `/api/v1`. Required when `NODE_ENV=production` (see below) |
| `PORT`                  | No       | `3001`                           | Backend port                         |
| `CORS_ORIGINS`          | No       | `http://localhost:3000`          | Allowed CORS origins (comma-separated) |
| `FRONTEND_URL`          | No       | `http://localhost:3000`          | Frontend URL the GitHub OAuth callback redirects to after login or on error |
| `BACKEND_URL`           | No       | `http://localhost:3001`          | Absolute backend URL, used to build the OAuth callback redirect |
| `NODE_ENV`              | No       | `development` (host run); `production` under `docker-compose.yml` unless `.env` sets it | Node environment. `.env.example` sets `development`, which overrides the compose `production` default when that file is copied to `.env` (remove the line for a `docker compose` run) |
| `GITHUB_CLIENT_ID`      | No       | (empty)                          | GitHub OAuth App client ID. When unset (or `GITHUB_CLIENT_SECRET` unset), `/api/auth/github/*` returns 503 and the frontend hides the button |
| `GITHUB_CLIENT_SECRET`  | No       | (empty)                          | GitHub OAuth App client secret. Pair with `GITHUB_CLIENT_ID` to enable the standalone GitHub login flow |
| `ALLOWED_GITHUB_LOGINS` | No       | (empty)                          | Comma-separated GitHub logins allowed through the native OAuth login and the identity-broker endpoint. Empty means "any verified GitHub user" (back-compat) |
| `PANEL_SELF_APP_NAME`   | No       | `deploy-panel`                   | Relay app name the panel is registered under. The stuck-deploy sweep keeps the preflight-only recovery verdict for this app (a self-deploy replaces the panel itself); every other app needs relay proof that the deploy reached its target before it is recovered as `success`. The match is by app name only (no other signal identifies the panel), and `docker-compose.yml` / `docker-compose.prod.yml` forward the var to the backend (empty means the default) |
| `APP_SECRETS_KEY`       | No*      | (dev-only insecure fallback)     | Encryption key for per-app secrets stored in the panel's own DB (see "App secrets" below). Running the backend directly on the host (`make dev`) falls back to a fixed, insecure key with a console warning when unset; the backend throws on first use if unset with `NODE_ENV=production`. `docker-compose.yml` has no fallback default for this var at all (unlike the optional variables such as `SESSION_SECRET`), so an unset key fails the WHOLE backend's startup validation under `docker compose up`, not just secret operations; see "App secrets" below. Independent of `SESSION_SECRET` on purpose: rotating the session secret must not brick stored app secrets. |
| `NEXT_PUBLIC_API_URL`   | No       | `http://localhost:3001`          | Backend origin the browser calls (no `/api` suffix). Inlined into the frontend at build time: after changing it, rebuild the frontend (for Docker, `docker compose up -d --build frontend`) |
| `POSTGRES_USER`         | No       | `deploy_panel`                   | PostgreSQL user (Docker)             |
| `POSTGRES_PASSWORD`     | No       | `deploy_panel`                   | PostgreSQL password (Docker)         |
| `POSTGRES_DB`           | No       | `deploy_panel`                   | PostgreSQL database name (Docker)    |
| `FRONTEND_PORT`         | No       | `3000`                           | Host port for the frontend container |

`PANEL_TOKEN` is one of the Bearer credentials accepted on `/api/v1` (a `dp_` API key is the other, and is what the bundled GitHub Action uses). It is optional in development, where the backend falls through as admin when no token is set. In production it is effectively required: with no `PANEL_TOKEN` set, the auth middleware has no configured secret and rejects every request to an authenticated route with a 500 before any credential is checked. Treat it like a service account token.

## Authentication

The admin login is the `PANEL_TOKEN`: the login page posts it to `POST /api/auth/login` (`{ "token": "<PANEL_TOKEN>" }`), which sets an HttpOnly `panel_session` cookie for 24 hours. Two GitHub-backed paths give non-admin users access on top of that:

1. **Standalone GitHub OAuth login.** Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a [GitHub OAuth App](https://github.com/settings/developers); set `BACKEND_URL` for any non-localhost deployment so the callback URL resolves to the public host. The callback URL registered on the OAuth App must be `${BACKEND_URL}/api/auth/github/callback`. With client ID/secret unset, `/api/auth/github/*` returns 503 and the frontend hides the "Sign in with GitHub" button.
2. **Identity-broker registration.** An identity broker such as [project-pilot](https://github.com/LanNguyenSi/project-pilot) (or any caller holding a user's GitHub token; the endpoint is public) calls `POST /api/auth/register-from-project-pilot` with a user's GitHub access token; deploy-panel re-verifies the token against `api.github.com/user` (it does not blindly trust the broker) and mints a `dp_...` API token.

`ALLOWED_GITHUB_LOGINS` applies to both paths: if set, the verified GitHub login must appear in the comma-separated list, otherwise the broker request is rejected with 403 and the OAuth callback redirects to `/login?error=forbidden_github_login`. Leave it empty to allow any verified user (back-compat).

Both paths resolve to the same User row (matched by GitHub id), so a user ends up on one account either way. To sign out admin cookies, rotate `PANEL_TOKEN`; to revoke GitHub sessions, delete the user's rows from the `sessions` table.

## Local development

The `.env.example` already wires everything to the docker-compose defaults, so for local dev you typically edit nothing (`SESSION_SECRET` is optional and commented out there). Set `PANEL_TOKEN` only to exercise authentication (the UI token login and Bearer calls): without it, a development backend treats every request as admin.

```bash
cp .env.example .env
npm install
docker compose up -d db                          # Postgres only, published on 127.0.0.1:5433
npx prisma generate --schema backend/prisma/schema.prisma
set -a; . ./.env; set +a                         # export .env into the shell; make dev below doesn't load it itself
sh backend/scripts/migrate.sh                    # apply the committed migrations; reads the exported DATABASE_URL
make dev                                          # backend on :3001, frontend on :3000
```

Running a Prisma command as `cd backend && npx prisma ...` instead fails with `P1012 Environment variable not found: DATABASE_URL`: Prisma 5.22 looks for `.env` next to `backend/package.json` and the schema, not at the repo root. `backend/scripts/migrate.sh` changes into the repo root itself and passes `--schema backend/prisma/schema.prisma`; run other Prisma commands from the repo root with the same `--schema` flag. `make dev` does not load `.env` itself: export it into the shell first (see `backend/tests/env-loading-guard.test.ts`), otherwise the backend starts without `DATABASE_URL`, `PANEL_TOKEN` and the other variables; neither `make` nor the `tsx watch` process it starts read `.env` on their own.

`make setup` also exists (install, then `make docker-up` for the full db + backend + frontend Docker stack, then Prisma generate and migrate), but its Docker stack fails to start the backend container without `APP_SECRETS_KEY` set in `.env` (commented out in `.env.example`; see the "App secrets" section and the `APP_SECRETS_KEY` row above), and once that is set, its frontend container occupies host port 3000, the same port `make dev` binds on the host. Bring up only `db` as shown above for host-run dev with hot reload; use `make setup` / `make docker-up` only when you want the full stack running in containers (see "Docker deployment" below). After pulling a schema change, rerun the generate line and `sh backend/scripts/migrate.sh` above (or `make db-generate` / `make db-migrate` after exporting `.env`). A local database that an older checkout filled with `prisma db push` is baselined automatically when it matches the schema; if it differs the script refuses and says how, or run `docker compose down -v` and start the db again for a clean one. For a deeper reset, `make clean` wipes `node_modules` and build output (`backend/dist`, `frontend/.next`) first, then rerun `npm install`.

## Docker deployment

The `docker-compose.yml` runs PostgreSQL, the backend, and the frontend as containers. Multi-stage builds use Node 22 Alpine; the backend applies the committed Prisma migrations on startup via its entrypoint script (see [Database migrations](#database-migrations)).

```bash
cp .env.example .env
# at minimum, set:
#   APP_SECRETS_KEY to a generated value (openssl rand -hex 32) — REQUIRED
#     for docker compose specifically: this var has no fallback default in
#     docker-compose.yml, so the backend refuses to start at all without it
#     (see "App secrets" below)
#   NEXT_PUBLIC_API_URL to the public origin where the browser reaches the
#     backend (no /api suffix)
#   NODE_ENV=production, or delete the NODE_ENV line (.env.example sets
#     development, which would override the compose default)

docker compose up -d --build
```

`docker-compose.yml` forwards `DATABASE_URL`, `PORT`, `SESSION_SECRET`, `APP_SECRETS_KEY`, `CORS_ORIGINS`, `FRONTEND_URL`, `NODE_ENV`, `PANEL_SELF_APP_NAME`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BACKEND_URL` and `ALLOWED_GITHUB_LOGINS` from `.env` to the backend. The optional ones default to empty (`BACKEND_URL` to `http://localhost:3001`), and the backend treats an empty `SESSION_SECRET` as unset. `PANEL_TOKEN` is deliberately not forwarded: an empty value fails the startup config check and production requires a token, so an empty default would stop the backend from starting. Add it to the backend's `environment:` in an override file, as `docker-compose.ci.yml` does, or take it from `docker-compose.prod.yml`, which forwards it. Without `PANEL_TOKEN`, a backend in development mode treats every request as admin, and a backend in production mode answers 500 on every authenticated route.

Container behaviour:

- `db`: PostgreSQL 16 Alpine, persistent volume `pgdata`, healthcheck via `pg_isready`, published on 127.0.0.1:5433 (loopback only) for host-run dev tooling.
- `backend`: multi-stage build, applies the committed Prisma migrations (`prisma migrate deploy`) on startup before the server binds its port, exposes `:3001` internally. Healthcheck hits `/api/health`. Not published to the host by default. Reachable only from the compose network; route `/api` to it from your proxy.
- `frontend`: multi-stage build with Next.js standalone output, published on `${FRONTEND_PORT:-3000}`.

The backend waits for the db health check before starting, and the frontend waits for the backend health check.

The frontend is client-side code: the browser calls the backend directly at `NEXT_PUBLIC_API_URL`, with cookies. `docker-compose.yml` does not publish the backend, so the reverse proxy (Caddy, nginx, Cloudflare Tunnel) that terminates TLS must serve both containers, for example `/api` to `backend:3001` and everything else to `frontend:3000` on the same host. That requires the proxy on the compose network or a published backend port. `NEXT_PUBLIC_API_URL` is then that public origin without a trailing `/api`, and `CORS_ORIGINS` lists the frontend origin. `docker-compose.prod.yml` shows this layout with Traefik labels and is the template to copy; replace its hostnames and the external `traefik` network.

## Database migrations

The schema is applied by the committed Prisma migrations in `backend/prisma/migrations`, never by `prisma db push`. The backend image carries the Prisma CLI at the version `package-lock.json` pins (`prisma` is a runtime dependency), so a start needs no registry access. The entrypoint (`backend/backend-entrypoint.sh`) runs `backend/scripts/migrate.sh` on every start and only then starts the server; `make db-migrate` and `sh backend/scripts/migrate.sh` run the same script against a host-run database (`DATABASE_URL` exported). The script decides by the state of the database:

| Database | What the script does |
|----------|----------------------|
| Has `_prisma_migrations` | `prisma migrate deploy` (applies the pending migrations, none is fine) |
| Empty | `prisma migrate deploy`; the baseline migration creates every table |
| Tables but no `_prisma_migrations` (a database from the `db push` releases), identical to `schema.prisma` (`prisma migrate diff --exit-code` is 0) | `prisma migrate resolve --applied 20261029120000_baseline` once, then `prisma migrate deploy`. The baseline SQL is not run, no data is touched |
| Tables but no `_prisma_migrations`, differs from `schema.prisma` | Changes nothing, prints the difference and exits 1 |

The entrypoint retries only exit 3 ("could not check", typically the database is not accepting connections yet) up to 10 times, 2 seconds apart. Every other failure (a differing database, a failing migration) ends the container at once, so `docker compose logs backend` and the container's restart loop show the message. Nothing in this path downloads from the npm registry.

**A differing legacy database.** Back it up (`pg_dump`). Then either change the database to match the schema (`npx prisma migrate diff --from-schema-datasource backend/prisma/schema.prisma --to-schema-datamodel backend/prisma/schema.prisma --script` prints the SQL; it can drop columns and data, review it) or, when the difference is known to be harmless, record the baseline by hand with `npx prisma migrate resolve --applied 20261029120000_baseline --schema backend/prisma/schema.prisma`, then start the backend again. Do not run `prisma db push`.

**A failed migration.** Prisma records it in `_prisma_migrations` and refuses further deploys (`P3009`) until it is resolved. Fix the cause, then mark it with `prisma migrate resolve --rolled-back <name>` (after undoing its partial effects by hand) or `--applied <name>` (when the effects are complete) and start the backend again.

**One-time step in production.** The first start of a release with migrations finds a database that `db push` filled. If it equals `schema.prisma` the script baselines it by itself; if not, the backend refuses to start and the relay rolls the code back (the database is untouched). Check before that deploy, and take a `pg_dump` backup:

```bash
# inside the running container of the release that still runs db push (its image has no
# CLI; npx fetches it, so pin the version). The command compares the live database with
# the schema file in that container, which is the release's schema as long as the release
# does not change schema.prisma; otherwise copy the new schema.prisma in and point to it.
docker exec deploy-panel-backend npx prisma@5.22.0 migrate diff \
  --from-url "$DATABASE_URL" --to-schema-datamodel backend/prisma/schema.prisma --exit-code
```

It must print "No difference detected" (exit 0). Exit 2 prints the difference: fix the database (see "A differing legacy database") before deploying. After the deploy, `_prisma_migrations` holds one row, `20261029120000_baseline`, and the log shows "recording the baseline migration".

**Changing the schema.** Add a migration with the schema change in the same PR; the rule and the commands are in `backend/prisma/migrations/README.md`. CI applies the migrations to an empty Postgres and fails when the result differs from `schema.prisma`.

## Rollback and the database schema

`.relay.yml` sets `rollback: true`. A relay rollback runs `git reset --hard` to the previous commit, then rebuilds and restarts the previous image. It restores code and image only. It does not revert the database: migrations are forward-only. A previous release that already has migrations finds a history that is ahead of its own `prisma/migrations` folder; `prisma migrate deploy` then applies nothing and the old backend starts against the newer schema (checked against a database holding a migration the checkout does not have). Rolling back past the first release with migrations, to one that still ran `prisma db push`, is worse: that `db push` drops columns it does not know (checked with an empty extra column; a column holding data makes it stop and ask for `--accept-data-loss`, which the entrypoint cannot give).

What that means for a release:

- A migration that only adds (nullable columns, columns with a default, new tables or indexes) is safe to roll back over; the previous code ignores what it does not know.
- A migration the previous code cannot work with (drop or rename of a column or table, a new NOT NULL column without a default) turns a rollback into a different failure: the old backend meets the new schema. Ship such a change in two releases (expand, then contract once nothing reads the old shape), or plan a manual step: restore the pre-deploy `pg_dump` backup, or write a compensating migration and deploy it.
- A migration that fails during the deploy leaves the container unhealthy, the relay rolls the code back, and the database stays as the failed migration left it (see "A failed migration" above).

The panel's health check, which the relay uses to decide on a rollback, only passes after the migrations applied, because the server binds its port after the entrypoint's migration step.

## App secrets

Per-app secrets (e.g. an app's `METRICS_API_TOKEN`) are stored encrypted in the panel's own database, not in the app's untracked `.env` on the VPS. That file is wiped by `git clean -fdx` / re-clone, which is exactly the failure mode this replaces: a required token that lived only in a hand-written `.env` is lost on a clean re-deploy and the app crashloops.

- `PUT /api/servers/:serverId/apps/:name/secrets/:key` with `{ "value": "..." }` sets (or updates) one secret. Write-only: no route ever returns a value once set, only the key name and whether it's set (`GET .../secrets`).
- `PUT /api/servers/:serverId/apps/:name/required-env-keys` with `{ "keys": [...] }` declares which env keys the app requires to run.
- Every **deploy** (panel button, bulk-deploy, `/api/v1/deploy`, and scheduled deploys — all of them funnel through the same `streamDeploy()`) re-applies the app's stored secrets into the relay's `.env` before compose runs (idempotent — a no-op write if nothing changed), then hard-fails the deploy (and `GET .../preflight`) if a declared-required key still resolves empty/unset.
- **Rollback is exempt.** `POST /api/servers/:serverId/apps/:name/rollback` and `POST /api/v1/rollback` do NOT provision secrets or run the required-env gate — a rollback restarts a previously-deployed commit's containers in place, reusing whatever `.env` is already on disk, rather than pulling a new git ref and re-running compose from a possibly-cleaned working tree. If a rollback target predates when a required key was declared, provisioning it is out of scope for this mechanism; re-run a forward deploy to provision and gate.

## Security model

### Credentials

- `PANEL_TOKEN` is the admin credential. It is accepted as a Bearer token, and the UI login stores it in the `panel_session` cookie (HttpOnly, SameSite=Strict, 24 hours). The cookie holds the token itself, so rotating `PANEL_TOKEN` signs out every admin browser.
- `dp_` API keys are Bearer credentials. A key bound to a user (the identity broker issues these) acts as that user; a key without a user binding acts as admin.
- A native GitHub OAuth login creates a non-admin session: a random token in the `user_session` cookie (HttpOnly, SameSite=Lax), stored as a SHA-256 hash in the `sessions` table and valid for 30 days.
- There is no CSRF token. Cross-site requests are limited by `CORS_ORIGINS` and the cookies' SameSite attribute (Strict for the admin cookie, Lax for GitHub sessions).

### Visibility

Non-admin actors (GitHub sessions and user-bound API keys) see only the servers they created, and the apps, deploys and scheduled deploys on them. Servers an admin created have no owner (`Server.userId` is null) and stay invisible to non-admin actors. Details: [okf/auth-and-ownership-model.md](okf/auth-and-ownership-model.md).

### Public endpoints

`/api/health` and everything under `/api/auth` answer without authentication. That includes the identity-broker endpoint `POST /api/auth/register-from-project-pilot`, which accepts any caller holding a valid GitHub token. With `ALLOWED_GITHUB_LOGINS` empty (the default), any GitHub account can create a non-admin user through the OAuth login or the broker endpoint, so set it on any panel reachable from the internet.

### Data at rest

- Relay tokens are stored in plaintext in the `servers` table (`relayToken`).
- App secrets are encrypted with `APP_SECRETS_KEY` (AES-256-GCM).
- Session tokens and API keys are stored as SHA-256 hashes.

### Relay install

The install wizard sends the SSH password or private key to the backend with the request; the backend uses it for that connection and does not store it. On the target, the wizard runs agent-relay's `install.sh` from that repository's `main` branch with `sudo -E bash`. Details: [okf/vps-onboarding-relay-provisioning.md](okf/vps-onboarding-relay-provisioning.md).

## Production checklist

- `APP_SECRETS_KEY` set to a strong random value (`openssl rand -hex 32`). Both compose files pass it without a default, so the backend does not start without it; a host-run backend refuses to store or read app secrets without it.
- `NEXT_PUBLIC_API_URL` points at the public backend URL, not `localhost`, and the frontend image was rebuilt after setting it.
- `CORS_ORIGINS` lists exactly the origins you want to allow (comma-separated, no trailing slashes).
- `PANEL_TOKEN` set: in production every authenticated route and the UI login need it, not only `/api/v1`.
- `ALLOWED_GITHUB_LOGINS` set when the panel is reachable from the internet (see "Security model").
- TLS terminated at the reverse proxy.
- `scripts/smoke-check.sh` runs green against the deployed URL (see README "Development" section).
