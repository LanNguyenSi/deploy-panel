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
npx prisma db push --schema backend/prisma/schema.prisma   # run from the repo root so it picks up the exported DATABASE_URL
make dev                                          # backend on :3001, frontend on :3000
```

Running `cd backend && npx prisma db push` instead fails with `P1012 Environment variable not found: DATABASE_URL`: Prisma 5.22 looks for `.env` next to `backend/package.json` and the schema, not at the repo root. Run it from the repo root with `--schema backend/prisma/schema.prisma` as shown above. `make dev` does not load `.env` itself: export it into the shell first (see `backend/tests/env-loading-guard.test.ts`), otherwise the backend starts without `DATABASE_URL`, `PANEL_TOKEN` and the other variables; neither `make` nor the `tsx watch` process it starts read `.env` on their own.

`make setup` also exists (install, then `make docker-up` for the full db + backend + frontend Docker stack, then Prisma generate/push), but its Docker stack fails to start the backend container without `APP_SECRETS_KEY` set in `.env` (commented out in `.env.example`; see the "App secrets" section and the `APP_SECRETS_KEY` row above), and once that is set, its frontend container occupies host port 3000, the same port `make dev` binds on the host. Bring up only `db` as shown above for host-run dev with hot reload; use `make setup` / `make docker-up` only when you want the full stack running in containers (see "Docker deployment" below). After pulling a schema change, rerun the two `npx prisma ... --schema backend/prisma/schema.prisma` lines above (or `make db-generate` / `make db-push` after exporting `.env`). For a deeper reset, `make clean` wipes `node_modules` and build output (`backend/dist`, `frontend/.next`) first, then rerun `npm install`.

## Docker deployment

The `docker-compose.yml` runs PostgreSQL, the backend, and the frontend as containers. Multi-stage builds use Node 22 Alpine; the backend runs `prisma db push` to sync the schema on startup via its entrypoint script.

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
- `backend`: multi-stage build, runs `prisma db push` to sync the schema on startup, exposes `:3001` internally. Healthcheck hits `/api/health`. Not published to the host by default. Reachable only from the compose network; route `/api` to it from your proxy.
- `frontend`: multi-stage build with Next.js standalone output, published on `${FRONTEND_PORT:-3000}`.

The backend waits for the db health check before starting, and the frontend waits for the backend health check.

The frontend is client-side code: the browser calls the backend directly at `NEXT_PUBLIC_API_URL`, with cookies. `docker-compose.yml` does not publish the backend, so the reverse proxy (Caddy, nginx, Cloudflare Tunnel) that terminates TLS must serve both containers, for example `/api` to `backend:3001` and everything else to `frontend:3000` on the same host. That requires the proxy on the compose network or a published backend port. `NEXT_PUBLIC_API_URL` is then that public origin without a trailing `/api`, and `CORS_ORIGINS` lists the frontend origin. `docker-compose.prod.yml` shows this layout with Traefik labels and is the template to copy; replace its hostnames and the external `traefik` network.

## App secrets

Per-app secrets (e.g. an app's `METRICS_API_TOKEN`) are stored encrypted in the panel's own database, not in the app's untracked `.env` on the VPS. That file is wiped by `git clean -fdx` / re-clone, which is exactly the failure mode this replaces: a required token that lived only in a hand-written `.env` is lost on a clean re-deploy and the app crashloops.

- `PUT /api/servers/:serverId/apps/:name/secrets/:key` with `{ "value": "..." }` sets (or updates) one secret. Write-only: no route ever returns a value once set, only the key name and whether it's set (`GET .../secrets`).
- `PUT /api/servers/:serverId/apps/:name/required-env-keys` with `{ "keys": [...] }` declares which env keys the app requires to run.
- Every **deploy** (panel button, bulk-deploy, `/api/v1/deploy`, and scheduled deploys — all of them funnel through the same `streamDeploy()`) re-applies the app's stored secrets into the relay's `.env` before compose runs (idempotent — a no-op write if nothing changed), then hard-fails the deploy (and `GET .../preflight`) if a declared-required key still resolves empty/unset.
- **Rollback is exempt.** `POST /api/servers/:serverId/apps/:name/rollback` and `POST /api/v1/rollback` do NOT provision secrets or run the required-env gate — a rollback restarts a previously-deployed commit's containers in place, reusing whatever `.env` is already on disk, rather than pulling a new git ref and re-running compose from a possibly-cleaned working tree. If a rollback target predates when a required key was declared, provisioning it is out of scope for this mechanism; re-run a forward deploy to provision and gate.

## Backup and restore

The panel's own database (volume `pgdata`) holds the only state that cannot be rebuilt from the repository: users, GitHub sessions, API key hashes, the registered servers with their relay tokens, apps, deploy history, the audit log, scheduled deploys and the encrypted app secrets. A deploy never backs it up and nothing in the compose files does: **scheduling `scripts/backup.sh` on the host is the operator's job**, and a lost volume without a dump is a lost panel. The commands below are for the production stack in `docker-compose.prod.yml`, run in the checkout on the production host. Both `backup.sh` and `restore.sh` refuse the checkout's `docker-compose.yml` (the development stack), however the path is spelled (relative path, directory symlink, file symlink, hardlink); a separate copy of that file is not recognised.

**Backup.** `scripts/backup.sh` runs `pg_dump -Fc` (custom format, compressed) inside the `db` service through `docker compose exec -T`, so the host needs no Postgres client and the database stays on its private network. The dump goes to a hidden temp file first. Before it is published, `pg_restore` inside the `db` container reads the whole archive (`pg_restore -f /dev/null`): a truncated or corrupt custom-format archive fails that read, which `pg_restore --list` would not notice because it reads only the table of contents. Only then the file is renamed to `deploy-panel-<YYYYMMDD_HHMMSS>.dump` (directory mode 700 when the script creates it, files 600; a second run in the same second gets a `-<pid>` suffix instead of overwriting). A failed run never leaves a truncated `.dump` behind. It refuses to start (exit 2) while the `db` service is not running in the compose file, so a cron job cannot report success for a stack that is down. Exit codes: 0 done, 1 dump failed or invalid, 2 refused (configuration, compose file, a directory inside the checkout, db not running), 3 dump kept but the off-host hook failed.

Schedule it on the production host as the user that runs the deploys (a member of the `docker` group). The log lives under `$HOME`: `/var/log` is not writable for that user, and a cron redirect that cannot open its file means the script never runs at all.

```cron
17 3 * * * cd /path/to/deploy-panel && scripts/backup.sh >> "$HOME/deploy-panel-backup.log" 2>&1
```

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_COMPOSE_FILE` | `docker-compose.prod.yml` in the checkout | Compose file of the stack to back up (the checkout's `docker-compose.yml` is refused) |
| `BACKUP_DB_SERVICE` | `db` | Compose service that runs Postgres |
| `BACKUP_DIR` | `$HOME/deploy-panel-backups` | Where dumps go. Set and non-empty wins; empty counts as unset. A directory inside the checkout is refused (see below) |
| `BACKUP_SKIP_ROTATION` | (unset) | Any value skips the rotation (`restore.sh` sets it for its pre-restore dump) |
| `PG_USER`, `PG_DB` | `deploy_panel`, `deploy_panel` | Role and database name; `docker-compose.prod.yml` fixes both, so only change them for a stack that differs |
| `KEEP_FILES`, `KEEP_DAYS` | `14`, `14` | Keep at most this many dumps, and delete dumps older than this many days (both rules apply; a run that failed rotates nothing) |
| `BACKUP_OFFHOST_HOOK` | (unset) | Executable that copies a finished dump off the host |

**Where dumps live.** Outside the checkout, on purpose: agent-relay refuses to deploy a tree with untracked files, and both Dockerfiles build from the repository root, so a dump in the checkout would block the next deploy and be sent to the Docker daemon with every build. `backup.sh` therefore refuses (exit 2) any `BACKUP_DIR` that lies inside the checkout, after resolving symlinks and `..`. Point `BACKUP_DIR` at a dedicated directory or another disk if you prefer (for example `/var/backups/deploy-panel` created for the cron user).

**What the dump contains, and what it does not.** Everything in the database: users, sessions (stored as SHA-256 hashes), API key hashes, the `servers` table including the relay tokens (stored in plaintext), the audit log and the app secrets. The app secrets are encrypted with `APP_SECRETS_KEY` (AES-256-GCM, key derived from the variable), and that key is **not** in the dump; it lives in the `.env` of the checkout. A dump restored without the original `APP_SECRETS_KEY` loads fine, but the backend cannot decrypt the stored app secrets: reading one fails the authentication check of the cipher, so every deploy that provisions an app secret fails until the secrets are entered again. The failure does not say "wrong key": the deploy ends as an interrupted or failed one whose recovery step reads like `Connection lost during deploy: Unsupported state or unable to authenticate data` (Node's AES-GCM error; `Unsupported or corrupt app-secret ciphertext` means a stored value is malformed instead). Look for those strings in the deploy's steps before suspecting the network. Keep `APP_SECRETS_KEY` (and the rest of `.env`: `PANEL_TOKEN`, `POSTGRES_PASSWORD`) in a password manager or another place that is **not** the same disk and not next to the dumps. Rotating `APP_SECRETS_KEY` is a separate change that this procedure does not cover. Treat every dump as a secret.

**Off-host copy.** Dumps in `$HOME/deploy-panel-backups` live on the same disk as the database, so a lost host loses the restore points too. Set `BACKUP_OFFHOST_HOOK` to the path of an executable; it is called once per successful dump with the dump path as its only argument, for example a script that runs `gpg --encrypt` and `rclone copy`. Encrypt in the hook before the dump leaves the host. The script does not schedule or ship anything itself. A hook that is not an executable file stops the run before dumping (exit 2); a hook that fails makes the run exit 3 with the local dump kept and the rotation skipped.

**Restore.** `scripts/restore.sh --yes [--no-pre-backup] <dump-file>` replaces the content of the production database with a dump. **It is destructive:** the whole `public` schema is dropped and recreated, so everything not in the dump is gone, rows written after it included. Without `--yes` it only says what it would do and exits 2; there is no interactive prompt, so a cron job or a pasted command cannot restore by accident. In order, it:

1. converts the dump to SQL with `pg_restore -f -` inside the `db` container into a private temporary file. A truncated or corrupt archive fails here, before anything is changed, and everything below uses that copy, so a dump that is rotated away meanwhile cannot change what is loaded;
2. stops the `backend` service when it is running (it holds connections and writes rows);
3. takes a dump of the **current** state with `scripts/backup.sh` into `BACKUP_DIR` (rotation skipped, so it can never age out the file you are restoring), unless you pass `--no-pre-backup`. If that backup fails nothing has been changed: the backend is started again and the script exits 3. A nearly empty database is below the size floor of the validation and fails the same way; restore into it with `--no-pre-backup`;
4. sends `BEGIN`, the schema reset, the SQL and a final `COMMIT` to `psql` with `ON_ERROR_STOP=1`. The `COMMIT` is sent only after the whole SQL was read, so an error or a short input rolls back and leaves the old content in place; the backend then stays stopped on purpose, look at the error first;
5. starts the `backend` again and **waits until it is healthy**. `docker compose start` returns as soon as the container is started, long before the entrypoint has applied the schema and the healthcheck has passed, so a backend that crash-loops on the restored data would otherwise look fine. The wait polls the Docker healthcheck of the backend container (`docker inspect`, no minimum compose version) until it reports healthy on two polls in a row, one interval apart, with an unchanged restart count (a backend that crashes again within one poll interval does not count; a crash after that is not seen by the wait, so check `docker compose logs backend` after a restore), reports unhealthy, has exited, or `RESTORE_WAIT_SECONDS` have passed. The script runs no schema tool of its own: the backend brings the database schema in line with the deployed code when it starts, the same way it does after a deploy.

Exit codes: 0 restored, and the backend healthy (a service without a healthcheck gets a warning instead, because only its start can be confirmed) or not started by the script at all because it was not running before or `RESTORE_APP_SERVICE` is empty, 1 invalid dump, backend could not be stopped (nothing changed), psql failed (rolled back, backend left stopped), or the script received SIGTERM, SIGINT or SIGHUP, 2 refused, 3 the pre-restore backup failed (nothing changed), 4 the dump is restored and committed but the backend did not start or did not become healthy in time (it may be stopped or restarting; the message prints the `logs` command to inspect it and the `start` command). Exit 1 after a signal does **not** promise a rollback: bash runs its signal handler only after the running command has finished, so a signal during the `psql` pipeline may arrive after it committed, and the message says the state is unknown; check the database before you start the backend. A signal while the backend is being stopped (up to its stop grace period) or during the pre-restore dump leaves the database unchanged but the backend stopped, and the message prints the `start` command. `RESTORE_APP_SERVICE` names another service to stop and start (empty leaves it alone); `RESTORE_WAIT_SECONDS` (default 120, a whole number; a leading zero is read as decimal) and `RESTORE_WAIT_POLL` (default 2, seconds between two health polls, must be greater than 0) tune the wait; the compose, service and `PG_*` variables are the ones in the table above.

```bash
ls -t "$HOME"/deploy-panel-backups/deploy-panel-*.dump | head -3      # pick a dump
scripts/restore.sh --yes "$HOME/deploy-panel-backups/deploy-panel-20261027_031700.dump"
docker compose -f docker-compose.prod.yml ps                         # backend up again?
curl -sf https://deploy-panel.opentriologue.ai/api/health            # and healthy
```

After a restore from a different `.env` than the one the dump was taken under, check that the app secrets still decrypt. Opening an app's Env view or running its preflight does **not** prove it: they list only the key names and update times, never decrypting a value. Only a deploy that provisions the stored secrets decrypts them, so run a forward deploy of one app that has stored secrets and read its result; if it fails the cipher's authentication check, enter that app's secrets again.

**Restore drill.** A backup that has never been restored is a hope. `scripts/restore-drill.sh [dump-file]` takes the newest `deploy-panel-*.dump` in `BACKUP_DIR` (or the file you give it), starts a throwaway `postgres:16-alpine` container with no published port and a random password, restores the dump into it with `pg_restore`, and compares the row count of every table of the panel (`servers`, `apps`, `app_secrets`, `env_var_changes`, `users`, `sessions`, `api_keys`, `deploys`, `audit_logs`, `scheduled_deploys`) with the number of rows the dump itself holds for it. The expected counts come from the dump, not from the live database, which keeps changing. It removes the container on every exit path, by the id docker reported for it and never by name (so a container that happened to have the same name is safe), and exits 0 only when every table matches (1 on a failed restore or any mismatch, 2 when nothing could be tried, for example no dump). It never touches the production stack. Run it after the first backup and then monthly, for example `23 4 1 * * cd /path/to/deploy-panel && scripts/restore-drill.sh >> "$HOME/deploy-panel-drill.log" 2>&1`. `DRILL_IMAGE` must match the Postgres major version of the compose file. The throwaway container holds a full copy of the data: if a drill is killed with SIGKILL, or `docker rm` fails, it stays behind. Find it with `docker ps -a --filter name=deploy-panel-drill`, check that the pid at the end of the name belongs to a drill that is gone, and remove it with `docker rm -f <container id>`.

The drill proves that the newest dump restores and is complete; it does not prove that your cron job runs, that the off-host copy arrives, or that you hold `APP_SECRETS_KEY`. Check the age of the newest dump now and then.

CI runs `shellcheck` and the stub-`docker` tests of all three scripts (job `backup-scripts`: `scripts/backup.test.sh`, `scripts/restore.test.sh`, `scripts/restore-drill.test.sh`); they need no container.

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
- Database backup scheduled and restore tried: a cron entry for `scripts/backup.sh` is installed, dumps land outside the checkout, an off-host copy exists, `APP_SECRETS_KEY` is stored separately from the dumps, and `scripts/restore-drill.sh` has passed at least once (see [Backup and restore](#backup-and-restore)).
