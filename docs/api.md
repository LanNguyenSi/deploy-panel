# API reference

All endpoints are served by the Hono backend on `PORT` (default `3001`) and prefixed with `/api`. The UI uses the bare `/api/...` paths with cookie-session auth; CI/CD pipelines should use `/api/v1/...` with a `dp_` API key (recommended) or the `PANEL_TOKEN` as a Bearer token.

## Health

| Method | Path          | Description              |
|--------|---------------|--------------------------|
| GET    | `/api/health` | Health check, returns OK |

`/api/health` only proves the Hono process is up. For end-to-end verification (auth + Prisma queries + fleet reachability), run `scripts/smoke-check.sh`.

## Servers

| Method | Path                              | Description                                          |
|--------|-----------------------------------|------------------------------------------------------|
| GET    | `/api/servers`                    | List all servers (includes app count)                |
| GET    | `/api/servers/:id`                | Get a single server with its apps and deploy count   |
| POST   | `/api/servers`                    | Add a new server                                     |
| PATCH  | `/api/servers/:id`                | Update server fields                                 |
| DELETE | `/api/servers/:id`                | Delete server (cascades to apps and deploys)         |
| POST   | `/api/servers/:id/test`           | Test relay connectivity, pings relay `/health`       |
| GET    | `/api/servers/:id/system`         | Get system info (CPU, memory, disk) from relay       |
| POST   | `/api/servers/:serverId/sync`     | Sync apps list from relay to local database          |
| POST   | `/api/servers/install-relay`      | Onboard a new VPS: installs agent-relay over SSH and creates the server row on success. Streams progress as SSE (`progress`, `error`, `done` events); one install at a time per actor (429 otherwise), 409 if the host is already registered |
| POST   | `/api/servers/:id/install-relay`  | Install or reinstall agent-relay on the VPS over SSH (long-running; locks per server and per actor) |

## Apps

All app endpoints are nested under a server: `/api/servers/:serverId/apps`.

| Method | Path                                            | Description                                    |
|--------|-------------------------------------------------|------------------------------------------------|
| GET    | `/api/servers/:serverId/apps`                   | List apps for a server. Each app carries `upstream` (`branch`, `deployedCommit`, `remoteHead`, `checkedAt`, `state`: `current`, `behind` or `unknown`, plus `reason` when unknown), taken from the relay's `GET /api/apps` (one call per listing, 8s budget) and validated by the panel. A relay without the field, an unreachable relay or a verdict that contradicts its commits yields `unknown`, never `current`. `behind` means the deployed commit differs from the remote branch head |
| POST   | `/api/servers/:serverId/apps/:name/deploy`      | Trigger deploy (proxied to agent-relay). Provisions panel-managed secrets into the deploy dir's `.env` first and hard-fails before reaching the relay if a declared-required env key still resolves empty — see docs/configuration.md#app-secrets |
| POST   | `/api/servers/:serverId/apps/:name/rollback`    | Trigger rollback (proxied to agent-relay). **Does not** provision secrets or run the required-env gate — see the "Rollback is exempt" note in docs/configuration.md#app-secrets. A relay 4xx with `phase: "after_reset"` also sets the app `unhealthy`; see the `POST /api/v1/rollback` row |
| GET    | `/api/servers/:serverId/apps/:name/logs`        | Fetch app logs (proxied to agent-relay)         |
| GET    | `/api/servers/:serverId/apps/:name/preflight`   | Run preflight checks (proxied to agent-relay, plus a panel-side required-env-keys check — see below) |
| GET    | `/api/servers/:serverId/apps/:name/secrets`     | List panel-managed secret keys for the app (masked — key name + set/unset only, never the value) |
| PUT    | `/api/servers/:serverId/apps/:name/secrets/:key`| Set (create or update) one secret; body `{ value }`. Write-only — the value is never echoed back |
| DELETE | `/api/servers/:serverId/apps/:name/secrets/:key`| Delete one secret |
| PUT    | `/api/servers/:serverId/apps/:name/required-env-keys` | Declare which env keys the app requires; body `{ keys: string[] }` (replace-all). Drives the preflight/deploy hard-fail gate — see docs/configuration.md#app-secrets |
| PATCH  | `/api/servers/:serverId/apps/:name/tag`         | Set the app tag; body `{ tag }` where tag is `production`, `development`, `ignored` or `null` (clears) |
| PATCH  | `/api/servers/:serverId/apps/:name/live-url`    | Set or clear the app's live URL; body `{ liveUrl }` (http/https URL, empty string or null clears) |
| DELETE | `/api/servers/:serverId/apps/:name`             | Hide the app from the panel (sets tag `ignored`; the row is not deleted). Returns `{ hidden: true }` |
| GET    | `/api/servers/:serverId/apps/:name/deploys/:deployId` | Get one deploy by id, scoped to this server (404 if it belongs to another server); the `:name` segment is not checked |
| POST   | `/api/servers/:serverId/apps/bulk-deploy`       | Deploy several apps in one call; body `{ apps: string[], force?: boolean }` (deduplicated, at most 50 per call) |
| GET    | `/api/servers/:serverId/apps/:name/env`         | Read the app's env entries from the relay; each entry carries a `sensitive` flag derived from the key name |
| PUT    | `/api/servers/:serverId/apps/:name/env`         | Replace the app's env set; body `{ entries: [{ key, value }] }` (max 500 entries). Records one env-history row per changed key (see `/env/history`) plus one `app.env.updated` audit-log entry when anything changed; the response includes `changes` (count of changed keys) and `needsRedeploy` |
| GET    | `/api/servers/:serverId/apps/:name/env/history` | List the latest 100 recorded env-var changes for the app |

## Deploys

| Method | Path           | Description                                                        |
|--------|----------------|--------------------------------------------------------------------|
| GET    | `/api/deploys` | List deploys with optional filters: `serverId`, `appId`, `status`, `limit`, `offset`. Response includes `total` for pagination. |
| GET    | `/api/deploys/:id` | Get one deploy with its app and server summary. Non-admins only see deploys on servers they own (404 otherwise). |

## Audit

| Method | Path          | Description                                                        |
|--------|---------------|--------------------------------------------------------------------|
| GET    | `/api/audit`  | List audit log entries. Supports `limit` and `offset` query params; response includes `total` for pagination. |

## Scheduled deploys

| Method | Path                 | Description                        |
|--------|----------------------|------------------------------------|
| GET    | `/api/scheduled`     | List all scheduled deploy entries  |
| POST   | `/api/scheduled`     | Create a new scheduled deploy      |
| DELETE | `/api/scheduled/:id` | Delete a scheduled deploy          |

## API v1 (CI/CD pipeline integration)

All v1 endpoints are prefixed with `/api/v1` and authenticated with a Bearer credential: either a `dp_` API key (what the bundled GitHub Action uses) or the `PANEL_TOKEN`. They return JSON and are designed for non-interactive callers (GitHub Actions, GitLab pipelines, cron jobs).

| Method | Path                  | Description                                                        |
|--------|-----------------------|--------------------------------------------------------------------|
| GET    | `/api/v1/servers`     | List all servers                                                   |
| GET    | `/api/v1/apps`        | List all apps (optionally filtered by `server_id`, which accepts a server name or id). `server_id` set to a server you don't own, or that doesn't resolve, answers 404 rather than an empty list |
| POST   | `/api/v1/deploy`      | Trigger a deploy for a given app                                   |
| GET    | `/api/v1/deploy/:id`  | Get status of a specific deploy                                    |
| GET    | `/api/v1/deploys`     | List deploys with `offset` / `total` pagination, optionally filtered by `server_id` (accepts a server name or id), `app_id`, `status`. `server_id` set to a server you don't own, or that doesn't resolve, answers 404 rather than an empty list. `app_id` is an app id only (app names are unique per server, not globally) |
| POST   | `/api/v1/rollback`    | Trigger a rollback for a given app. Answers `202` with `deploy.status: "running"` and finishes asynchronously: poll `GET /api/v1/deploy/:id` until `status` leaves `running` (`rolled_back`, `failed`, or `success`/`failed` when the 5xx recovery path finalized the row). App status: blocked by preflight or a relay-reported `success: false` sets `unhealthy`; a relay-reported success sets `healthy` only after the post-deploy health gate passes, `unhealthy` otherwise (the app status can lag the polled row by the length of the gate). A relay 4xx marks the row `failed`; the relay tags its rollback error with a `phase`, and an `after_reset` 4xx (the relay attempted `git reset --hard`, e.g. `Rebuild failed` or a reset that failed part-way) sets the app `unhealthy`, while a `before_reset` 4xx (bad ref, unknown app; HEAD did not move) or an untagged one from an older relay leaves the app status untouched |
| GET    | `/api/v1/logs`        | Fetch logs for a given app                                         |
| POST   | `/api/v1/preflight`   | Run preflight checks for a given app                               |

Example: trigger a deploy from a CI job.

```bash
curl -X POST https://panel.example.com/api/v1/deploy \
  -H "Authorization: Bearer $PANEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"server": "srv_abc", "app": "web-prod"}'
```

The response includes a deploy id you can poll via `GET /api/v1/deploy/:id` to wait for `success` / `failed` / `rolled_back` / `interrupted` (the relay connection was lost and the panel could not prove the deploy reached its target).

## Other endpoints

The backend also exposes endpoints that the panel UI itself uses. They are not part of the stable CI/CD (`/api/v1`) surface and may change:

- `/api/auth/*`: email/password login, GitHub OAuth (`/github/config`, `/github/start`, `/github/callback`), the identity-broker registration endpoint (`POST /api/auth/register-from-project-pilot`), and `/api/auth/check`. See [configuration.md#authentication](configuration.md#authentication).
- `/api/api-keys`: create, list, and revoke `dp_` API keys (panel-session auth only; rejects API-key auth).
- `/api/servers/probe-vps` and `/api/servers/:id/update-relay-image`: VPS provisioning helpers used by the server-management UI.
